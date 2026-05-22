import { z } from 'zod';

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
 * Response schema for `serviceInstanceDeploy`. Railway returns one of:
 *  - a deployment-id string (happy path)
 *  - `null` (no deployment id available)
 *  - **`true`** (boolean — Railway's "deploy accepted, no id surfaced"
 *    response; observed in production, also handled by v0 bash via
 *    `[[ "$deploy_id" != "true" ]]`)
 *
 * The redeploy() function normalizes boolean to null so callers only see
 * the two cases that matter: `deploymentId: <string>` or `deploymentId: null`
 * (latter triggers the "unavailable — raw response: null" warning path).
 *
 * NOTE: graphql-request@7's `client.request()` returns the UNWRAPPED `data`
 * payload — not the full `{data, errors}` response envelope. So we validate
 * the inner shape only.
 */
const DeployResponseSchema = z.object({
  serviceInstanceDeploy: z.union([z.string(), z.boolean(), z.null()]),
});

/**
 * Response schema for `serviceInstanceUpdate`. We don't consume the value —
 * just assert the field is PRESENT so API drift (e.g. Railway renaming the
 * mutation) fails loudly. `z.unknown()` accepts any value including
 * `undefined`, so we add a `.refine` to require the key actually exists.
 *
 * As with `DeployResponseSchema`, this validates the UNWRAPPED data, not the
 * full `{data, errors}` envelope.
 */
const UpdateResponseSchema = z
  .object({ serviceInstanceUpdate: z.unknown() })
  .refine((o) => 'serviceInstanceUpdate' in o, {
    message: "Response missing 'serviceInstanceUpdate' field",
  });

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

/** Update the image source (and optional registry creds) on a Railway service. */
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
    const raw = await withRetry<unknown>(() =>
      client.request<UpdateImageVariables, unknown>(UPDATE_IMAGE_MUTATION, variables, {
        operationName: 'updateImage',
      }),
    );
    UpdateResponseSchema.parse(raw);
  } catch (err) {
    const actionErr: ActionError = mapToActionError(err, 'updateImage');
    throw actionErr;
  }
}

/**
 * Trigger a redeploy on a Railway service instance. Returns the deployment ID
 * (or `null` when Railway can't surface one — v0 emits a warning in this case).
 */
export async function redeploy(
  client: RailwayClient,
  args: RedeployArgs,
): Promise<{ deploymentId: string | null }> {
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
    const parsed = DeployResponseSchema.parse(raw);
    // Normalize: only a string is a real deployment ID. `true` and `null` both
    // mean "no id available" — caller surfaces the "unavailable" warning.
    const value = parsed.serviceInstanceDeploy;
    return { deploymentId: typeof value === 'string' ? value : null };
  } catch (err) {
    const actionErr: ActionError = mapToActionError(err, `deployService:${args.serviceLabel}`);
    throw actionErr;
  }
}
