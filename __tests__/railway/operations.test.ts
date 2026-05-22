/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientError } from 'graphql-request';

import { ActionError } from '../../src/errors';
import {
  getDeploymentStatus,
  getLatestDeploymentForService,
  redeploy,
  updateImage,
  waitForDeployment,
} from '../../src/railway/operations';
import { FakeRailwayClient } from '../fixtures/fake-client';

// Silence retry's `core.info` retry-attempt log.
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

const SERVICE_ID = '550e8400-e29b-41d4-a716-446655440001';
const ENV_ID = '550e8400-e29b-41d4-a716-446655440000';

function makeClientError(status: number): ClientError {
  return new ClientError(
    {
      status,
      headers: new Headers(),
      body: '',
      errors: [],
    } as any,
    { query: '' } as any,
  );
}

describe('updateImage — happy path', () => {
  it('sends variables.input.registryCredentials when credentials provided', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', {
      response: { serviceInstanceUpdate: null },
    });

    await updateImage(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      image: 'registry/repo:tag',
      registryCredentials: { username: 'u', password: 'p' },
    });

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0]!;
    expect(call.operationName).toBe('updateImage');
    const vars = call.variables as any;
    expect(vars.sid).toBe(SERVICE_ID);
    expect(vars.eid).toBe(ENV_ID);
    expect(vars.input.source).toEqual({ image: 'registry/repo:tag' });
    expect(vars.input.registryCredentials).toEqual({ username: 'u', password: 'p' });
  });

  it('omits registryCredentials when not provided (input is source-only)', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', {
      response: { serviceInstanceUpdate: null },
    });

    await updateImage(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      image: 'registry/repo:tag',
    });

    const vars = client.calls[0]!.variables as any;
    expect(vars.input).toEqual({ source: { image: 'registry/repo:tag' } });
    expect('registryCredentials' in vars.input).toBe(false);
  });
});

describe('updateImage — error paths', () => {
  it('throws ActionError (not raw ClientError) on 401', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', { error: makeClientError(401) });

    await expect(
      updateImage(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        image: 'registry/repo:tag',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('routes ClientError 401 through mapToActionError → "authentication failed"', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', { error: makeClientError(401) });

    try {
      await updateImage(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        image: 'registry/repo:tag',
      });
      throw new Error('expected updateImage to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ActionError);
      expect((e as ActionError).message.toLowerCase()).toContain('authentication failed');
    }
  });

  it('does NOT throw on unexpected response shapes — HTTP 200 + no GraphQL errors is sufficient confirmation', async () => {
    // We deliberately don't validate the update response. graphql-request@7
    // would have thrown if Railway returned `errors[]` or a non-2xx status;
    // anything that gets through is treated as success. Two prior production
    // bugs (data-envelope, boolean serviceInstanceDeploy) came from being
    // too strict here.
    const client = new FakeRailwayClient();
    client.setResponse('updateImage', { response: { somethingElse: true } });

    await expect(
      updateImage(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        image: 'registry/repo:tag',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('redeploy — happy path', () => {
  it('returns { deploymentId: "abc123" } when API returns that id', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: 'abc123' },
    });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toMatchObject({ deploymentId: 'abc123' });
  });

  it('returns { deploymentId: null } when API returns the boolean `true`', async () => {
    // Railway sometimes returns `serviceInstanceDeploy: true` instead of an id
    // string (deploy accepted but no id surfaced). v0 bash handled this via
    // `[[ "$deploy_id" != "true" ]]`. v1 normalizes boolean → null here so the
    // caller's "unavailable" warning fires. Caught by a failed London staging
    // deploy at SHA d3e49af5; without this normalization the zod schema
    // rejected the response and the whole deploy failed.
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: true },
    });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toMatchObject({ deploymentId: null });
  });

  it('returns { deploymentId: null } when API returns null', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: null },
    });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toMatchObject({ deploymentId: null });
  });

  it('passes operationName=deployService to the client', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', {
      response: { serviceInstanceDeploy: 'd' },
    });
    await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(client.calls[0]!.operationName).toBe('deployService');
    expect(client.calls[0]!.variables).toEqual({ sid: SERVICE_ID, eid: ENV_ID });
  });
});

