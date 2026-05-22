import * as core from '@actions/core';

import { ActionError } from '../errors';
import type { RegistryCredentials } from '../types';

import type { RailwayClient } from './client';
import { mapToActionError } from './errors';
import {
  BUILD_LOGS_QUERY,
  DEPLOY_MUTATION,
  DEPLOYMENT_STATUS_QUERY,
  SERVICE_INSTANCE_LATEST_DEPLOYMENT_QUERY,
  UPDATE_IMAGE_MUTATION,
  type BuildLogsVariables,
  type DeploymentStatus,
  type DeploymentStatusVariables,
  type DeployVariables,
  type ServiceInstanceLatestDeploymentVariables,
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

/**
 * Pull the deployment-id field out as-is (no type filtering). Prefers V2's
 * `serviceInstanceDeployV2` key; falls back to legacy `serviceInstanceDeploy`
 * only when V2's key is ABSENT. Distinguishes "key present, value is null"
 * (return null) from "key missing" (try legacy).
 */
function extractRawValue(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if ('serviceInstanceDeployV2' in obj) return obj.serviceInstanceDeployV2;
  if ('serviceInstanceDeploy' in obj) return obj.serviceInstanceDeploy;
  return undefined;
}

/**
 * Pull the deployment-id off Railway's response defensively. Returns the
 * deployment-id string if it's a non-empty string, else `null`.
 *
 * Known wire-shapes Railway has returned:
 *   - V2: `{ serviceInstanceDeployV2: "<id>" }`  — happy path
 *   - V1: `{ serviceInstanceDeploy: "<id>" }`    — older accounts
 *   - V1: `{ serviceInstanceDeploy: null }`      — no id available
 *   - V1: `{ serviceInstanceDeploy: true }`      — "deploy accepted" boolean
 *
 * Anything else (missing field, wrong type, nested wrapper, ...) is treated
 * as "no id available" rather than thrown. Railway accepted the deploy by
 * the time we get here; refusing to surface an id is the strictly worse
 * failure mode.
 */
function extractDeploymentId(raw: unknown): string | null {
  const value = extractRawValue(raw);
  return typeof value === 'string' && value !== '' ? value : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Deployment observability — used by run.ts deployOrdered's first-service
// gate to confirm SUCCESS before letting worker/clock roll forward.
// ─────────────────────────────────────────────────────────────────────────

/** Snapshot of a deployment's current state. */
export interface DeploymentSnapshot {
  id: string;
  status: DeploymentStatus;
  createdAt: string;
}

/** Look up a single deployment by id. */
export async function getDeploymentStatus(
  client: RailwayClient,
  id: string,
): Promise<DeploymentSnapshot> {
  const raw = await withRetry<unknown>(() =>
    client.request<DeploymentStatusVariables, unknown>(
      DEPLOYMENT_STATUS_QUERY,
      { id },
      { operationName: 'deploymentStatus' },
    ),
  );
  return parseDeploymentSnapshot(raw, 'deployment');
}

/**
 * Fallback for the rare case `serviceInstanceDeployV2` doesn't surface an id:
 * look up the latest deployment for a service in this environment. Picks up
 * the deployment we just triggered (Railway's deployment list is ordered by
 * `createdAt` desc).
 */
export async function getLatestDeploymentForService(
  client: RailwayClient,
  args: { serviceId: string; environmentId: string },
): Promise<DeploymentSnapshot | null> {
  const raw = await withRetry<unknown>(() =>
    client.request<ServiceInstanceLatestDeploymentVariables, unknown>(
      SERVICE_INSTANCE_LATEST_DEPLOYMENT_QUERY,
      { sid: args.serviceId, eid: args.environmentId },
      { operationName: 'serviceInstanceLatestDeployment' },
    ),
  );
  if (typeof raw !== 'object' || raw === null) return null;
  const serviceInstance = (raw as Record<string, unknown>).serviceInstance;
  if (typeof serviceInstance !== 'object' || serviceInstance === null) return null;
  const latest = (serviceInstance as Record<string, unknown>).latestDeployment;
  if (typeof latest !== 'object' || latest === null) return null;
  try {
    return parseDeploymentSnapshot(latest, 'latestDeployment');
  } catch {
    return null;
  }
}

/** Get build logs for a failed deployment. Best-effort — swallows errors. */
export async function getBuildLogs(
  client: RailwayClient,
  id: string,
  limit = 100,
): Promise<string> {
  try {
    const raw = await withRetry<unknown>(() =>
      client.request<BuildLogsVariables, unknown>(
        BUILD_LOGS_QUERY,
        { id, limit },
        { operationName: 'buildLogs' },
      ),
    );
    if (typeof raw !== 'object' || raw === null) return '';
    const logs = (raw as Record<string, unknown>).buildLogs;
    if (!Array.isArray(logs)) return '';
    return logs
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) return '';
        const e = entry as Record<string, unknown>;
        const ts = typeof e.timestamp === 'string' ? e.timestamp : '';
        const sev = typeof e.severity === 'string' ? e.severity : '';
        const msg = typeof e.message === 'string' ? e.message : '';
        return `${ts} ${sev} ${msg}`.trim();
      })
      .filter((line) => line !== '')
      .join('\n');
  } catch {
    return '';
  }
}

