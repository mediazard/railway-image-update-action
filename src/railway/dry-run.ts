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
 * Return a shallow clone of the variables with any
 * `input.registryCredentials` replaced by `'[REDACTED]'`. Used by the
 * dry-run client so credentials can't leak past `core.setSecret`'s
 * substring mask when JSON-escaping changes the encoded form.
 */
function redactCreds<TVars>(variables: TVars): TVars {
  if (!variables || typeof variables !== 'object') return variables;
  const v = variables as { input?: { registryCredentials?: unknown } };
  if (!v.input || !v.input.registryCredentials) return variables;
  return {
    ...(variables as object),
    input: { ...v.input, registryCredentials: '[REDACTED]' },
  } as TVars;
}