describe('redeploy — error paths', () => {
  it('throws ActionError on 401', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { error: makeClientError(401) });

    await expect(
      redeploy(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        serviceLabel: 'api',
      }),
    ).rejects.toBeInstanceOf(ActionError);
  });

  it('returns { deploymentId: null } on unexpected response shapes (defensive — Railway already accepted the deploy)', async () => {
    // We don't throw on shape mismatch — the deploy already succeeded
    // server-side. Returning null surfaces the existing "unavailable" warning
    // path. Three real shapes verified by production: string, null, true.
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { response: { data: {} } });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toMatchObject({ deploymentId: null });
  });

  it('returns { deploymentId: null } when serviceInstanceDeploy is an empty string', async () => {
    // Edge case: empty string would technically pass `typeof === "string"`,
    // but is useless. Treat as no-id.
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { response: { serviceInstanceDeploy: '' } });

    const result = await redeploy(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
      serviceLabel: 'api',
    });
    expect(result).toMatchObject({ deploymentId: null });
  });

  it('includes serviceLabel in the operation context when erroring', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deployService', { error: makeClientError(404) });

    try {
      await redeploy(client, {
        serviceId: SERVICE_ID,
        environmentId: ENV_ID,
        serviceLabel: 'my-label',
      });
      throw new Error('expected to throw');
    } catch (e) {
      // mapToActionError uses status mapping for 404 — message says "not found".
      expect(e).toBeInstanceOf(ActionError);
      expect((e as ActionError).message.toLowerCase()).toContain('not found');
    }
  });
});

describe('getDeploymentStatus', () => {
  it('returns parsed snapshot from a Railway-shaped response', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('deploymentStatus', {
      response: {
        deployment: { id: 'd1', status: 'BUILDING', createdAt: '2026-01-01T00:00:00Z' },
      },
    });
    const snapshot = await getDeploymentStatus(client, 'd1');
    expect(snapshot).toEqual({ id: 'd1', status: 'BUILDING', createdAt: '2026-01-01T00:00:00Z' });
  });
});

describe('getLatestDeploymentForService — V2 no-id fallback', () => {
  it('returns the latest deployment when the service has one', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('serviceInstanceLatestDeployment', {
      response: {
        serviceInstance: {
          latestDeployment: {
            id: 'd-latest',
            status: 'BUILDING',
            createdAt: '2026-01-01T00:00:00Z',
          },
        },
      },
    });
    const result = await getLatestDeploymentForService(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
    });
    expect(result).toEqual({
      id: 'd-latest',
      status: 'BUILDING',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('returns null when serviceInstance is null (service not found)', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('serviceInstanceLatestDeployment', { response: { serviceInstance: null } });
    const result = await getLatestDeploymentForService(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
    });
    expect(result).toBeNull();
  });

  it('returns null when there is no latest deployment yet', async () => {
    const client = new FakeRailwayClient();
    client.setResponse('serviceInstanceLatestDeployment', {
      response: { serviceInstance: { latestDeployment: null } },
    });
    const result = await getLatestDeploymentForService(client, {
      serviceId: SERVICE_ID,
      environmentId: ENV_ID,
    });
    expect(result).toBeNull();
  });
});

