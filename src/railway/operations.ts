import * as core from '@actions/core';

import { ActionError } from '../errors';
import { sanitizeForLog } from '../log-sanitize';
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
import { withRetry, isRetryableError, type RetryPolicy } from './retry';

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
  signal?: AbortSignal,
  retryPolicy?: Partial<RetryPolicy>,
): Promise<DeploymentSnapshot> {
  const raw = await withRetry<unknown>(
    () =>
      client.request<DeploymentStatusVariables, unknown>(
        DEPLOYMENT_STATUS_QUERY,
        { id },
        { operationName: 'deploymentStatus', signal },
      ),
    retryPolicy,
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
  signal?: AbortSignal,
): Promise<DeploymentSnapshot | null> {
  const raw = await withRetry<unknown>(() =>
    client.request<ServiceInstanceLatestDeploymentVariables, unknown>(
      SERVICE_INSTANCE_LATEST_DEPLOYMENT_QUERY,
      { sid: args.serviceId, eid: args.environmentId },
      { operationName: 'serviceInstanceLatestDeployment', signal },
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

/**
 * Cap on total build-log bytes returned. Build logs flow into
 * `ActionError.details` → `core.info`, and GitHub Actions has a
 * per-line/per-job log budget. A noisy or hostile build (which can also
 * contain env-var dumps from failed CI scripts) shouldn't be able to push
 * arbitrarily large output into our error payload.
 */
const BUILD_LOG_MAX_BYTES = 16 * 1024;

/**
 * Get build logs for a failed deployment. Best-effort — swallows request
 * errors and returns `''` rather than throwing.
 *
 * Each line is sanitized for workflow-command injection (`::add-mask::` /
 * `::set-output::` would otherwise be interpreted by the runner if logged
 * via `core.info`), CRs are stripped, and the total joined output is
 * truncated to `BUILD_LOG_MAX_BYTES`. The truncated portion is replaced
 * by a clearly-marked elision marker so log readers can tell.
 */
export async function getBuildLogs(
  client: RailwayClient,
  id: string,
  limit = 100,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const raw = await withRetry<unknown>(() =>
      client.request<BuildLogsVariables, unknown>(
        BUILD_LOGS_QUERY,
        { id, limit },
        { operationName: 'buildLogs', signal },
      ),
    );
    if (typeof raw !== 'object' || raw === null) return '';
    const logs = (raw as Record<string, unknown>).buildLogs;
    if (!Array.isArray(logs)) return '';
    const joined = logs
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) return '';
        const e = entry as Record<string, unknown>;
        const ts = typeof e.timestamp === 'string' ? e.timestamp : '';
        const sev = typeof e.severity === 'string' ? e.severity : '';
        const msg = typeof e.message === 'string' ? e.message : '';
        // Sanitize WITHIN each entry so per-line CR/LF in `msg` can't
        // smuggle a `\n::add-mask::SECRET` past the runner. Newlines BETWEEN
        // entries (our own `\n` separator below) are preserved.
        return sanitizeForLog(`${ts} ${sev} ${msg}`).trim();
      })
      .filter((line) => line !== '')
      .join('\n');
    if (joined.length <= BUILD_LOG_MAX_BYTES) return joined;
    return `${joined.slice(0, BUILD_LOG_MAX_BYTES)}\n…[truncated ${joined.length - BUILD_LOG_MAX_BYTES} bytes]`;
  } catch {
    return '';
  }
}

/**
 * Railway's default healthcheck window (docs: 300s). Railway fails a deploy
 * that doesn't serve 200 within this window, so it — not this action — is the
 * authority on SUCCESS/FAILED. Our timeouts below sit ABOVE it and exist only
 * so the GitHub job can't hang on a platform-level stall.
 */
export const RAILWAY_HEALTHCHECK_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Fail fast if the deployment makes NO status progress for this long (a stuck
 * deploy / platform hang). Set above Railway's 300s healthcheck window (+60s
 * headroom) so a legitimately slow INITIALIZING phase — one long no-transition
 * phase — isn't killed.
 *
 * Caveat: this bounds ANY progressing phase with an unchanged status, not just
 * the healthcheck. A very large image over a slow registry can sit in
 * BUILDING/INITIALIZING (status unchanged, build logs advancing) for a while;
 * if that single phase exceeds 360s the gate false-fails a healthy deploy. Low
 * risk here because we deploy pre-built images, but if it bites, raise this
 * constant rather than disabling the stall — do NOT infer progress from logs.
 */
