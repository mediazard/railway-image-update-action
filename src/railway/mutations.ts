/**
 * Pinned GraphQL mutations and variables types for the Railway Backboard API.
 *
 * These literal strings are byte-for-byte from v0's bash refactor (Appendix A of
 * the plan). Do NOT reformat — Railway's API treats query strings opaquely, but
 * the rewritten bash smoke tests assert on exact body shape, and the
 * `client.roundtrip.test.ts` MSW interceptor compares the wire bytes.
 *
 * Variable name choices (`sid`, `eid`, `input`) mirror v0 too.
 */

import type { RegistryCredentials } from '../types';

/** Railway Backboard GraphQL endpoint. v0 constant, preserved. */
export const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

/**
 * Update a service instance's image source (and optionally registry credentials)
 * for a given environment. Returns the (unused) opaque `serviceInstanceUpdate`
 * field — we only care about whether the mutation succeeded.
 */
export const UPDATE_IMAGE_MUTATION =
  'mutation($sid:String!,$eid:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$sid,environmentId:$eid,input:$input)}';

/**
 * Trigger a redeploy of an already-configured service instance in an environment.
 * Returns the new deployment ID (string) or null when Railway can't surface one
 * (parity with v0's "deployment-id: (unavailable)" warning path).
 */
export const DEPLOY_MUTATION =
  'mutation($sid:String!,$eid:String!){serviceInstanceDeploy(serviceId:$sid,environmentId:$eid)}';

/**
 * `ServiceInstanceUpdateInput` as the Railway API expects it. The
 * `registryCredentials` field is a top-level sibling of `source` (per
 * the v0 fix in commit `1188e85`).
 */
export interface ServiceInstanceUpdateInput {
  source: { image: string };
  registryCredentials?: RegistryCredentials;
}

/** Variables for `UPDATE_IMAGE_MUTATION`. */
export interface UpdateImageVariables {
  sid: string;
  eid: string;
  input: ServiceInstanceUpdateInput;
}

/** Variables for `DEPLOY_MUTATION`. */
export interface DeployVariables {
  sid: string;
  eid: string;
}
