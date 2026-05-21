import * as core from '@actions/core';

import type { RailwayClient } from './client';
import { RAILWAY_API_URL } from './mutations';

/**
 * Canned-response client matching the v0 bash DRY_RUN path. Logs the same
 * `[DRY-RUN] Would send to ...` triplet, then synchronously resolves with a
 * canned response — different shape for the deploy mutation than for any
 * other call (matches `serviceInstanceDeploy` vs `dryRun: true` in v0).
 *
 * **Invariant (load-bearing): never rejects.** `operations.ts` wraps every
 * request in `withRetry`, and dry-run runs must produce a single
 * `[DRY-RUN] Would send` line per operation with zero retry-attempt noise.
 * A unit test asserts no retry-attempt log appears under DRY_RUN.
 */
export function createDryRunClient(): RailwayClient {
  return {
    request<TVars, TResult>(
      document: string,
      variables: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      const operation = opts?.operationName ?? 'GraphQL request';
      core.info(`[DRY-RUN] Would send to ${RAILWAY_API_URL}:`);
      core.info(`[DRY-RUN]   Operation: ${operation}`);
      core.info(`[DRY-RUN]   Body:`);
      // Redact registryCredentials BEFORE JSON.stringify — `core.setSecret`
      // only substring-masks the original password string, and JSON escapes
      // (`\"`, `\\`, `\n`) would slip past the runner's masker.
      core.info(JSON.stringify({ query: document, variables: redactCreds(variables) }));

      const response: unknown = document.includes('serviceInstanceDeploy')
        ? { data: { serviceInstanceDeploy: 'dry-run-deploy-id' } }
        : { data: { dryRun: true } };

      return Promise.resolve(response as TResult);
    },
  };
}

/**
 * Walk the variables object and replace any value at a key matching
 * `password|secret|token|credential(s)` (case-insensitive) with `'[REDACTED]'`.
 * Used by the dry-run client so credentials can't leak past
 * `core.setSecret`'s substring mask when JSON-escape sequences change the
 * encoded form. Recursive so future GraphQL variables shapes are covered
 * automatically.
 */
const SENSITIVE_KEY = /password|secret|token|credentials?/i;

function redactCreds<TVars>(variables: TVars): TVars {
  return redactValue(variables) as TVars;
}

function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactValue(val);
  }
  return out;
}
