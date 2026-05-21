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
      core.info(JSON.stringify({ query: document, variables }));

      const response: unknown = document.includes('serviceInstanceDeploy')
        ? { data: { serviceInstanceDeploy: 'dry-run-deploy-id' } }
        : { data: { dryRun: true } };

      return Promise.resolve(response as TResult);
    },
  };
}
