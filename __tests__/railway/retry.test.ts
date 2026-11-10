import * as core from '@actions/core';
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
    },
    { query: '' },
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

// ─────────────────────────────────────────────────────────────────────────
// Story 4: real Node 20 fetch failure shapes (copied from a probe against real
// sockets). undici rejects with a TypeError carrying the code on `cause.code`;
// p-retry 4.6.2 refuses to retry any TypeError whose message is not in its
// browser list, so these must be retried by withRetry's own decision.
// ─────────────────────────────────────────────────────────────────────────

function realFetchFailed(code: string, message: string, extra: object = {}): TypeError {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error(message), { code, ...extra }),
  });
}

const REAL_SHAPES: ReadonlyArray<[string, () => Error]> = [
  [
    'fetch failed / ECONNRESET',
    () => realFetchFailed('ECONNRESET', 'read ECONNRESET', { errno: -54, syscall: 'read' }),
  ],
  [
    'fetch failed / ECONNREFUSED',
    () =>
      realFetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:1', {
        errno: -61,
        syscall: 'connect',
      }),
  ],
  [
    'fetch failed / ECONNREFUSED (AggregateError, happy-eyeballs)',
    () =>
      new TypeError('fetch failed', {
        cause: Object.assign(
          new AggregateError(
            [
              Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' }),
              Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), {
                code: 'ECONNREFUSED',
              }),
            ],
            '',
          ),
          { code: 'ECONNREFUSED' },
        ),
      }),
  ],
  [
    'fetch failed / UND_ERR_CONNECT_TIMEOUT',
    () =>
      realFetchFailed('UND_ERR_CONNECT_TIMEOUT', 'Connect Timeout Error', {
        name: 'ConnectTimeoutError',
      }),
  ],
  [
    'terminated / UND_ERR_SOCKET',
    () =>
      new TypeError('terminated', {
        cause: Object.assign(new Error('other side closed'), {
          name: 'SocketError',
          code: 'UND_ERR_SOCKET',
        }),
      }),
  ],
];

describe('withRetry — real Node 20 fetch TypeErrors (story 4)', () => {
  // RED before story 4: p-retry index.js:60 stops a non-browser TypeError after 1 attempt.
  it.each(REAL_SHAPES)('retries %s (3 total attempts)', async (_label, make) => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts += 1;
      throw make();
    });

    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeInstanceOf(TypeError);
    expect(attempts).toBe(3);
  });

  // Guards the RetryableAttempt unwrap. RED before story 4 only via the call
  // count (TypeError rule → 1 call); the `toBe(original)` half passed already.
  it('rejects with the original TypeError instance after exhaustion', async () => {
    const original = REAL_SHAPES[0][1]();
    const fn = vi.fn(async () => {
      throw original;
    });
    await expect(withRetry(fn, FAST_POLICY)).rejects.toBe(original);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // PIN: guards the unwrap for ClientError (instanceof + response survive).
  it('pin: rejects with the original ClientError(503) after exhaustion', async () => {
    const original = makeClientError(503);
    const fn = vi.fn(async () => {
      throw original;
    });
    const rejection = withRetry(fn, FAST_POLICY);
    await expect(rejection).rejects.toBe(original);
    await expect(rejection).rejects.toBeInstanceOf(ClientError);
  });

  // PIN: a non-retryable error is still the original (AbortError unwrap by p-retry).
  it('pin: rejects with the original error when not retryable', async () => {
    const original = makeClientError(401);
    const fn = vi.fn(async () => {
      throw original;
    });
    await expect(withRetry(fn, FAST_POLICY)).rejects.toBe(original);
  });
});

describe('withRetry — attempt log wording (story 4)', () => {
  // RED before story 4: the final line says "Retrying..." and shows `fetch failed`.
  it('logs the code, says Retrying... on earlier attempts and Giving up. on the last', async () => {
    const fn = vi.fn(async () => {
      throw REAL_SHAPES[0][1]();
    });
    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();

    const lines = vi.mocked(core.info).mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('Attempt 1/3 failed (ECONNRESET). Retrying...');
    expect(lines[1]).toBe('Attempt 2/3 failed (ECONNRESET). Retrying...');
    expect(lines[2]).toBe('Attempt 3/3 failed (ECONNRESET). Giving up.');
    for (const line of lines) expect(line).not.toContain('fetch failed');
    expect(lines[2]).not.toContain('Retrying');
  });

  it('logs the ClientError message when there is no code', async () => {
    const fn = vi.fn(async () => {
      throw makeClientError(503);
    });
    await expect(withRetry(fn, { ...FAST_POLICY, retries: 1 })).rejects.toBeDefined();
    const lines = vi.mocked(core.info).mock.calls.map((c) => String(c[0]));
    expect(lines).toEqual([
      expect.stringMatching(
        /^Attempt 1\/2 failed \(GraphQL Error \(Code: 503\).*\)\. Retrying\.\.\.$/,
      ),
      expect.stringMatching(
        /^Attempt 2\/2 failed \(GraphQL Error \(Code: 503\).*\)\. Giving up\.$/,
      ),
    ]);
  });
});

describe('withRetry — cancellation is never retried (story 4)', () => {
  // RED before story 4: ABORT_ERR was in the retryable set → 3 attempts.
  it("does not retry Node's AbortError (code ABORT_ERR) — 1 attempt", async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
    });
    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // PIN: DOMException.code is numeric, so these never matched the string set.
  it.each(['AbortError', 'TimeoutError'])(
    'pin: does not retry a DOMException %s — 1 attempt',
    async (name) => {
      const original = new DOMException('x', name);
      const fn = vi.fn(async () => {
        throw original;
      });
      await expect(withRetry(fn, FAST_POLICY)).rejects.toBe(original);
      expect(fn).toHaveBeenCalledTimes(1);
    },
  );

  it('ABORT_ERR is not in the retryable set', () => {
    expect(RETRYABLE_NETWORK_CODES.has('ABORT_ERR')).toBe(false);
  });
});

describe('withRetry — our per-request timeout (story 4)', () => {
  // RED before story 4: REQUEST_TIMEOUT was not in the set → 1 attempt.
  it('retries code REQUEST_TIMEOUT in default (idempotent) mode — 3 attempts', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('Request timed out after 50ms'), { code: 'REQUEST_TIMEOUT' });
    });
    await expect(withRetry(fn, FAST_POLICY)).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  // PIN: a timed-out mutation may have been applied, so never resend it.
  it('pin: does NOT retry REQUEST_TIMEOUT when idempotent:false — 1 attempt', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('Request timed out after 50ms'), { code: 'REQUEST_TIMEOUT' });
    });
    await expect(withRetry(fn, { ...FAST_POLICY, idempotent: false })).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(SAFE_TO_RESEND_NETWORK_CODES.has('REQUEST_TIMEOUT')).toBe(false);
  });
});
