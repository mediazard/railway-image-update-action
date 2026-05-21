import * as core from '@actions/core';

import { ActionError } from '../errors';

import { ActionInputsSchema, zodErrorToActionError, type ActionInputs } from './schema';

/**
 * String-typed snapshot of every `core.getInput` result, plus the two
 * `core.getBooleanInput` booleans (Appendix D). This is the input to the zod
 * schema. We keep raw values around so `zodErrorToActionError` can surface
 * the offending value verbatim — secrets have already been registered with
 * `core.setSecret` by `readRawFromCore`, so any log line that prints them
 * will be masked automatically by the runner.
 */
export interface RawInputs {
  apiToken: string;
  tokenType: string;
  environmentId: string;
  image: string;
  services: string;
  firstService: string;
  waitSeconds: string;
  registryUsername: string;
  registryPassword: string;
  resolveToDigest: boolean;
  allowMutableTag: boolean;
}

/**
 * Read every action input through `@actions/core` and IMMEDIATELY mask the
 * two secrets (api-token, registry-password) via `core.setSecret` BEFORE
 * storing or returning them. Per-input ordering is load-bearing: if a later
 * step throws, the earlier secrets are already registered with the runner
 * and will be masked in any subsequent log line.
 *
 * `registry-username` is intentionally NOT masked (Design Principle 5 —
 * usernames are not secrets per OCI conventions; v0 logs them verbatim and
 * masking them breaks debug-ability).
 *
 * The two booleans (`resolve-to-digest`, `allow-mutable-tag`) use
 * `core.getBooleanInput` (Appendix D) which throws on invalid values per
 * the GitHub Actions YAML 1.2 boolean spec — strictly better than
 * `z.coerce.boolean()` which accepts almost anything as truthy.
 */
export function readRawFromCore(): RawInputs {
  // Read + mask BOTH secrets FIRST, before any other input. Any subsequent
  // log line that contains the token or password is automatically masked
  // by the runner, even if a later read throws.
  const apiToken = core.getInput('api-token');
  if (apiToken !== '') core.setSecret(apiToken);

  const registryPassword = core.getInput('registry-password');
  if (registryPassword !== '') core.setSecret(registryPassword);

  const tokenType = core.getInput('token-type');
  const environmentId = core.getInput('environment-id');
  const image = core.getInput('image');
  const services = core.getInput('services');
  const firstService = core.getInput('first-service');
  const waitSeconds = core.getInput('wait-seconds');

  // NOT masked — see comment above.
  const registryUsername = core.getInput('registry-username');

  const resolveToDigest = core.getBooleanInput('resolve-to-digest');
  const allowMutableTag = core.getBooleanInput('allow-mutable-tag');

  return {
    apiToken,
    tokenType,
    environmentId,
    image,
    services,
    firstService,
    waitSeconds,
    registryUsername,
    registryPassword,
    resolveToDigest,
    allowMutableTag,
  };
}

/**
 * Read and validate every action input. Throws an `ActionError` with a
 * v0-equivalent stable message on any validation failure.
 */
export function readInputs(): ActionInputs {
  const raw = readRawFromCore();
  const result = ActionInputsSchema.safeParse(raw);
  if (!result.success) {
    throw zodErrorToActionError(result.error, raw);
  }
  return result.data;
}

// Re-export ActionError so callers that already import from this module have
// a single place to catch the union of "core read failed" and "validation
// failed" errors without reaching into ../errors directly.
export { ActionError };
