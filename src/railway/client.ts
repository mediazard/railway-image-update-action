import * as core from '@actions/core';
import { ClientError, GraphQLClient } from 'graphql-request';

import { sanitizeForLog, scrubSecrets } from '../log-sanitize';
import type { TokenType } from '../types';

import { RAILWAY_API_URL } from './mutations';

/**
 * Default per-ATTEMPT timeout in milliseconds. **Important**: this is the cap
 * on a single HTTP attempt — `withRetry` resets it for each of up to 3
 * attempts, so the worst-case wall-clock per operation is roughly
 * `PER_ATTEMPT_REQUEST_TIMEOUT_MS × 3 + backoff` (~95s with defaults).
 *
 * New in v1 — v0 inherited curl's effectively-indefinite default; bounding
 * this is a deliberate behavior change documented in CHANGELOG.
 * AbortController-based, so it cooperates with `withRetry`'s `ABORT_ERR`
 * retry classification.
 */
export const PER_ATTEMPT_REQUEST_TIMEOUT_MS = 30_000;

/** @deprecated use PER_ATTEMPT_REQUEST_TIMEOUT_MS — kept for backwards compat. */
export const DEFAULT_REQUEST_TIMEOUT_MS = PER_ATTEMPT_REQUEST_TIMEOUT_MS;

/**
 * Minimal transport surface used by `operations.ts`. Retry policy is **not**
 * baked in here — `withRetry` decorates calls in the operations layer so a
 * dry-run client can short-circuit retry attempts entirely (see `dry-run.ts`).
 */
export interface RailwayClient {
  request<TVars, TResult>(
    document: string,
    variables: TVars,
    opts?: { signal?: AbortSignal; operationName?: string },
  ): Promise<TResult>;
}

/** Constructor options for the production client. */
export interface CreateRailwayClientOptions {
  apiUrl?: string;
  token: string;
  tokenType: TokenType;
  /** Injectable for `client.roundtrip.test.ts` (msw intercepts via global). */
  fetch?: typeof fetch;
  /** Per-attempt abort timeout. Defaults to `PER_ATTEMPT_REQUEST_TIMEOUT_MS`. */
  requestTimeoutMs?: number;
}

/**
 * Build the correct authorization header for the given Railway token type.
 *
 * Railway accepts a workspace/user PAT as `Authorization: Bearer ...` and a
 * project-scoped token as `Project-Access-Token: ...` — different envelopes
 * with different scopes. Mixing them yields a 401 with no useful detail, so
 * `inputs.parse.ts` defaults to `bearer` and surfaces this explicitly.
 */
function buildAuthHeaders(token: string, tokenType: TokenType): Record<string, string> {
  if (tokenType === 'project') {
    return { 'Project-Access-Token': token };
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Chain a caller-provided AbortSignal to a fresh AbortController so that either
 * the timer or the caller can abort the request. Returns an unsubscribe fn.
 */
function chainSignals(controller: AbortController, external: AbortSignal | undefined): () => void {
  if (!external) return () => {};
  if (external.aborted) {
    controller.abort(external.reason);
    return () => {};
  }
  const onAbort = (): void => {
    controller.abort(external.reason);
  };
  external.addEventListener('abort', onAbort, { once: true });
  return () => {
    external.removeEventListener('abort', onAbort);
  };
}

/** Variable keys whose string values are treated as secrets. */
const SECRET_KEY = /password|token/i;

/**
 * Collect every string found under a `password`/`token`-named key anywhere in
 * the request variables (e.g. `input.registryCredentials.password`).
 */
function collectSecretValues(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectSecretValues(v, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && SECRET_KEY.test(key)) out.push(v);
      else collectSecretValues(v, out);
    }
  }
  return out;
}

