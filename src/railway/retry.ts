import * as core from '@actions/core';
import { ClientError } from 'graphql-request';
import pRetry, { AbortError } from 'p-retry';

import { ActionError } from '../errors';

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
export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
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
 * Network codes that prove the request never reached Railway, so even a
 * non-idempotent call (redeploy) can be resent: the TCP connect or the DNS
 * lookup failed. MUST be a subset of `RETRYABLE_NETWORK_CODES` (a test
 * enforces it).
 *
 * Deliberately absent: `ECONNRESET`, `UND_ERR_SOCKET`, `UND_ERR_HEADERS_TIMEOUT`
 * and `ABORT_ERR` can all fire after Railway accepted the request. `ETIMEDOUT`
 * is used for connect AND read timeouts, so with only a code it is ambiguous.
 */
export const SAFE_TO_RESEND_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
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
  /**
   * Whether resending the operation is harmless. `false` (e.g. redeploy, which
   * creates a deployment per call) limits retries to failures that prove the
   * request was never processed (`isSafeToResendError`).
   */
  idempotent: boolean;
}

const DEFAULT_POLICY: RetryPolicy = {
  retries: 2,
  minTimeoutMs: 1000,
  maxTimeoutMs: 8000,
  factor: 2,
  randomize: true,
  idempotent: true,
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
 * True if `err` is a transient failure worth retrying: a retryable HTTP status
 * (429/5xx) or a retryable network code (DNS/connect/timeout). Everything else
 * — 4xx, parse errors, unknown shapes — is permanent. Exported so callers that
 * poll in their own loop (e.g. `waitForDeployment`) can tell a transient
 * status-query blip apart from a hard failure without re-implementing the map.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof ClientError) {
    return RETRYABLE_HTTP_STATUSES.has(err.response.status);
  }
  const code = extractCode(err);
  return code !== undefined && RETRYABLE_NETWORK_CODES.has(code);
}

/**
 * True if `err` proves the request was never processed, so resending it can't
 * duplicate a side effect: HTTP 429 (rejected unprocessed) or a network code in
 * `SAFE_TO_RESEND_NETWORK_CODES` (never connected).
 */
export function isSafeToResendError(err: unknown): boolean {
  if (err instanceof ClientError) {
    return err.response.status === 429;
  }
  const code = extractCode(err);
  return code !== undefined && SAFE_TO_RESEND_NETWORK_CODES.has(code);
}

/**
 * True only if Railway definitively processed and refused the request: a
 * GraphQL `errors[]` response, or an HTTP 4xx other than 429. Our own
 * `ActionError`s (shape validation) also count. Everything else — 5xx, 429
 * after retries, any network error, our per-request timeout (a plain `Error`
 * with no code), unknown shapes — leaves a non-idempotent call's outcome
 * unknown: the request may have reached Railway.
 */
export function isDefinitiveRejection(err: unknown): boolean {
  if (err instanceof ActionError) return true;
  if (err instanceof ClientError) {
    if ((err.response.errors?.length ?? 0) > 0) return true;
    const status = err.response.status;
    return status >= 400 && status < 500 && status !== 429;
  }
  return false;
}

/**
 * Decorator: wraps an async producer in `p-retry` with explicit error
 * dispatch. Retryable errors (`isRetryableError`, or only
 * `isSafeToResendError` when `policy.idempotent` is false) are re-thrown so
 * `p-retry` retries; everything else is wrapped in `AbortError` so the retry
 * loop exits cleanly and the caller (`mapToActionError`) can categorize it.
 * p-retry rejects with the original error, so callers can classify it.
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
  const shouldRetry = cfg.idempotent ? isRetryableError : isSafeToResendError;

  return pRetry(
    async () => {
      try {
        return await fn();
      } catch (err) {
        if (shouldRetry(err)) {
          throw err instanceof Error ? err : new Error(String(err)); // let p-retry retry
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
