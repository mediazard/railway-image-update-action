/**
 * Pinned GraphQL operations for the Railway Backboard API.
 *
 * Mutation/query strings are pinned as compact one-liners so the
 * `client.roundtrip.test.ts` MSW interceptor can assert on the exact wire
 * bytes. Don't reformat.
 *
 * Variable name choices (`sid`, `eid`, `input`) are short and intentional.
 */

import type { RegistryCredentials } from '../types';

/** Railway Backboard GraphQL endpoint. */
export const RAILWAY_API_URL = 'https://backboard.railway.app/graphql/v2';

// ─────────────────────────────────────────────────────────────────────────
// Mutations
// ─────────────────────────────────────────────────────────────────────────

/**
 * Update a service instance's image source (and optionally registry
 * credentials) for a given environment. Per the Railway API docs, this
 * returns an unused opaque value — we only care that the mutation succeeded
 * (HTTP 200 + no GraphQL `errors[]`).
 */
export const UPDATE_IMAGE_MUTATION =
  'mutation($sid:String!,$eid:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:$sid,environmentId:$eid,input:$input)}';

/**
 * Trigger a deploy of the service instance. Uses `serviceInstanceDeployV2`
 * (not the legacy `serviceInstanceDeploy`) because V2 reliably returns the
 * deployment-id string in `data.serviceInstanceDeployV2`. The V1 mutation
 * sometimes returns the boolean `true` instead of a string — caught in
 * London staging deploy 26274637756, and `[[ "$id" != "true" ]]` is in the
 * v0 bash for the same reason.
 */
export const DEPLOY_MUTATION =
  'mutation($sid:String!,$eid:String!){serviceInstanceDeployV2(serviceId:$sid,environmentId:$eid)}';

// ─────────────────────────────────────────────────────────────────────────
// Queries (deployment observability)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Look up the current status of a deployment. Used by `waitForDeployment`
 * to poll first-service deploys (when ordered mode is set) before letting
 * the rest of the services roll forward.
 *
 * Status enum (from Railway docs): BUILDING / DEPLOYING / SUCCESS / FAILED
 * / CRASHED / REMOVED / SLEEPING / SKIPPED / WAITING / QUEUED.
 */
export const DEPLOYMENT_STATUS_QUERY =
  'query($id:String!){deployment(id:$id){id,status,createdAt}}';

/**
 * Fallback query — look up the latest deployment for a service in an
 * environment. Used when `serviceInstanceDeployV2` returns null/undefined
 * (rare; defense-in-depth) so we can still poll without needing the
 * project-id input.
 */
export const SERVICE_INSTANCE_LATEST_DEPLOYMENT_QUERY =
  'query($sid:String!,$eid:String!){serviceInstance(serviceId:$sid,environmentId:$eid){latestDeployment{id,status,createdAt}}}';

/**
 * Fetch build logs for a deployment. Used only on FAILED/CRASHED to attach
 * the actual build error to the `ActionError` we throw, so the consumer
 * sees what went wrong instead of a generic "deploy failed" message.
 */
export const BUILD_LOGS_QUERY =
  'query($id:String!,$limit:Int){buildLogs(deploymentId:$id,limit:$limit){timestamp,message,severity}}';

// ─────────────────────────────────────────────────────────────────────────
// Variable + response shapes
// ─────────────────────────────────────────────────────────────────────────

/**
 * `ServiceInstanceUpdateInput` as the Railway API expects it. The
 * `registryCredentials` field is a top-level sibling of `source`.
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

/** Variables for `DEPLOY_MUTATION` (serviceInstanceDeployV2). */
export interface DeployVariables {
  sid: string;
  eid: string;
}

/** Variables for `DEPLOYMENT_STATUS_QUERY`. */
export interface DeploymentStatusVariables {
  id: string;
}

/** Variables for `SERVICE_INSTANCE_LATEST_DEPLOYMENT_QUERY`. */
export interface ServiceInstanceLatestDeploymentVariables {
  sid: string;
  eid: string;
}

/** Variables for `BUILD_LOGS_QUERY`. */
export interface BuildLogsVariables {
  id: string;
  limit: number;
}

/**
 * Subset of Railway's deployment status enum we care about. Terminal states
 * cause `waitForDeployment` to resolve or reject; non-terminal states cause
 * the next poll iteration.
 */
export type DeploymentStatus =
  | 'BUILDING'
  | 'DEPLOYING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CRASHED'
  | 'REMOVED'
  | 'SLEEPING'
  | 'SKIPPED'
  | 'WAITING'
  | 'QUEUED';
