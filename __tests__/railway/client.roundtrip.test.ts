/* eslint-disable @typescript-eslint/no-explicit-any */
import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';

import { createRailwayClient } from '../../src/railway/client';
import { RAILWAY_API_URL, UPDATE_IMAGE_MUTATION } from '../../src/railway/mutations';

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

describe('createRailwayClient — AbortController timeout', () => {
  it('rejects with an abort-flavored error when the server stalls past requestTimeoutMs', async () => {
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
    ).rejects.toBeDefined();
    const elapsed = Date.now() - started;

    // Should have aborted quickly — definitely within 5s, nowhere near 30s.
    expect(elapsed).toBeLessThan(5_000);
  }, 10_000);
});
