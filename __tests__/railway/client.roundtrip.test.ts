import * as core from '@actions/core';
import { ClientError } from 'graphql-request';
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';

import { createRailwayClient } from '../../src/railway/client';
import { RAILWAY_API_URL, UPDATE_IMAGE_MUTATION } from '../../src/railway/mutations';
import { withRetry } from '../../src/railway/retry';
import { mapToActionError } from '../../src/railway/errors';
import { expectNoWorkflowCommands, hasWorkflowCommand } from '../fixtures/log-assert';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

interface CapturedRequest {
  body: any;
  headers: Record<string, string>;
}

const captured: { last: CapturedRequest | null } = { last: null };

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  captured.last = null;
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});

function capturingHandler(responseBody: unknown = { data: { serviceInstanceUpdate: null } }) {
  return http.post(RAILWAY_API_URL, async ({ request }) => {
    const body = await request.json();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    captured.last = { body, headers };
    return HttpResponse.json(responseBody);
  });
}

describe('createRailwayClient — wire body shape', () => {
  it('POST body matches { query: UPDATE_IMAGE_MUTATION, variables }', async () => {
    server.use(capturingHandler());

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const vars = {
      sid: 'svc',
      eid: 'env',
      input: { source: { image: 'registry/repo:tag' } },
    };
    await client.request(UPDATE_IMAGE_MUTATION, vars);

    expect(captured.last).not.toBeNull();
    expect(captured.last!.body.query).toBe(UPDATE_IMAGE_MUTATION);
    expect(captured.last!.body.variables).toEqual(vars);
  });
});

describe('createRailwayClient — auth headers', () => {
  it('tokenType=bearer sets Authorization: Bearer <token>', async () => {
    server.use(capturingHandler());

    const client = createRailwayClient({
      token: 'my-bearer-token',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    await client.request(UPDATE_IMAGE_MUTATION, { sid: 's', eid: 'e' });

    expect(captured.last!.headers['authorization']).toBe('Bearer my-bearer-token');
    expect(captured.last!.headers['project-access-token']).toBeUndefined();
  });

  it('tokenType=project sets Project-Access-Token (no Authorization)', async () => {
    server.use(capturingHandler());

    const client = createRailwayClient({
      token: 'project-token-xyz',
      tokenType: 'project',
      requestTimeoutMs: 5_000,
    });
    await client.request(UPDATE_IMAGE_MUTATION, { sid: 's', eid: 'e' });

    expect(captured.last!.headers['project-access-token']).toBe('project-token-xyz');
    expect(captured.last!.headers['authorization']).toBeUndefined();
  });
});

describe('createRailwayClient — credentials round-trip', () => {
  it('preserves special characters in registryCredentials exactly', async () => {
    server.use(capturingHandler());

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const creds = {
      username: 'user@example.com',
      password: 'my"complex$pa$$word!\\\\',
    };
    const vars = {
      sid: 'svc',
      eid: 'env',
      input: {
        source: { image: 'registry/repo:tag' },
        registryCredentials: creds,
      },
    };
    await client.request(UPDATE_IMAGE_MUTATION, vars);

    expect(captured.last!.body.variables.input.registryCredentials).toEqual(creds);
    expect(captured.last!.body.variables.input.registryCredentials.password).toBe(
      'my"complex$pa$$word!\\\\',
    );
  });
});

/**
 * Security invariant: graphql-request's ClientError bakes the full request
 * (incl. `variables.input.registryCredentials.password`) into `message` and
 * `stack`. The client wrapper must redact it before anything can log it.
 */
describe('createRailwayClient — ClientError redaction', () => {
  const SECRET_PASSWORD = 'pa"ss\\word-SECRET';
  const secretVars = {
    sid: 'svc',
    eid: 'env',
    input: {
      source: { image: 'registry/repo:tag' },
      registryCredentials: { username: 'user', password: SECRET_PASSWORD },
    },
  };
  const FAST_POLICY = { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 1, factor: 1, randomize: false };

  function makeClient() {
    return createRailwayClient({ token: 'tok', tokenType: 'bearer', requestTimeoutMs: 5_000 });
  }

  function expectNoSecret(err: unknown): void {
    const e = err as ClientError;
    for (const text of [e.message, e.stack ?? '', String(e), JSON.stringify(e)]) {
      expect(text).not.toContain('SECRET');
      expect(text).not.toContain('registryCredentials');
    }
    expect((e.request as any).variables).toBeUndefined();
  }

  it('HTTP 503: redacts message, stack and request.variables; keeps ClientError + status', async () => {
    server.use(http.post(RAILWAY_API_URL, () => new HttpResponse(null, { status: 503 })));

    const err = await makeClient()
      .request(UPDATE_IMAGE_MUTATION, secretVars)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).response.status).toBe(503);
    expect((err as ClientError).message).toBe('GraphQL Error (Code: 503)');
    expect((err as ClientError).request.query).toBe(UPDATE_IMAGE_MUTATION);
    expectNoSecret(err);
  });

  it('200 with errors[]: message is the first GraphQL error; secret absent', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: null, errors: [{ message: 'Service not found' }] }),
      ),
    );

    const err = await makeClient()
      .request(UPDATE_IMAGE_MUTATION, secretVars)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(ClientError);
    expect((err as ClientError).message).toBe('Service not found');
    expect((err as ClientError).response.errors?.[0]?.message).toBe('Service not found');
    expectNoSecret(err);
  });

  it('withRetry over 503, 503, 200 resolves and never logs the secret', async () => {
    vi.mocked(core.info).mockClear();
    let calls = 0;
    server.use(
      http.post(RAILWAY_API_URL, () => {
        calls += 1;
        if (calls <= 2) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({ data: { serviceInstanceUpdate: null } });
      }),
    );

    const client = makeClient();
    await expect(
      withRetry(() => client.request(UPDATE_IMAGE_MUTATION, secretVars), FAST_POLICY),
    ).resolves.toEqual({ serviceInstanceUpdate: null });

    expect(calls).toBe(3);
    const logged = vi.mocked(core.info).mock.calls.map((c) => String(c[0]));
    expect(logged).toHaveLength(2);
    for (const line of logged) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain('variables');
      expect(line).toContain('GraphQL Error (Code: 503)');
    }
  });
});