export const GATE_STALL_TIMEOUT_MS = 360_000;

/**
 * Absolute wall-clock ceiling for the first-service gate. Generous and
 * NOT configurable — a normal deploy resolves to SUCCESS/FAILED via Railway
 * well before this; it only fires if the deploy keeps flapping without ever
 * reaching a terminal state.
 */
export const GATE_TOTAL_TIMEOUT_MS = 600_000;

/** Bucket a Railway deployment status for the poll loop. */
export type StatusClass = 'ready' | 'failed' | 'terminal-neutral' | 'progressing';

/**
 * Classify a Railway deployment status. Exhaustive and intentional: an
 * unrecognized status is treated as `progressing` (keep polling) so a status
 * Railway invents can never be silently misread as healthy. `SLEEPING`,
 * `REMOVED`, and `SKIPPED` are terminal-but-not-success (`terminal-neutral`) —
 * they'll never reach SUCCESS by polling, so we fail fast rather than burn the
 * whole wait budget.
 */
export function classifyStatus(status: string): StatusClass {
  switch (status) {
    case 'SUCCESS':
      return 'ready';
    case 'FAILED':
    case 'CRASHED':
      return 'failed';
    case 'REMOVED':
    case 'SKIPPED':
    case 'SLEEPING':
      return 'terminal-neutral';
    case 'BUILDING':
    case 'DEPLOYING':
    case 'INITIALIZING':
    case 'WAITING':
    case 'QUEUED':
    case 'REMOVING':
      return 'progressing';
    default:
      core.debug(`Unrecognized Railway deployment status '${status}' — treating as progressing`);
      return 'progressing';
  }
}

export interface WaitForDeploymentOptions {
  /** Max total wait in ms. Defaults to GATE_TOTAL_TIMEOUT_MS (600s). */
  timeoutMs?: number;
  /** Poll interval in ms. Defaults to 5_000. */
  pollIntervalMs?: number;
  /**
   * Fail fast if the status doesn't change for this many ms while progressing.
   * Defaults to GATE_STALL_TIMEOUT_MS (360s). Set 0 to disable (tests).
   */
  stallTimeoutMs?: number;
  /** Logger for progress updates. Defaults to `core.info`. */
  onPoll?: (snapshot: DeploymentSnapshot) => void;
  /**
   * Injectable clock for tests. Defaults to `performance.now` — MONOTONIC,
   * so an NTP backward wall-clock jump can't extend the loop past the
   * configured `timeoutMs`, and a forward jump can't fire it early.
   */
  now?: () => number;
  /** Injectable sleep for tests. Defaults to real `setTimeout`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * Cancellation. When the signal aborts, the polling loop exits at its
   * next iteration (or wakes from `sleep`) and rethrows the abort reason.
   * In-flight GraphQL requests are also cancelled (their `requestTimeoutMs`
   * window is collapsed).
   */
  signal?: AbortSignal;
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
  const timeoutMs = opts.timeoutMs ?? GATE_TOTAL_TIMEOUT_MS;
  const stallTimeoutMs = opts.stallTimeoutMs ?? GATE_STALL_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? 5_000;
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? defaultSleep;
  const onPoll = opts.onPoll ?? defaultOnPoll;
  const { signal } = opts;

