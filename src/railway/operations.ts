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
 * Response schema for `serviceInstanceDeploy`. The field can be `null` — v0
 * surfaces this as the "deployment-id: (unavailable)" warning path.
 */
const DeployResponseSchema = z.object({
  data: z.object({ serviceInstanceDeploy: z.string().nullable() }),
});

/**
 * Response schema for `serviceInstanceUpdate`. We don't consume the value —
 * just assert the wrapping shape so API drift fails loudly. No `.passthrough()`
 * is needed: zod ignores unknown keys by default, and `z.unknown()` already
 * accepts anything at the inner position.
 */
const UpdateResponseSchema = z.object({
  data: z.object({ serviceInstanceUpdate: z.unknown() }),
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
    return { deploymentId: parsed.data.serviceInstanceDeploy };
  } catch (err) {
    const actionErr: ActionError = mapToActionError(err, `deployService:${args.serviceLabel}`);
    throw actionErr;
  }
}