describe('createRailwayClient — Railway-echoed secrets and commands (chokepoint A)', () => {
  const PASSWORD = 'pa"ss\\word-SECRET';
  const TOKEN = 'tok-SECRET2';
  const ECHO =
    'Variable "$input" got invalid value { registryCredentials: { password: "pa\\"ss\\\\word-SECRET" } }\n::add-mask::X';
  const vars = {
    sid: 'svc',
    eid: 'env',
    input: {
      source: { image: 'registry/repo:tag' },
      registryCredentials: { username: 'user', password: PASSWORD },
    },
  };
  const FAST_POLICY = { retries: 2, minTimeoutMs: 1, maxTimeoutMs: 1, factor: 1, randomize: false };

  function makeClient() {
    return createRailwayClient({ token: TOKEN, tokenType: 'bearer', requestTimeoutMs: 5_000 });
  }

  it('the fake echoes the JSON-escaped password verbatim (guards the test itself)', () => {
    expect(ECHO).toContain(JSON.stringify(PASSWORD).slice(1, -1));
  });

  it('200 errors[] echoing a secret: message, errors[0].message and mapped details are scrubbed', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: null, errors: [{ message: ECHO }, { message: `t=${TOKEN}` }] }),
      ),
    );
    const err = (await makeClient()
      .request(UPDATE_IMAGE_MUTATION, vars)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      )) as ClientError;

    expect(err).toBeInstanceOf(ClientError);
    const mapped = mapToActionError(err, 'updateImage');
    const texts = [
      err.message,
      err.stack ?? '',
      err.response.errors?.[0]?.message ?? '',
      err.response.errors?.[1]?.message ?? '',
      mapped.message,
      mapped.details ?? '',
    ];
    for (const text of texts) {
      expect(text).not.toContain('SECRET');
      expect(hasWorkflowCommand(text)).toBe(false);
    }
    expect(err.response.errors?.[0]?.message).toContain('***');
  });

  it('a secret split by CR in the echo cannot be reassembled after CR stripping', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: null, errors: [{ message: 'bad token tok-SEC\rRET2 given' }] }),
      ),
    );
    const err = (await makeClient()
      .request(UPDATE_IMAGE_MUTATION, vars)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      )) as ClientError;
    expect(err).toBeInstanceOf(ClientError);
    for (const text of [err.message, err.stack ?? '', err.response.errors?.[0]?.message ?? '']) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('SECRET2');
    }
  });

  it('a single 503 attempt with a JSON errors[] body carries the dangerous text into the error', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ errors: [{ message: ECHO }] }, { status: 503 }),
      ),
    );
    const err = (await makeClient()
      .request(UPDATE_IMAGE_MUTATION, vars)
      .then(
        () => {
          throw new Error('expected rejection');
        },
        (e: unknown) => e,
      )) as ClientError;
    expect(err).toBeInstanceOf(ClientError);
    expect(err.response.status).toBe(503);
    // The fake really delivered Railway text (not the constant 'GraphQL Error (Code: 503)').
    expect(err.response.errors?.[0]?.message).toContain('Variable "$input"');
  });

  it('withRetry over a 503 echoing a secret then 200: retry log has no secret and no command', async () => {
    vi.mocked(core.info).mockClear();
    let calls = 0;
    server.use(
      http.post(RAILWAY_API_URL, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ errors: [{ message: ECHO }] }, { status: 503 });
        return HttpResponse.json({ data: { serviceInstanceUpdate: null } });
      }),
    );
    const client = makeClient();
    await expect(
      withRetry(() => client.request(UPDATE_IMAGE_MUTATION, vars), FAST_POLICY),
    ).resolves.toEqual({ serviceInstanceUpdate: null });

    expect(calls).toBe(2);
    const logged = vi.mocked(core.info).mock.calls.flat();
    expect(logged).toHaveLength(1);
    for (const line of logged) expect(String(line)).not.toContain('SECRET');
    expectNoWorkflowCommands(logged);
  });
});

