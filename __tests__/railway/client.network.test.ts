/**
 * Real-socket transport tests (story 4). No msw here: msw intercepts fetch
 * globally and its `HttpResponse.error()` is not the shape Node produces.
 * Every server binds 127.0.0.1 on an ephemeral port (127.0.0.1, not
 * `localhost`, to avoid happy-eyeballs dual-stack variance) and is torn down
 * in `afterEach`, so no handles leak into vitest.
 */
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';

import { ActionError } from '../../src/errors';
import {
  createRailwayClient,
  REQUEST_TIMEOUT_CODE,
  RequestTimeoutError,
} from '../../src/railway/client';
import { DEPLOYMENT_STATUS_QUERY } from '../../src/railway/mutations';
import {
  REDEPLOY_OUTCOME_UNKNOWN_HINT,
  redeploy,
  waitForDeployment,
} from '../../src/railway/operations';
import { withRetry } from '../../src/railway/retry';

vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

const FAST = { minTimeoutMs: 1, maxTimeoutMs: 5, randomize: false };

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

function urlOf(server: net.Server): string {
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/graphql`;
}

async function listen(server: net.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return urlOf(server);
}

/**
 * HTTP server: the first `stallCount` requests are accepted and never
 * answered; later ones get `body` as JSON. `Infinity` stalls forever.
 */
async function startHttpServer(stallCount: number, body: unknown = {}): Promise<string> {
  let seen = 0;
  const server = http.createServer((req, res) => {
    seen += 1;
    if (seen <= stallCount) return; // hold the request open
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  const url = await listen(server);
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return url;
}

/** Raw TCP server that resets the connection once the request arrives. */
async function startRstServer(): Promise<string> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.once('data', () => sock.resetAndDestroy());
  });
  const url = await listen(server);
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return url;
}

/** A port nothing listens on: bind port 0, read it, close. */
async function closedPortUrl(): Promise<string> {
  const server = net.createServer();
  const url = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return url;
}

/** Delegates to the real global fetch so errors stay genuine; counts calls. */
function countingFetch(): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  return {
    fetch: (input, init) => {
      n += 1;
      return fetch(input, init);
    },
    calls: () => n,
  };
}

function makeClient(apiUrl: string, f: typeof fetch, requestTimeoutMs = 50) {
  return createRailwayClient({
    apiUrl,
    token: 'tok',
    tokenType: 'bearer',
    fetch: f,
    requestTimeoutMs,
  });
}

const QUERY_VARS = { id: 'd1' };

describe('client — per-request timeout against a stalled server', () => {
  // RED before story 4: rejected with a plain Error, no code.
  it('rejects with a RequestTimeoutError carrying code REQUEST_TIMEOUT', async () => {
    const url = await startHttpServer(Infinity);
    const counter = countingFetch();
    const err: unknown = await makeClient(url, counter.fetch)
      .request(DEPLOYMENT_STATUS_QUERY, QUERY_VARS)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect((err as { code?: unknown }).code).toBe(REQUEST_TIMEOUT_CODE);
    expect((err as Error).message).toBe('Request timed out after 50ms');
  });

  // RED before story 4: the timeout had no code, so withRetry gave up after 1 call.
  it('withRetry retries a timed-out request (3 fetches)', async () => {
    const url = await startHttpServer(Infinity);
    const counter = countingFetch();
    const client = makeClient(url, counter.fetch);

    await expect(
      withRetry(() => client.request(DEPLOYMENT_STATUS_QUERY, QUERY_VARS), FAST),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    expect(counter.calls()).toBe(3);
  });
});

describe('client — connection reset (real undici TypeError)', () => {
  // RED before story 4: p-retry refuses to retry TypeError('fetch failed') → 1 fetch.
  it('withRetry retries ECONNRESET (3 fetches); final error keeps cause.code', async () => {
    const url = await startRstServer();
    const counter = countingFetch();
    const client = makeClient(url, counter.fetch, 2_000);

    const err: unknown = await withRetry(
      () => client.request(DEPLOYMENT_STATUS_QUERY, QUERY_VARS),
      FAST,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TypeError);
    expect((err as { cause?: { code?: unknown } }).cause?.code).toBe('ECONNRESET');
    expect(counter.calls()).toBe(3);
  });
});

describe('client — caller cancellation is never reclassified or retried', () => {
  // PIN: nothing was retried before story 4; red if the timedOut flag wins over the caller.
  it('pin: rethrows the caller abort reason unchanged; withRetry makes 1 fetch', async () => {
    const url = await startHttpServer(Infinity);
    const counter = countingFetch();
    const client = makeClient(url, counter.fetch, 2_000);
    const controller = new AbortController();
    const reason = new Error('caller cancelled');
    setTimeout(() => controller.abort(reason), 20);

    await expect(
      withRetry(
        () => client.request(DEPLOYMENT_STATUS_QUERY, QUERY_VARS, { signal: controller.signal }),
        FAST,
      ),
    ).rejects.toBe(reason);
    expect(counter.calls()).toBe(1);
  });

  // PIN: a caller's AbortSignal.timeout() is a TimeoutError DOMException, NOT our timeout.
  it("pin: a caller's AbortSignal.timeout() is rethrown as its TimeoutError, 1 fetch", async () => {
    const url = await startHttpServer(Infinity);
    const counter = countingFetch();
    const client = makeClient(url, counter.fetch, 2_000);
    const signal = AbortSignal.timeout(20);

    const err: unknown = await withRetry(
      () => client.request(DEPLOYMENT_STATUS_QUERY, QUERY_VARS, { signal }),
      FAST,
    ).catch((e: unknown) => e);

    expect(err).toBe(signal.reason);
    expect((err as Error).name).toBe('TimeoutError');
    expect(err).not.toBeInstanceOf(RequestTimeoutError);
    expect(counter.calls()).toBe(1);
  });
});

describe('redeploy composes with the retry change (never resent after an ambiguous failure)', () => {
  const args = { serviceId: 's1', environmentId: 'e1', serviceLabel: 'web' };

  // PIN: guards story 3 composition — a reset may follow an accepted mutation.
  it('pin: RST → 1 fetch, outcome-unknown hint', async () => {
    const url = await startRstServer();
    const counter = countingFetch();
    const err: unknown = await redeploy(makeClient(url, counter.fetch, 2_000), args).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).hint).toBe(REDEPLOY_OUTCOME_UNKNOWN_HINT);
    expect(counter.calls()).toBe(1);
  });

  // PIN: REQUEST_TIMEOUT is retryable but NOT safe to resend.
  it('pin: request timeout → attempted exactly once, outcome-unknown hint', async () => {
    const url = await startHttpServer(Infinity);
    const counter = countingFetch();
    const err: unknown = await redeploy(makeClient(url, counter.fetch), args).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ActionError);
    expect((err as ActionError).hint).toBe(REDEPLOY_OUTCOME_UNKNOWN_HINT);
    expect(counter.calls()).toBe(1);
  });

  // RED before story 4: TypeError('fetch failed') ECONNREFUSED → p-retry stops after 1.
  it('closed port (ECONNREFUSED, never sent) → 3 fetches', async () => {
    const url = await closedPortUrl();
    const counter = countingFetch();
    const err: unknown = await redeploy(makeClient(url, counter.fetch, 2_000), args).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ActionError);
    expect(counter.calls()).toBe(3);
  }, 15_000);
});

describe('waitForDeployment — a timed-out status poll does not fail the gate', () => {
  // RED before story 4: the gate threw "Railway API request failed (during:
  // deploymentStatus)" on the first timeout. Uses the gate's real {retries:1}
  // backoff (1-2s), hence the longer test timeout.
  it('resolves SUCCESS after two polls stall past requestTimeoutMs', async () => {
    const url = await startHttpServer(2, {
      data: { deployment: { id: 'd1', status: 'SUCCESS', createdAt: 't' } },
    });
    const counter = countingFetch();

    const snapshot = await waitForDeployment(makeClient(url, counter.fetch), 'd1', {
      pollIntervalMs: 1,
      sleep: () => Promise.resolve(),
      stallTimeoutMs: 0,
      onPoll: () => {},
    });

    expect(snapshot.status).toBe('SUCCESS');
    expect(counter.calls()).toBe(3);
  }, 15_000);
});
