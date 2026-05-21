import * as core from '@actions/core';
import { GraphQLClient } from 'graphql-request';

import type { TokenType } from '../types';

import { RAILWAY_API_URL } from './mutations';

/**
 * Default per-request timeout in milliseconds. New in v1 — v0 inherited curl's
 * effectively-indefinite default; bounding this is a deliberate behavior change
 * documented in CHANGELOG. AbortController-based, so it cooperates with
 * `withRetry`'s `ABORT_ERR` retry classification.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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
  /** Per-request abort timeout. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. */
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
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
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
      } finally {
        clearTimeout(timer);
        unchain();
      }
    },
  };
}