describe('createRailwayClient — AbortController timeout', () => {
  it('rejects with a REQUEST_TIMEOUT-coded error when the server stalls past requestTimeoutMs', async () => {
    server.use(
      http.post(RAILWAY_API_URL, async () => {
        // Far longer than the configured client timeout; the client aborts first.
        await delay(35_000);
        return HttpResponse.json({ data: { serviceInstanceUpdate: null } });
      }),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 50, // 50ms — well below msw delay
    });

    const started = Date.now();
    await expect(
      client.request(UPDATE_IMAGE_MUTATION, { sid: 's', eid: 'e' }),
    ).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    const elapsed = Date.now() - started;

    // Should have aborted quickly — definitely within 5s, nowhere near 30s.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});

/**
 * Full-stack roundtrip: real graphql-request client → msw → real Railway
 * response shapes (captured from production). These tests catch the class
 * of bug that hit us twice on a real staging deploy: the FakeRailwayClient mocked
 * what we ASSUMED Railway returns; only msw + real graphql-request exercises
 * the actual envelope-unwrapping + response-shape contract.
 *
 * Fixture shapes are pinned here as canonical wire formats. Anything that
 * Railway has actually returned to us in production goes in this file.
 */
describe('operations roundtrip — real graphql-request + msw', () => {
  // We import the operations dynamically inside each test so the module
  // gets the same client.ts/graphql-request that msw is intercepting.

  it('updateImage succeeds on the full Railway wire shape ({data: {serviceInstanceUpdate: null}})', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: { serviceInstanceUpdate: null } }),
      ),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { updateImage } = await import('../../src/railway/operations');

    await expect(
      updateImage(client, {
        serviceId: 'svc-uuid',
        environmentId: 'env-uuid',
        image: 'registry/repo:tag',
      }),
    ).resolves.toBeUndefined();
  });

  it('redeploy returns deployment-id string for {data: {serviceInstanceDeploy: "abc123"}}', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: { serviceInstanceDeploy: 'abc123' } }),
      ),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { redeploy } = await import('../../src/railway/operations');

    const result = await redeploy(client, {
      serviceId: 'svc-uuid',
      environmentId: 'env-uuid',
      serviceLabel: 'web',
    });
    expect(result).toMatchObject({ deploymentId: 'abc123' });
  });

  it('redeploy returns null for {data: {serviceInstanceDeploy: true}} — Railway "deploy accepted" boolean (caught in production at SHA d3e49af5)', async () => {
    // Real Railway response captured from a staging deploy.
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: { serviceInstanceDeploy: true } }),
      ),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { redeploy } = await import('../../src/railway/operations');

    const result = await redeploy(client, {
      serviceId: 'svc-uuid',
      environmentId: 'env-uuid',
      serviceLabel: 'web',
    });
    expect(result).toMatchObject({ deploymentId: null });
  });

  it('redeploy returns null for {data: {serviceInstanceDeploy: null}}', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({ data: { serviceInstanceDeploy: null } }),
      ),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { redeploy } = await import('../../src/railway/operations');

    const result = await redeploy(client, {
      serviceId: 'svc-uuid',
      environmentId: 'env-uuid',
      serviceLabel: 'web',
    });
    expect(result).toMatchObject({ deploymentId: null });
  });

  it('updateImage throws ActionError on real GraphQL errors response ({data: null, errors: [...]})', async () => {
    server.use(
      http.post(RAILWAY_API_URL, () =>
        HttpResponse.json({
          data: null,
          errors: [{ message: 'Service not found' }],
        }),
      ),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { updateImage } = await import('../../src/railway/operations');
    const { ActionError } = await import('../../src/errors');

    try {
      await updateImage(client, {
        serviceId: 'svc-uuid',
        environmentId: 'env-uuid',
        image: 'registry/repo:tag',
      });
      throw new Error('updateImage should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as Error).message).toContain('Railway GraphQL error');
    }
  });

  it('redeploy throws ActionError on HTTP 401', async () => {
    server.use(http.post(RAILWAY_API_URL, () => new HttpResponse(null, { status: 401 })));

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { redeploy } = await import('../../src/railway/operations');
    const { ActionError } = await import('../../src/errors');

    try {
      await redeploy(client, {
        serviceId: 'svc-uuid',
        environmentId: 'env-uuid',
        serviceLabel: 'web',
      });
      throw new Error('redeploy should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as Error).message.toLowerCase()).toContain('authentication failed');
    }
  });

  it('waitForDeployment polls deployment(id) and resolves on SUCCESS', async () => {
    // Two responses: first BUILDING, then SUCCESS. Confirms the polling wire
    // shape (`{data: {deployment: {id, status, createdAt}}}`) is what
    // operations.ts's parseDeploymentSnapshot expects after graphql-request
    // unwraps the envelope.
    let call = 0;
    server.use(
      http.post(RAILWAY_API_URL, () => {
        call += 1;
        const status = call === 1 ? 'BUILDING' : 'SUCCESS';
        return HttpResponse.json({
          data: {
            deployment: { id: 'real-d1', status, createdAt: '2026-01-01T00:00:00Z' },
          },
        });
      }),
    );

    const client = createRailwayClient({
      token: 'tok',
      tokenType: 'bearer',
      requestTimeoutMs: 5_000,
    });
    const { waitForDeployment } = await import('../../src/railway/operations');

    const snap = await waitForDeployment(client, 'real-d1', {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      onPoll: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(snap.status).toBe('SUCCESS');
    expect(call).toBe(2);
  });
});