/**
 * Strip request material from a graphql-request `ClientError`, and make the
 * Railway text it carries safe to log, in place.
 *
 * `ClientError`'s constructor bakes `JSON.stringify({ response, request })`
 * into `message` (and, via `captureStackTrace`, into `stack`); `request`
 * carries `variables`, which for `updateImage` include
 * `registryCredentials.password`. Anything downstream that logs
 * `err.message` (the retry log, the gate's debug line, `main.ts`) would print
 * it, and JSON escaping can defeat the runner's secret mask.
 *
 * Railway's own `response.errors[].message` text is also untrusted: a GraphQL
 * validation message can echo submitted variables (JSON-escaped), and any
 * text can carry workflow commands. Chokepoint A: each message has CRs
 * stripped, then `secrets` (the token plus every password/token-named
 * variable) scrubbed in raw and JSON-escaped form, then passes through
 * `sanitizeForLog`. This happens
 * BEFORE `message` and `stack` are rebuilt from it.
 *
 * Mutated in place (not rebuilt) on purpose: a new `ClientError` would re-run
 * its constructor and bake the JSON back in, and the same instance must keep
 * `instanceof ClientError`, `response.status` and `response.errors` working
 * for retry classification and `mapToActionError`.
 */
function redactClientError(err: ClientError, secrets: readonly string[]): ClientError {
  // Strip CR before scrubbing: sanitizeForLog drops CRs, which would otherwise
  // reassemble a secret Railway echoed split by `\r` after the scrub missed it.
  const clean = (text: string): string =>
    sanitizeForLog(scrubSecrets(text.replace(/\r/g, ''), secrets));
  for (const gqlError of err.response.errors ?? []) {
    const mutable = gqlError as { message: unknown };
    if (typeof mutable.message === 'string') mutable.message = clean(mutable.message);
  }
  // Mirrors ClientError.extractMessage (private in graphql-request's typings).
  err.message =
    err.response.errors?.[0]?.message ?? `GraphQL Error (Code: ${String(err.response.status)})`;
  err.request = { query: err.request.query };
  // Keep the stack frames, drop the JSON-bearing header lines.
  const frames = (err.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  err.stack = [`ClientError: ${err.message}`, ...frames].join('\n');
  return err;
}

/**
 * Construct a `RailwayClient` backed by `graphql-request@^7`.
 *
 * Each `.request()` call gets a fresh `AbortController` wired to:
 *   - a `setTimeout` that aborts after `requestTimeoutMs`,
 *   - any caller-provided `opts.signal`.
 *
 * `operationName` is logged at debug level only; we deliberately do NOT send it
 * on the wire — Railway's Backboard API does not require it and v0 never sent
 * it. Keeping it client-side preserves the byte-shape the round-trip test
 * snapshots.
 */
export function createRailwayClient(opts: CreateRailwayClientOptions): RailwayClient {
  const apiUrl = opts.apiUrl ?? RAILWAY_API_URL;
  const timeoutMs = opts.requestTimeoutMs ?? PER_ATTEMPT_REQUEST_TIMEOUT_MS;
  const headers = buildAuthHeaders(opts.token, opts.tokenType);

  const client = new GraphQLClient(apiUrl, {
    headers,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    // graphql-request v7 sends operationName on the wire by default when
    // present on the document. We pass it via opts only for client-side
    // logging, so this stays at its default (no-op for our raw mutations
    // which don't declare operation names).
    excludeOperationName: true,
  });

  return {
    async request<TVars, TResult>(
      document: string,
      variables: TVars,
      requestOpts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (requestOpts?.operationName) {
        core.debug(`Railway GraphQL request: ${requestOpts.operationName}`);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const unchain = chainSignals(controller, requestOpts?.signal);

      try {
        // v7 object-form: `signal` is honored end-to-end.
        return await client.request<TResult>({
          document,
          variables: variables as Record<string, unknown>,
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof ClientError) {
          throw redactClientError(err, [opts.token, ...collectSecretValues(variables)]);
        }
        throw err;
      } finally {
        clearTimeout(timer);
        unchain();
      }
    },
  };
}
