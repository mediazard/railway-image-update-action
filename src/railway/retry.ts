import * as core from '@actions/core';
import { ClientError } from 'graphql-request';
import pRetry, { AbortError } from 'p-retry';

/**
 * HTTP statuses that warrant a retry. Matches v0's bash behavior plus 500 (a
 * generic 5xx that v0 also retried via its `>= 500` arithmetic check).
 */
const RETRYABLE_HTTP_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * Node 20 / undici network error codes that map onto v0's curl exit codes 6,
 * 7, and 28. Explicitly enumerated — we never catch "any Error" as retryable.
 *
 * - `ENOTFOUND` / `EAI_AGAIN`         → curl 6 (DNS)
 * - `ECONNREFUSED` / `ECONNRESET`     → curl 7 (connect)
 * - `ETIMEDOUT`, `UND_ERR_*_TIMEOUT`, `UND_ERR_SOCKET`, `ABORT_ERR` → curl 28
 *   plus our own AbortController-based per-request timeout.
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'ABORT_ERR',
]);

/**
 * Retry policy. Defaults produce exponential backoff with jitter — 1–2s /
 * 2–4s / 4–8s across 3 attempts total (matches the parity disclaimer in the
 * plan; v0 used `2^(n-1) + RANDOM%3` which is shape-close but not identical).
 */
export interface RetryPolicy {
  /** Number of retries AFTER the initial attempt. Default 2 → up to 3 attempts. */
  retries: number;
  /** Lower bound for backoff in ms. */
  minTimeoutMs: number;
  /** Upper bound for backoff in ms. */
  maxTimeoutMs: number;
  /** Exponent base. */
  factor: number;
  /** When true, `p-retry` multiplies delay by 1×–2× (jitter). */
  randomize: boolean;
}

const DEFAULT_POLICY: RetryPolicy = {
  retries: 2,
  minTimeoutMs: 1000,
  maxTimeoutMs: 8000,
  factor: 2,
  randomize: true,
};

/**
 * Inspect an error for a low-level network code. Node fetch / undici typically
 * sets `err.cause.code`; some wrappers set `err.code` directly.
 */
function extractCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { cause?: unknown; code?: unknown };
  const causeCode =
    typeof e.cause === 'object' && e.cause !== null
      ? (e.cause as { code?: unknown }).code
      : undefined;
  const code = causeCode ?? e.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Decorator: wraps an async producer in `p-retry` with explicit error
 * dispatch. Retryable errors are re-thrown so `p-retry` retries; everything
 * else is wrapped in `AbortError` so the retry loop exits cleanly and the
 * caller (`mapToActionError`) can categorize it.
 *
 * Intentionally NOT inside `client.ts`: `dry-run.ts` must never trigger
 * retries, and decoupling lets `operations.ts` opt every mutation in without
 * leaking retry behavior into the transport surface.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy?: Partial<RetryPolicy>,
): Promise<T> {
  const cfg: RetryPolicy = { ...DEFAULT_POLICY, ...policy };
  const totalAttempts = cfg.retries + 1;

  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof ClientError) {
          const status = err.response.status;
          if (RETRYABLE_HTTP_STATUSES.has(status)) {
            throw err; // retry
          }
          throw new AbortError(err);
        }
        const code = extractCode(err);
        if (code && RETRYABLE_NETWORK_CODES.has(code)) {
          throw err instanceof Error ? err : new Error(String(err));
        }
        throw new AbortError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    {
      retries: cfg.retries,
      minTimeout: cfg.minTimeoutMs,
      maxTimeout: cfg.maxTimeoutMs,
      factor: cfg.factor,
      randomize: cfg.randomize,
      onFailedAttempt: (error) => {
        core.info(
          `Attempt ${error.attemptNumber}/${totalAttempts} failed (${error.message}). Retrying...`,
        );
      },
    },
  );
}
