/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientError } from 'graphql-request';

import {
  RETRYABLE_NETWORK_CODES,
  SAFE_TO_RESEND_NETWORK_CODES,
  withRetry,
} from '../../src/railway/retry';

// Mock @actions/core so retry's `core.info` retry-attempt log doesn't spam.
vi.mock('@actions/core', () => ({
  info: vi.fn(),
  debug: vi.fn(),
}));

/**
 * Build a ClientError with a given HTTP status. graphql-request's ClientError
 * constructor stringifies the response and request into the message, so any
 * Authorization headers passed here will appear in `.message`. We pass none
 * unless a specific test requires it.
 */
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

/** Build a network-style error with a known `code`. */
function makeNetworkError(code: string): Error {
  return Object.assign(new Error(`network error: ${code}`), { code });
}

/** Policy used in tests — keeps backoff instant. */
const FAST_POLICY = {
  minTimeoutMs: 1,
  maxTimeoutMs: 5,
  randomize: false,
};

describe('withRetry — ClientError status policy', () => {
  it.each([401, 403, 404, 400])(
    'aborts immediately on HTTP %i (no retry, exactly one attempt)',
    async (status) => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        throw makeClientError(status);
      });

      await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
      expect(attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it.each([429, 500, 502, 503, 504])(
    'retries HTTP %i until retries exhausted (3 total attempts at retries=2)',
    async (status) => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        throw makeClientError(status);
      });

      await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
      expect(attempts).toBe(3);
      expect(fn).toHaveBeenCalledTimes(3);
    },
  );
});

describe('withRetry — network code policy', () => {
  it.each([
    'ENOTFOUND',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_SOCKET',
    'ABORT_ERR',
  ])('retries network code %s (3 total attempts)', async (code) => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw makeNetworkError(code);
    });

    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });

  it('extracts code from err.cause.code as well', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      const err = new Error('wrapped');
      (err as any).cause = { code: 'ENOTFOUND' };
      throw err;
    });
    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });
});

describe('withRetry — unknown errors abort immediately', () => {
  it('aborts on a plain Error (no code, not ClientError)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw new Error('mystery failure');
    });

    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('aborts on a non-retryable network code', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw makeNetworkError('EPERM');
    });

    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });

  it('aborts on a non-Error throwable (string)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw 'string-thrown';
    });

    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });
});

describe('withRetry — happy path', () => {
  it('returns the resolved value without retrying when fn succeeds', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, FAST_POLICY)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns on retry after transient failure (1 fail then success)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw makeClientError(503);
      return 'recovered';
    });

    await expect(withRetry(fn, FAST_POLICY)).resolves.toBe('recovered');
    expect(attempts).toBe(2);
  });
});

/**
 * Shape of a real Node fetch failure (code on `cause.code`), deliberately NOT a
 * TypeError: p-retry 4.6.2 refuses to retry any TypeError, which would make
 * "not retried" pass for the wrong reason. Story 4 covers the real TypeError.
 */
function makeFetchFailure(code: string): Error {
  return Object.assign(new Error('fetch failed'), { cause: { code } });
}

describe('withRetry — idempotent:false (non-idempotent calls, e.g. redeploy)', () => {
  it.each([500, 502, 503, 504])(
    'does NOT retry HTTP %i: the request may already have been processed',
    async (status) => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        throw makeClientError(status);
      });

      await expect(withRetry(fn, { ...FAST_POLICY, idempotent: false })).rejects.toBeDefined();
      expect(attempts).toBe(1);
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT'])(
    'does NOT retry %s on cause.code: the request may already have reached Railway',
    async (code) => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        throw makeFetchFailure(code);
      });

      await expect(withRetry(fn, { ...FAST_POLICY, idempotent: false })).rejects.toBeDefined();
      expect(attempts).toBe(1);
    },
  );

  // PIN (passes before this story too): guards the safe-to-resend set.
  it('pin: retries HTTP 429 (rejected unprocessed) — 3 attempts', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw makeClientError(429);
    });

    await expect(withRetry(fn, { ...FAST_POLICY, idempotent: false })).rejects.toBeDefined();
    expect(attempts).toBe(3);
  });

  // PIN (passes before this story too): guards the safe-to-resend set.
  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])(
    'pin: retries %s (never connected, so never sent) — 3 attempts',
    async (code) => {
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        throw makeFetchFailure(code);
      });

      await expect(withRetry(fn, { ...FAST_POLICY, idempotent: false })).rejects.toBeDefined();
      expect(attempts).toBe(3);
    },
  );
});

describe('withRetry — safe-to-resend set is a subset of the retryable set', () => {
  // PIN: the invariant the two sets must keep.
  it('pin: every safe-to-resend code is retryable and retried in default mode', async () => {
    for (const code of SAFE_TO_RESEND_NETWORK_CODES) {
      expect(RETRYABLE_NETWORK_CODES.has(code)).toBe(true);
      let attempts = 0;
      const fn = vi.fn(async () => {
        attempts += 1;
        throw makeFetchFailure(code);
      });
      await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
      expect(attempts).toBe(3);
    }
  });
});