  const started = now();
  let lastStatus: string | null = null;
  let lastTransitionAt = started;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    signal?.throwIfAborted();
    // One retry (not the default two): a single poll must not spend the budget.
    let snapshot: DeploymentSnapshot;
    try {
      snapshot = await getDeploymentStatus(client, deploymentId, signal, { retries: 1 });
    } catch (err) {
      // A transient status-query failure (a retryable HTTP/network error whose
      // single in-poll retry also failed) must NOT abort the gate: the running
      // deployment is independent of our ability to read its status, and the
      // loop's own cadence would otherwise absorb the blip. Count the failed
      // poll toward the total budget and re-poll. A permanent error (auth, 4xx,
      // deployment-not-found) is NOT retryable and still aborts fast.
      if (signal?.aborted || !isRetryableError(err)) throw err;
      const elapsed = now() - started;
      if (elapsed >= timeoutMs) {
        throw await gateError(
          client,
          deploymentId,
          `Deployment ${deploymentId} did not reach SUCCESS within ${elapsed}ms`,
          `Last status: ${lastStatus ?? 'unknown'} (status polling kept failing, after ${elapsed}ms)`,
          "The deploy's status could not be read before the cap. Check the Railway dashboard.",
          signal,
        );
      }
      core.info('  ⚠ Status poll failed transiently; retrying on the next poll interval');
      core.debug(`  poll error: ${err instanceof Error ? err.message : String(err)}`);
      await sleepClamped(sleep, pollIntervalMs, elapsed, timeoutMs, signal);
      continue;
    }
    onPoll(snapshot);

    if (snapshot.status !== lastStatus) {
      lastStatus = snapshot.status;
      lastTransitionAt = now();
    }

    const klass = classifyStatus(snapshot.status);
    if (klass === 'ready') {
      return snapshot;
    }
    if (klass !== 'progressing') {
      // failed OR terminal-neutral — will never reach SUCCESS by polling.
      throw await gateError(
        client,
        deploymentId,
        `Deployment ${deploymentId} ended in ${snapshot.status}`,
        `Status: ${snapshot.status}`,
        'Inspect the Railway dashboard for the full deployment log.',
        signal,
      );
    }

    // progressing — check stall (no status change) then the total cap.
    const sinceTransition = now() - lastTransitionAt;
    if (stallTimeoutMs > 0 && sinceTransition >= stallTimeoutMs) {
      throw await gateError(
        client,
        deploymentId,
        `Deployment ${deploymentId} stalled in ${snapshot.status}`,
        `Status ${snapshot.status} unchanged for ${sinceTransition}ms`,
        'The deployment made no progress. Check the Railway dashboard for the running deploy.',
        signal,
      );
    }

    const elapsed = now() - started;
    if (elapsed >= timeoutMs) {
      throw await gateError(
        client,
        deploymentId,
        `Deployment ${deploymentId} did not reach SUCCESS within ${elapsed}ms`,
        `Last status: ${snapshot.status} (after ${elapsed}ms)`,
        "The deploy is stuck or the Railway platform is delayed (Railway's healthcheck window is 300s by default). Check the Railway dashboard.",
        signal,
      );
    }

    await sleepClamped(sleep, pollIntervalMs, elapsed, timeoutMs, signal);
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
      `Got: ${sanitizeForLog(JSON.stringify(raw)).slice(0, 200)}`,
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
      `Got: ${sanitizeForLog(JSON.stringify(o)).slice(0, 200)}`,
      'The deployment status query did not return the expected shape.',
    );
  }
  return { id, status, createdAt };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function defaultOnPoll(snapshot: DeploymentSnapshot): void {
  core.info(`  ⏳ Deployment ${snapshot.id} status: ${snapshot.status}`);
}

/**
 * Build an ActionError for a gate failure/timeout, attaching build logs
 * (best-effort) so a deploy that failed server-side surfaces its logs.
 */
async function gateError(
  client: RailwayClient,
  deploymentId: string,
  message: string,
  statusLine: string,
  hint: string,
  signal?: AbortSignal,
): Promise<ActionError> {
  const logs = await getBuildLogs(client, deploymentId, 100, signal);
  const detailsParts = [`Deployment: ${deploymentId}`, statusLine];
  if (logs !== '') detailsParts.push(`Build logs (last 100 lines):\n${logs}`);
  return new ActionError(message, detailsParts.join('\n'), hint);
}

/**
 * Sleep for the poll interval, clamped to the remaining budget so the loop
 * never oversleeps past the deadline.
 */
function sleepClamped(
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  pollIntervalMs: number,
  elapsedMs: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const remaining = timeoutMs - elapsedMs;
  const ms = remaining > 0 ? Math.min(pollIntervalMs, remaining) : 0;
  return sleep(ms, signal);
}