/** Set of terminal deployment statuses. Polling ends when we hit one. */
const TERMINAL_STATUSES = new Set<DeploymentStatus>([
  'SUCCESS',
  'FAILED',
  'CRASHED',
  'REMOVED',
  'SKIPPED',
]);

/** Set of statuses we treat as "success" — only SUCCESS qualifies. */
const HEALTHY_STATUSES = new Set<DeploymentStatus>(['SUCCESS']);

export interface WaitForDeploymentOptions {
  /** Max total wait in ms. Defaults to 60_000 (matches London's `wait-seconds: 60`). */
  timeoutMs?: number;
  /** Poll interval in ms. Defaults to 5_000. */
  pollIntervalMs?: number;
  /** Logger for progress updates. Defaults to `core.info`. */
  onPoll?: (snapshot: DeploymentSnapshot) => void;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep for tests. Defaults to real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll `deployment(id)` until status enters a terminal state, then resolve
 * (on SUCCESS) or throw an `ActionError` (on FAILED/CRASHED/REMOVED/SKIPPED).
 * On timeout, throw an `ActionError` with the last observed status.
 *
 * Used by `run.ts deployOrdered` after the first-service redeploy so we
 * confirm the deploy succeeded (and therefore release-phase migrations
 * finished) before touching the remaining services.
 */
export async function waitForDeployment(
  client: RailwayClient,
  deploymentId: string,
  opts: WaitForDeploymentOptions = {},
): Promise<DeploymentSnapshot> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const onPoll = opts.onPoll ?? defaultOnPoll;

  const started = now();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snapshot = await getDeploymentStatus(client, deploymentId);
    onPoll(snapshot);

    if (TERMINAL_STATUSES.has(snapshot.status)) {
      if (HEALTHY_STATUSES.has(snapshot.status)) {
        return snapshot;
      }
      // Terminal but not SUCCESS: fetch build logs and throw with context.
      const logs = await getBuildLogs(client, deploymentId);
      const detailsParts = [`Deployment: ${deploymentId}`, `Status: ${snapshot.status}`];
      if (logs !== '') detailsParts.push(`Build logs (last 100 lines):\n${logs}`);
      throw new ActionError(
        `Deployment ${deploymentId} ended in ${snapshot.status}`,
        detailsParts.join('\n'),
        'Inspect the Railway dashboard for the full deployment log.',
      );
    }

    if (now() - started >= timeoutMs) {
      throw new ActionError(
        `Deployment ${deploymentId} did not reach SUCCESS within ${timeoutMs}ms`,
        `Last status: ${snapshot.status} (after ${now() - started}ms)`,
        'Increase wait-seconds, or check the Railway dashboard for the running deploy.',
      );
    }

    await sleep(pollIntervalMs);
  }
}

function parseDeploymentSnapshot(raw: unknown, contextKey: string): DeploymentSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    throw new ActionError(
      `Railway returned no ${contextKey} field`,
      `Got: ${typeof raw}`,
      'The deployment status query did not return the expected shape.',
    );
  }
  // raw is either the deployment object itself (when called from getDeploymentStatus,
  // which receives graphql-request's unwrapped data) or the nested deployment object.
  const obj =
    contextKey === 'deployment'
      ? (raw as Record<string, unknown>).deployment
      : (raw as Record<string, unknown>);
  if (typeof obj !== 'object' || obj === null) {
    throw new ActionError(
      `Railway returned no ${contextKey} field`,
      `Got: ${JSON.stringify(raw).slice(0, 200)}`,
      'The deployment status query did not return the expected shape.',
    );
  }
  const o = obj as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id : null;
  const status = typeof o.status === 'string' ? (o.status as DeploymentStatus) : null;
  const createdAt = typeof o.createdAt === 'string' ? o.createdAt : '';
  if (id === null || status === null) {
    throw new ActionError(
      `Railway ${contextKey} response missing required fields`,
      `Got: ${JSON.stringify(o).slice(0, 200)}`,
      'The deployment status query did not return the expected shape.',
    );
  }
  return { id, status, createdAt };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultOnPoll(snapshot: DeploymentSnapshot): void {
  core.info(`  ⏳ Deployment ${snapshot.id} status: ${snapshot.status}`);
}
