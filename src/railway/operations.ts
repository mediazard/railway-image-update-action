import type { ActionError } from '../errors';
import type { RegistryCredentials } from '../types';

import type { RailwayClient } from './client';
import { mapToActionError } from './errors';
import {
  DEPLOY_MUTATION,
  UPDATE_IMAGE_MUTATION,
  type DeployVariables,
  type ServiceInstanceUpdateInput,
  type UpdateImageVariables,
} from './mutations';
import { withRetry } from './retry';

/**
 * Why no zod schemas here?
 *
 * We hit two production bugs in a row by being too strict about the response
 * shape (both caught by London staging dogfood, neither caught by the unit
 * tests):
 *
 *   1. graphql-request@7 returns the UNWRAPPED `data` field, not the
 *      `{data, errors}` envelope. Our schema required `data` at the top of
 *      the result; production rejected the unwrapped shape.
 *   2. Railway's `serviceInstanceDeploy` field can be a string, `null`, or
 *      the boolean `true` ("deploy accepted, no id surfaced" — v0 bash
 *      handled this explicitly via `[[ "$id" != "true" ]]`). Our schema
 *      said `string | null`; production sent `true` and we threw.
 *
 * Pattern: every assumption we made in src/ was mirrored in the
 * FakeRailwayClient's canned responses, so both sides agreed with each other
 * and disagreed with reality.
 *
 * Fix: don't validate what we don't need. We don't *use* the update response
 * at all (HTTP 200 + no GraphQL errors is sufficient confirmation), and we
 * only extract one field from the deploy response. Use defensive narrowing
 * on `unknown` for that single field. Anything surprising → degrade to
 * `deploymentId: null` and surface the existing "unavailable" warning,
 * rather than failing a deploy that Railway already accepted.
 *
 * Strict validation lives at module boundaries we control (inputs, where we
 * use zod). For external APIs, defensive narrowing is more robust.
 */

/** Arguments accepted by `updateImage`. */
export interface UpdateImageArgs {
  serviceId: string;
  environmentId: string;
  image: string;
  registryCredentials?: RegistryCredentials;
}

/** Arguments accepted by `redeploy`. */
export interface RedeployArgs {
  serviceId: string;
  environmentId: string;
  serviceLabel: string;
}

/**
 * Update the image source (and optional registry creds) on a Railway service.
 * The response is intentionally discarded — HTTP 200 with no GraphQL
 * `errors[]` is sufficient (graphql-request@7 would have thrown otherwise).
 */
export async function updateImage(client: RailwayClient, args: UpdateImageArgs): Promise<void> {
  const input: ServiceInstanceUpdateInput = args.registryCredentials
    ? { source: { image: args.image }, registryCredentials: args.registryCredentials }
    : { source: { image: args.image } };

  const variables: UpdateImageVariables = {
    sid: args.serviceId,
    eid: args.environmentId,
    input,
  };

  try {
    await withRetry<unknown>(() =>
      client.request<UpdateImageVariables, unknown>(UPDATE_IMAGE_MUTATION, variables, {
        operationName: 'updateImage',
      }),
    );
  } catch (err) {
    const actionErr: ActionError = mapToActionError(err, 'updateImage');
    throw actionErr;
  }
}

/** Result of a successful redeploy() call. */
export interface RedeployResult {
  /** Real deployment-id string Railway surfaced, or null if it didn't. */
  deploymentId: string | null;
  /**
   * Whatever Railway put in `serviceInstanceDeploy`: a string, `null`, `true`,
   * or anything else. Exposed so the caller can format an informative
   * "unavailable" warning when `deploymentId` is null.
   */
  rawValue: unknown;
}

/**
 * Trigger a redeploy on a Railway service instance.
 *
 * On success the deploy is accepted server-side. We return both the parsed
 * deployment-id (string) and the raw value Railway sent — `deploymentId`
 * is `null` whenever `rawValue` is anything other than a non-empty string
 * (commonly `true` or `null`; see `extractDeploymentId` for full coverage).
 * The caller surfaces an "unavailable" warning in the null case but doesn't
 * fail the deploy, because Railway already accepted it.
 */
export async function redeploy(client: RailwayClient, args: RedeployArgs): Promise<RedeployResult> {
  const variables: DeployVariables = {
    sid: args.serviceId,
    eid: args.environmentId,
  };

  try {
    const raw = await withRetry<unknown>(() =>
      client.request<DeployVariables, unknown>(DEPLOY_MUTATION, variables, {
        operationName: 'deployService',
      }),
    );
    return {
      deploymentId: extractDeploymentId(raw),
      rawValue: extractRawValue(raw),
    };
  } catch (err) {
    const actionErr: ActionError = mapToActionError(err, `deployService:${args.serviceLabel}`);
    throw actionErr;
  }
}

/** Pull the `serviceInstanceDeploy` field out as-is (no type filtering). */
function extractRawValue(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  return (raw as Record<string, unknown>).serviceInstanceDeploy;
}

/**
 * Pull the `serviceInstanceDeploy` field off Railway's response defensively.
 * Returns the deployment-id string if it's a non-empty string, else `null`.
 *
 * Known wire-shapes Railway has returned in production:
 *   - `{ serviceInstanceDeploy: "<id>" }`       — happy path
 *   - `{ serviceInstanceDeploy: null }`         — no id available
 *   - `{ serviceInstanceDeploy: true }`         — "deploy accepted" boolean
 *
 * Anything else (missing field, wrong type, nested wrapper, ...) is treated
 * as "no id available" rather than thrown. Railway accepted the deploy by
 * the time we get here; refusing to surface an id is the strictly worse
 * failure mode.
 */
function extractDeploymentId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = (raw as Record<string, unknown>).serviceInstanceDeploy;
  return typeof value === 'string' && value !== '' ? value : null;
}
