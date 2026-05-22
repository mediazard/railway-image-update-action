/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClientError } from 'graphql-request';

import { withRetry } from '../../src/railway/retry';

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