describe('waitForDeployment', () => {
  /** Helper: client that returns the given status sequence on successive calls. */
  function statusSequenceClient(
    statuses: Array<'BUILDING' | 'DEPLOYING' | 'SUCCESS' | 'FAILED' | 'CRASHED' | 'QUEUED'>,
  ): FakeRailwayClient {
    const client = new FakeRailwayClient();
    let i = 0;
    const origRequest = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      document: string,
      variables: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') {
        const status = statuses[Math.min(i, statuses.length - 1)] ?? 'SUCCESS';
        i += 1;
        return {
          deployment: { id: 'd1', status, createdAt: '2026-01-01T00:00:00Z' },
        } as TResult;
      }
      if (opts?.operationName === 'buildLogs') {
        return { buildLogs: [] } as TResult;
      }
      return origRequest<TVars, TResult>(document, variables, opts);
    };
    return client;
  }

  it('resolves with the SUCCESS snapshot when status is SUCCESS on first poll', async () => {
    const client = statusSequenceClient(['SUCCESS']);
    const snap = await waitForDeployment(client, 'd1', {
      timeoutMs: 1000,
      pollIntervalMs: 1,
      onPoll: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(snap.status).toBe('SUCCESS');
  });

  it('polls through non-terminal statuses until SUCCESS', async () => {
    const client = statusSequenceClient(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS']);
    const snap = await waitForDeployment(client, 'd1', {
      timeoutMs: 10_000,
      pollIntervalMs: 1,
      onPoll: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(snap.status).toBe('SUCCESS');
  });

  it('throws ActionError on FAILED with status in message', async () => {
    const client = statusSequenceClient(['BUILDING', 'FAILED']);
    try {
      await waitForDeployment(client, 'd1', {
        timeoutMs: 10_000,
        pollIntervalMs: 1,
        onPoll: () => undefined,
        sleep: () => Promise.resolve(),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toContain('FAILED');
    }
  });

  it('throws ActionError on CRASHED', async () => {
    const client = statusSequenceClient(['DEPLOYING', 'CRASHED']);
    try {
      await waitForDeployment(client, 'd1', {
        timeoutMs: 10_000,
        pollIntervalMs: 1,
        onPoll: () => undefined,
        sleep: () => Promise.resolve(),
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toContain('CRASHED');
    }
  });

  it('throws ActionError on timeout — never reaches a terminal state', async () => {
    // Stuck BUILDING; injected clock advances past timeout instantly.
    const client = statusSequenceClient(['BUILDING', 'BUILDING', 'BUILDING']);
    let nowValue = 0;
    try {
      await waitForDeployment(client, 'd1', {
        timeoutMs: 1000,
        pollIntervalMs: 1,
        onPoll: () => undefined,
        sleep: () => Promise.resolve(),
        now: () => {
          const v = nowValue;
          nowValue += 600; // jump 600ms per call — 2 polls + ≥1 elapsed check > 1000ms
          return v;
        },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toContain('did not reach SUCCESS');
    }
  });

  it('throws when AbortSignal aborts before the first poll', async () => {
    const client = statusSequenceClient(['BUILDING', 'SUCCESS']);
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForDeployment(client, 'd1', {
        timeoutMs: 10_000,
        pollIntervalMs: 1,
        onPoll: () => undefined,
        sleep: () => Promise.resolve(),
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  it('AbortSignal cancels the sleep between polls', async () => {
    const client = statusSequenceClient(['BUILDING', 'BUILDING', 'SUCCESS']);
    const controller = new AbortController();
    let sleepCalls = 0;
    // Real-ish sleep: respects abort. Abort fires after the first sleep starts.
    const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
      new Promise((resolve, reject) => {
        sleepCalls += 1;
        if (sleepCalls === 1) {
          // Abort during the first sleep.
          queueMicrotask(() => controller.abort());
        }
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });

    await expect(
      waitForDeployment(client, 'd1', {
        timeoutMs: 10_000,
        pollIntervalMs: 10_000, // long — would hang without abort plumbing
        onPoll: () => undefined,
        sleep,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });
});

describe('parseDeploymentSnapshot — error paths', () => {
  it('throws ActionError when raw is not an object (covers null/string defense)', async () => {
    const { getDeploymentStatus } = await import('../../src/railway/operations');
    const client = new FakeRailwayClient();
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      doc: string,
      vars: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') return 'not-an-object' as TResult;
      return orig<TVars, TResult>(doc, vars, opts);
    };
    await expect(getDeploymentStatus(client, 'd1')).rejects.toThrow(/Railway returned no/);
  });

  it('throws ActionError when deployment object is missing required fields', async () => {
    const { getDeploymentStatus } = await import('../../src/railway/operations');
    const client = new FakeRailwayClient();
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      doc: string,
      vars: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') {
        return { deployment: { createdAt: '2026-01-01' } } as TResult; // no id or status
      }
      return orig<TVars, TResult>(doc, vars, opts);
    };
    await expect(getDeploymentStatus(client, 'd1')).rejects.toThrow(/missing required fields/);
  });

  it('sanitizes `::` in the JSON snippet embedded in parse error details', async () => {
    const { getDeploymentStatus } = await import('../../src/railway/operations');
    const client = new FakeRailwayClient();
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      doc: string,
      vars: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') {
        // No `deployment` field → first error branch. The whole raw object is
        // embedded in details via JSON.stringify; a `::` in a string value
        // would otherwise inject a workflow command if the error is logged.
        return { somethingElse: '::add-mask::SECRET' } as TResult;
      }
      return orig<TVars, TResult>(doc, vars, opts);
    };
    try {
      await getDeploymentStatus(client, 'd1');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).details).not.toContain('::add-mask::');
      expect((err as ActionError).details).toContain('∶∶add-mask∶∶');
    }
  });
});

describe('waitForDeployment — real defaultSleep path', () => {
  // Exercises the default (non-injected) sleep so coverage reaches the
  // abort-aware setTimeout/clearTimeout branches.
  function statusSeqRealSleep(statuses: Array<'BUILDING' | 'SUCCESS'>): FakeRailwayClient {
    const client = new FakeRailwayClient();
    let i = 0;
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      doc: string,
      vars: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') {
        const s = statuses[Math.min(i, statuses.length - 1)] ?? 'SUCCESS';
        i += 1;
        return {
          deployment: { id: 'd1', status: s, createdAt: '2026-01-01T00:00:00Z' },
        } as TResult;
      }
      return orig<TVars, TResult>(doc, vars, opts);
    };
    return client;
  }

  it('resolves via real setTimeout-backed sleep when polling once between BUILDING and SUCCESS', async () => {
    const { waitForDeployment } = await import('../../src/railway/operations');
    const client = statusSeqRealSleep(['BUILDING', 'SUCCESS']);
    const snap = await waitForDeployment(client, 'd1', {
      timeoutMs: 5_000,
      pollIntervalMs: 1, // 1ms — real setTimeout fires immediately
      onPoll: () => undefined,
      // NO sleep injection — exercises defaultSleep happy path
    });
    expect(snap.status).toBe('SUCCESS');
  });

  it('real defaultSleep rejects when AbortSignal is already aborted before sleep starts', async () => {
    const { waitForDeployment } = await import('../../src/railway/operations');
    const client = statusSeqRealSleep(['BUILDING', 'BUILDING', 'SUCCESS']);
    const controller = new AbortController();
    // Abort just after the first poll returns BUILDING, before the first sleep starts.
    const onPoll = (): void => controller.abort();
    await expect(
      waitForDeployment(client, 'd1', {
        timeoutMs: 5_000,
        pollIntervalMs: 1,
        onPoll, // aborts in-flight
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  });

  it('real defaultSleep cancels via abort event mid-sleep', async () => {
    const { waitForDeployment } = await import('../../src/railway/operations');
    const client = statusSeqRealSleep(['BUILDING', 'BUILDING', 'SUCCESS']);
    const controller = new AbortController();
    let polls = 0;
    const onPoll = (): void => {
      polls += 1;
      if (polls === 1) {
        // First sleep is 10s — abort after a microtask so the listener has
        // registered. Without abort plumbing, this would hang the test.
        setTimeout(() => controller.abort(), 10);
      }
    };
    await expect(
      waitForDeployment(client, 'd1', {
        timeoutMs: 60_000,
        pollIntervalMs: 10_000, // long enough that timeout won't fire first
        onPoll,
        signal: controller.signal,
      }),
    ).rejects.toBeDefined();
  }, 5_000);
});

describe('getBuildLogs — sanitization + length cap', () => {
  function buildLogsClient(
    entries: Array<{ message?: unknown; timestamp?: unknown; severity?: unknown }>,
  ): FakeRailwayClient {
    const client = new FakeRailwayClient();
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      document: string,
      variables: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'buildLogs') {
        return { buildLogs: entries } as TResult;
      }
      return orig<TVars, TResult>(document, variables, opts);
    };
    return client;
  }

  it('sanitizes `::` workflow-command markers within each log message', async () => {
    const { getBuildLogs } = await import('../../src/railway/operations');
    const client = buildLogsClient([
      { timestamp: '2026-01-01T00:00:00Z', severity: 'INFO', message: '::add-mask::SECRET' },
      { timestamp: '2026-01-01T00:00:01Z', severity: 'INFO', message: 'normal line' },
    ]);
    const out = await getBuildLogs(client, 'd1');
    expect(out).not.toContain('::add-mask::');
    expect(out).toContain('∶∶add-mask∶∶');
    expect(out).toContain('normal line');
  });

  it('strips CR from log messages (workflow-command continuation defense)', async () => {
    const { getBuildLogs } = await import('../../src/railway/operations');
    const client = buildLogsClient([
      { timestamp: 't', severity: 's', message: 'line-with-cr\rsmuggled' },
    ]);
    const out = await getBuildLogs(client, 'd1');
    expect(out).not.toContain('\r');
  });

  it('truncates output exceeding the 16 KB cap with a clear marker', async () => {
    const { getBuildLogs } = await import('../../src/railway/operations');
    const bigMessage = 'x'.repeat(500);
    // 50 entries × ~530 bytes each = ~26 KB → exceeds the 16 KB cap.
    const entries = Array.from({ length: 50 }, (_, i) => ({
      timestamp: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
      severity: 'INFO',
      message: bigMessage,
    }));
    const client = buildLogsClient(entries);
    const out = await getBuildLogs(client, 'd1');
    expect(out.length).toBeLessThan(17 * 1024);
    expect(out).toContain('[truncated');
  });
});
