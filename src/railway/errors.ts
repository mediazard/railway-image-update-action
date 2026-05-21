import { ClientError } from 'graphql-request';
import { AbortError } from 'p-retry';

import { ActionError } from '../errors';

/**
 * Domain error for GraphQL responses that returned `errors[]`. Holds only
 * sanitized error messages — never headers, never the request body. Tests
 * assert that mapToActionError never surfaces request material.
 */
export class RailwayGqlError extends Error {
  public readonly errors: ReadonlyArray<{ message: string }>;
  public readonly operation: string;

  constructor(errors: ReadonlyArray<{ message: string }>, operation: string) {
    super(`Railway GraphQL error during: ${operation}`);
    this.name = 'RailwayGqlError';
    this.errors = errors;
    this.operation = operation;
  }
}

interface StatusMapping {
  message: string;
  hint: string;
}

/**
 * Stable error strings keyed by HTTP status, per the plan's "Stable error
 * message strings" table. Centralized so `errors.test.ts` can assert exact
 * outputs and consumer log-grep scripts keep working.
 */
function mapByStatus(status: number, operation: string): StatusMapping | undefined {
  switch (status) {
    case 400:
      return {
        message: `Railway API rejected the request as invalid (during: ${operation})`,
        hint: 'Check that all input values (environment-id, service IDs, image) are well-formed.',
      };
    case 401:
      return {
        message: 'Railway API authentication failed',
        hint: 'Verify your RAILWAY_API_TOKEN is set and has not expired. Confirm token-type matches the token (bearer vs project).',
      };
    case 403:
      return {
        message: 'Railway API rejected the request (forbidden)',
        hint: 'Ensure your API token has access to this project and environment.',
      };
    case 404:
      return {
        message: 'Railway API resource not found',
        hint: 'Verify the service ID, environment ID, and project are correct.',
      };
    case 429:
      return {
        message: 'Railway API rate limit reached',
        hint: 'The action retried automatically. If this persists, slow down deploys or contact Railway support.',
      };
    case 500:
    case 502:
    case 503:
    case 504:
      return {
        message: 'Railway API is currently unavailable',
        hint: 'The action retried automatically. Check Railway status (https://status.railway.app) before re-running.',
      };
    default:
      return undefined;
  }
}

/**
 * Pick a human-friendly hint based on keywords inside a GraphQL `errors[]`
 * message. Case-insensitive, first-match wins. Falls back to a generic hint.
 */
function hintFromGqlMessages(messages: ReadonlyArray<string>): string {
  const haystack = messages.join(' ').toLowerCase();
  if (haystack.includes('not found')) {
    return 'Verify the service ID, environment ID, and project are correct.';
  }
  if (haystack.includes('permission')) {
    return 'Ensure your API token has access to this project and environment.';
  }
  if (haystack.includes('invalid')) {
    return 'Check that all input values (environment-id, service IDs, image) are well-formed.';
  }
  return 'Check the Railway dashboard for more details.';
}

/**
 * Convert any thrown error from the railway transport / retry stack into a
 * structured `ActionError` (message / details / hint). The rules:
 *
 *  - `AbortError` (from `p-retry`): unwrap `.originalError` and recurse so the
 *    underlying cause is what surfaces.
 *  - `ClientError` with `response.errors[]`: build a `RailwayGqlError`-style
 *    triplet from the GraphQL error messages alone — NEVER include the
 *    request body or headers.
 *  - `ClientError` with a non-2xx HTTP status: map via `mapByStatus`.
 *  - Network-level error with a known `code`: report code-only in details.
 *  - Anything else: wrap with `String(err)` and a generic hint.
 *
 * The plan's threat model: GraphQL request bodies and Authorization headers
 * routinely contain secrets. We strip them at this single chokepoint.
 */
export function mapToActionError(err: unknown, operation: string): ActionError {
  // Unwrap p-retry AbortError to surface the underlying cause.
  if (err instanceof AbortError) {
    return mapToActionError(err.originalError, operation);
  }

  if (err instanceof ClientError) {
    const status = err.response.status;
    const gqlErrors = err.response.errors ?? [];

    if (gqlErrors.length > 0) {
      const messages = gqlErrors.map((e) => e.message);
      const details = messages.join('\n');
      return new ActionError(
        `Railway GraphQL error during: ${operation}`,
        details,
        hintFromGqlMessages(messages),
        { cause: err },
      );
    }

    const mapped = mapByStatus(status, operation);
    if (mapped) {
      return new ActionError(mapped.message, `HTTP ${status}`, mapped.hint, { cause: err });
    }

    // Status with no mapping (rare; 5xx already covered, generic 4xx).
    return new ActionError(
      `Railway API request failed with HTTP ${status} (during: ${operation})`,
      `HTTP ${status}`,
      'Check the Railway dashboard for more details.',
      { cause: err },
    );
  }

  // Network-class error (post-retry exhaustion). Surface code only — never
  // include the URL, headers, or body that some libraries attach.
  if (typeof err === 'object' && err !== null) {
    const e = err as { cause?: unknown; code?: unknown; message?: unknown };
    const causeCode =
      typeof e.cause === 'object' && e.cause !== null
        ? (e.cause as { code?: unknown }).code
        : undefined;
    const code =
      (typeof causeCode === 'string' ? causeCode : undefined) ??
      (typeof e.code === 'string' ? e.code : undefined);
    if (code) {
      return new ActionError(
        'Railway API request failed',
        code,
        'Check your network connection and that backboard.railway.app is reachable.',
        { cause: err },
      );
    }
  }

  // Unknown error class — preserve only the message text.
  const fallbackMessage = err instanceof Error ? err.message : String(err);
  return new ActionError(
    `Railway API request failed (during: ${operation})`,
    fallbackMessage,
    'Re-run the action with ACTIONS_STEP_DEBUG=true for more detail.',
    { cause: err },
  );
}
