# Railway First-Service Deploy-Gate Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the ordered-mode first-service gate from failing healthy-but-slow deploys. The gate keys off Railway's own terminal verdict (`SUCCESS`/`FAILED`), backed by two **constant** timeouts (a transition-based "stuck" detector and a generous total cap). The `wait-seconds` input is **removed entirely**. Ships as **1.1.0** (maintainer decision — see the version note below).

**Background (confirmed):** Migrations run in the first service's **Railway pre-deploy command**, so a failed migration already makes the deployment `FAILED` (Railway won't promote it) and the action already aborts before touching the rest — that requirement is met by Railway, not by the timeout. The observed outage was different: the deploy *succeeded* but sat in `INITIALIZING` (app boot + healthcheck) past the 60s gate, which was 5× shorter than Railway's own 300s healthcheck window, so the action gave up on a perfectly healthy rollout.

**Architecture:** `run.ts:deployOrdered` redeploys `first-service`, then `operations.ts:waitForDeployment` polls `deployment(id).status` until a terminal state. This plan (1) classifies statuses at runtime (adding `INITIALIZING`/`REMOVING`) so a non-`SUCCESS` terminal state fails fast; (2) replaces the too-short, `wait-seconds`-driven total timeout with two **constants** — a transition/stall detector (`360_000ms`, above Railway's 300s healthcheck window) and a generous total cap (`600_000ms`); (3) bounds each status poll so retries can't silently eat the budget; (4) **removes the `wait-seconds` input**. On any timeout or terminal failure the gate throws and aborts — the remaining services are not deployed.

**Tech Stack:** TypeScript (CommonJS), Node 20, `@actions/core`, `graphql-request@7`, `p-retry@4`, `zod@3`, Vitest + `@vitest/coverage-v8`, bundled to `dist/index.js` via `@vercel/ncc`.

## Global Constraints

- **Node**: `>=20.18.1 <21` (`package.json engines`).
- **Version control**: Jujutsu (`jj`). Commit via `jj commit -m "<msg>"` — **never** `git commit`; **always** pass `-m` inline (a bare `jj commit`/`describe` opens an editor and blocks). `jj` auto-tracks the working copy — no `git add`.
- **Committed bundle**: CI (`.github/workflows/ci.yml:35-41`) runs `npm run bundle` then `git diff --quiet dist/` and FAILS if `dist/` is stale. The final task rebuilds and commits `dist/`.
- **Version: 1.1.0 (maintainer decision).** Removing the `wait-seconds` input is a consumer-facing change; per strict semver it would be a major bump, but this ships as a **minor (1.1.0)** by decision. Practical impact is soft: a workflow still passing `wait-seconds:` gets a harmless GitHub *"unexpected input"* warning and keeps running. The consuming workflow(s) should drop `wait-seconds:`.
- **No new inputs**: the gate timeout is intentionally NOT configurable. Both budgets are module-level constants.
- **Constants assume Railway's default healthcheck timeout (300s).** If any service raises `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` above ~300s, `GATE_STALL_TIMEOUT_MS` / `GATE_TOTAL_TIMEOUT_MS` must be revisited (documented in code + CHANGELOG).
- **Sequential Railway calls**: `operations.ts` must never issue concurrent `client.request()` calls; the `FakeRailwayClient` throws on overlap. Keep `for...of` + `await`; never `Promise.all`.
- **No `console.log`**: use `core.info` / `core.warning` / `core.debug` / `core.error`.
- **Defensive external parsing**: no zod on Railway responses (see `src/railway/operations.ts:25-53`); runtime narrowing on `unknown`.
- **Log-injection safety**: Railway-supplied strings in error `details` go through `sanitizeForLog` (already applied by `getBuildLogs` / `parseDeploymentSnapshot`); don't bypass.
- **Test command**: single file `npx vitest run <path>`; single test `npx vitest run <path> -t "<name>"`; full gate `npm run verify`.

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/railway/mutations.ts` | GraphQL ops + `DeploymentStatus` union | **Add** `INITIALIZING`, `REMOVING`. |
| `src/railway/operations.ts` | Deploy ops + `waitForDeployment` | **Add** `classifyStatus` + timeout constants; **rework** `waitForDeployment`; **add** retry-policy param to `getDeploymentStatus`; **remove** `TERMINAL_STATUSES`/`HEALTHY_STATUSES`. |
| `src/inputs/schema.ts` | Zod input schema | **Remove** the `waitSeconds` field. |
| `src/inputs/parse.ts` | `core.getInput` → `RawInputs` | **Remove** `waitSeconds` (interface field + read + return). |
| `src/run.ts` | Orchestrator | `deployOrdered` calls `waitForDeployment(client, deploymentId)`; drop `inputs.waitSeconds`. |
| `action.yml` | Action metadata | **Remove** the `wait-seconds` input. |
| `README.md`, `CHANGELOG.md` | Docs | Remove `wait-seconds`; document the constant gate. |
| Tests | run / operations / schema / parse / log-strings / phase-dispatch | Remove all `wait-seconds`/`waitSeconds` references; add classifier, timeout, stall, and abort-on-FAILED tests. |
| `dist/index.js` | Bundled action | Rebuilt in final task. |

---

## Task 1: Status classifier + widen `DeploymentStatus` union

**Files:**
- Modify: `src/railway/mutations.ts`, `src/railway/operations.ts`
- Test: `__tests__/railway/operations.test.ts` (append)

**Interfaces:**
- Produces: `classifyStatus(status: string): 'ready' | 'failed' | 'terminal-neutral' | 'progressing'` (exported from `operations.ts`) and the exported type `StatusClass`. `SUCCESS`→`ready`; `FAILED`/`CRASHED`→`failed`; `REMOVED`/`SKIPPED`/`SLEEPING`→`terminal-neutral`; `BUILDING`/`DEPLOYING`/`INITIALIZING`/`WAITING`/`QUEUED`/`REMOVING`→`progressing`; unknown→`progressing` (debug-logged).
- This task adds the function only; `waitForDeployment` still uses the existing sets until Task 2. No production behavior change yet.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/railway/operations.test.ts`:

```typescript
describe('classifyStatus', () => {
  it('maps Railway statuses to the four buckets (incl. INITIALIZING/REMOVING)', async () => {
    const { classifyStatus } = await import('../../src/railway/operations');
    expect(classifyStatus('SUCCESS')).toBe('ready');
    expect(classifyStatus('FAILED')).toBe('failed');
    expect(classifyStatus('CRASHED')).toBe('failed');
    expect(classifyStatus('REMOVED')).toBe('terminal-neutral');
    expect(classifyStatus('SKIPPED')).toBe('terminal-neutral');
    expect(classifyStatus('SLEEPING')).toBe('terminal-neutral');
    expect(classifyStatus('BUILDING')).toBe('progressing');
    expect(classifyStatus('DEPLOYING')).toBe('progressing');
    expect(classifyStatus('INITIALIZING')).toBe('progressing');
    expect(classifyStatus('WAITING')).toBe('progressing');
    expect(classifyStatus('QUEUED')).toBe('progressing');
    expect(classifyStatus('REMOVING')).toBe('progressing');
  });

  it('treats an unrecognized status as progressing (never misread as healthy)', async () => {
    const { classifyStatus } = await import('../../src/railway/operations');
    expect(classifyStatus('SOME_NEW_STATUS')).toBe('progressing');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run __tests__/railway/operations.test.ts -t "classifyStatus"`
Expected: FAIL — `classifyStatus` is not exported.

- [ ] **Step 3: Widen the union**

In `src/railway/mutations.ts`, replace the `DeploymentStatus` union (`mutations.ts:120-130`) with:

```typescript
export type DeploymentStatus =
  | 'BUILDING'
  | 'DEPLOYING'
  | 'INITIALIZING'
  | 'SUCCESS'
  | 'FAILED'
  | 'CRASHED'
  | 'REMOVED'
  | 'REMOVING'
  | 'SLEEPING'
  | 'SKIPPED'
  | 'WAITING'
  | 'QUEUED';
```

- [ ] **Step 4: Add `classifyStatus`**

In `src/railway/operations.ts`, add after the `HEALTHY_STATUSES` declaration (`operations.ts:301`) — leave the two sets in place for now:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run __tests__/railway/operations.test.ts -t "classifyStatus"`
Expected: PASS (2 tests). Also run the whole file: `npx vitest run __tests__/railway/operations.test.ts`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(operations): add classifyStatus + INITIALIZING/REMOVING statuses"
```

---

## Task 2: Constant, transition-aware gate in `waitForDeployment`

**Files:**
- Modify: `src/railway/operations.ts`
- Test: `__tests__/railway/operations.test.ts` (append)

**Interfaces:**
- Produces:
  - Exported constants `GATE_TOTAL_TIMEOUT_MS = 600_000`, `GATE_STALL_TIMEOUT_MS = 360_000`.
  - `getDeploymentStatus(client, id, signal?, retryPolicy?: Partial<RetryPolicy>)` — new optional 4th param threaded to `withRetry` (default preserves existing behavior).
  - `WaitForDeploymentOptions` gains `stallTimeoutMs?`. `timeoutMs` default becomes `GATE_TOTAL_TIMEOUT_MS`; `stallTimeoutMs` default `GATE_STALL_TIMEOUT_MS`. Callers may still inject small values (tests do).
  - `waitForDeployment` resolves on `SUCCESS`; throws `ActionError` (with build logs) on a `failed`/`terminal-neutral` status, on a stall (no status change for `stallTimeoutMs`), or on the total-cap timeout. The total-cap message keeps the substring `"did not reach SUCCESS"`.

**Context — why constants:** The SUCCESS/FAILED verdict normally comes from Railway itself (it fails a deploy that misses its 300s healthcheck window). The action's timeouts exist only so the GitHub job can't hang on a platform-level stall. `GATE_STALL_TIMEOUT_MS` (360s) sits above Railway's 300s healthcheck window so a legitimately slow `INITIALIZING` phase — one long no-transition phase — isn't killed; `GATE_TOTAL_TIMEOUT_MS` (600s) is the outer ceiling. Reducing in-gate poll retries to 1 and clamping the inter-poll sleep prevents a single slow status request from consuming the budget (`withRetry` default is up to 3 attempts × 30s ≈ 95s).

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/railway/operations.test.ts`:

```typescript
describe('getDeploymentStatus — retry policy override', () => {
  it('does not retry when the override sets retries: 0', async () => {
    const client = new FakeRailwayClient();
    let attempts = 0;
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      doc: string,
      vars: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') {
        attempts += 1;
        throw makeClientError(500); // retryable — would retry under the default policy
      }
      return orig<TVars, TResult>(doc, vars, opts);
    };
    await expect(getDeploymentStatus(client, 'd1', undefined, { retries: 0 })).rejects.toBeDefined();
    expect(attempts).toBe(1);
  });
});

describe('waitForDeployment — constant gate behavior', () => {
  function stuckClient(status: string): FakeRailwayClient {
    const client = new FakeRailwayClient();
    const orig = client.request.bind(client);
    client.request = async function <TVars, TResult>(
      doc: string,
      vars: TVars,
      opts?: { signal?: AbortSignal; operationName?: string },
    ): Promise<TResult> {
      if (opts?.operationName === 'deploymentStatus') {
        return { deployment: { id: 'd1', status, createdAt: 't' } } as TResult;
      }
      if (opts?.operationName === 'buildLogs') {
        return { buildLogs: [{ timestamp: 't', severity: 'INFO', message: 'still booting' }] } as TResult;
      }
      return orig<TVars, TResult>(doc, vars, opts);
    };
    return client;
  }

  it('throws ActionError with build logs on the total-cap timeout (still-progressing)', async () => {
    const client = stuckClient('INITIALIZING');
    let n = 0;
    try {
      await waitForDeployment(client, 'd1', {
        timeoutMs: 1000,
        stallTimeoutMs: 0, // disable stall so the total cap is what fires
        pollIntervalMs: 1,
        onPoll: () => undefined,
        sleep: () => Promise.resolve(),
        now: () => {
          const v = n;
          n += 600;
          return v;
        },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toContain('did not reach SUCCESS');
      expect((err as ActionError).details).toContain('still booting'); // build logs attached
      expect((err as ActionError).details).toContain('INITIALIZING'); // last status
    }
  });

  it('throws ActionError "stalled" when status is unchanged past stallTimeoutMs', async () => {
    const client = stuckClient('BUILDING');
    let n = 0;
    try {
      await waitForDeployment(client, 'd1', {
        timeoutMs: 100_000, // large — stall must fire first
        stallTimeoutMs: 1000,
        pollIntervalMs: 1,
        onPoll: () => undefined,
        sleep: () => Promise.resolve(),
        now: () => {
          const v = n;
          n += 600;
          return v;
        },
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ActionError);
      expect((err as ActionError).message).toContain('stalled');
      expect((err as ActionError).message).toContain('BUILDING');
    }
  });

  it('does not stall while the deployment keeps transitioning, and resolves on SUCCESS', async () => {
    const client = statusSequenceClient(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS']);
    const snap = await waitForDeployment(client, 'd1', {
      timeoutMs: 100_000,
      stallTimeoutMs: 10, // tiny, but each poll transitions so it resets
      pollIntervalMs: 1,
      onPoll: () => undefined,
      sleep: () => Promise.resolve(),
    });
    expect(snap.status).toBe('SUCCESS');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run __tests__/railway/operations.test.ts -t "constant gate behavior"`
Run: `npx vitest run __tests__/railway/operations.test.ts -t "retry policy override"`
Expected: FAIL — `getDeploymentStatus` has no 4th param; `stallTimeoutMs` is ignored; timeout details carry no build logs.

- [ ] **Step 3: Add the retry import + retry param to `getDeploymentStatus`**

In `src/railway/operations.ts`, change the retry import (`import { withRetry } from './retry';`) to:

```typescript
import { withRetry, type RetryPolicy } from './retry';
```

Replace `getDeploymentStatus` (`operations.ts:189-202`) with:

```typescript
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
```

- [ ] **Step 4: Add the constants and rework `waitForDeployment`**

In `src/railway/operations.ts`, **delete** the two sets (`operations.ts:291-301`):

```typescript
// DELETE:
const TERMINAL_STATUSES = new Set<DeploymentStatus>([...]);
const HEALTHY_STATUSES = new Set<DeploymentStatus>(['SUCCESS']);
```

Add the constants where they were:

```typescript
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
 */
export const GATE_STALL_TIMEOUT_MS = 360_000;

/**
 * Absolute wall-clock ceiling for the first-service gate. Generous and
 * NOT configurable — a normal deploy resolves to SUCCESS/FAILED via Railway
 * well before this; it only fires if the deploy keeps flapping without ever
 * reaching a terminal state.
 */
export const GATE_TOTAL_TIMEOUT_MS = 600_000;
```

Update the `WaitForDeploymentOptions` interface: change the `timeoutMs` doc/default note and add `stallTimeoutMs`:

```typescript
  /** Max total wait in ms. Defaults to GATE_TOTAL_TIMEOUT_MS (600s). */
  timeoutMs?: number;
  /** Poll interval in ms. Defaults to 5_000. */
  pollIntervalMs?: number;
  /**
   * Fail fast if the status doesn't change for this many ms while progressing.
   * Defaults to GATE_STALL_TIMEOUT_MS (360s). Set 0 to disable (tests).
   */
  stallTimeoutMs?: number;
```

Replace the body of `waitForDeployment` (the `const timeoutMs = …` locals through the end of the `while` loop, `operations.ts:341-381`) with:

```typescript
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
    const snapshot = await getDeploymentStatus(client, deploymentId, signal, { retries: 1 });
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
```

Add these two helpers at the end of `src/railway/operations.ts` (after `defaultOnPoll`):

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run __tests__/railway/operations.test.ts`
Expected: PASS — new tests plus the pre-existing suite. The legacy "throws ActionError on timeout" test still passes (message keeps "did not reach SUCCESS", still an `ActionError`, and its `statusSequenceClient` answers `buildLogs` with `[]`). FAILED/CRASHED tests still throw `ended in FAILED`/`CRASHED`.

- [ ] **Step 6: Commit**

```bash
jj commit -m "feat(operations): constant transition-aware gate (600s cap + 360s stall) with bounded polls"
```

---

## Task 3: Remove the `wait-seconds` input (source + tests)

**Files:**
- Modify: `src/inputs/schema.ts`, `src/inputs/parse.ts`, `src/run.ts`
- Test: `__tests__/run.test.ts`, `__tests__/inputs/schema.test.ts`, `__tests__/inputs/parse.test.ts`, `__tests__/log-strings.test.ts`, `__tests__/main.phase-dispatch.test.ts`

**Interfaces:** `ActionInputs` no longer has `waitSeconds`; `RawInputs` no longer has `waitSeconds`. `deployOrdered` calls `waitForDeployment(client, deploymentId)` (constant defaults). A first-service timeout/terminal-failure throws and aborts before Steps 2/3 (unchanged control flow — just no timeout wiring).

- [ ] **Step 1: Add the new run-level test + strip `waitSeconds` from run tests**

In `__tests__/run.test.ts`:
- Update the header-comment bullet (`run.test.ts:12`) `- waitSeconds=0 doesn't actually block.` → `- first-service FAILED aborts and skips the rest.`
- Remove `waitSeconds: 30,` from `makeInputs` (`run.test.ts:72`).
- In the ordered happy test, change `makeInputs({ services, firstService: 'web', waitSeconds: 0 })` (`run.test.ts:156`) → `makeInputs({ services, firstService: 'web' })`.
- Delete the whole `it('waitSeconds=0 means the ordered path does not block measurably', …)` test (`run.test.ts:177-191`).
- Remove the `waitSeconds: 0,` line from the `first-service not in services` test's overrides (`run.test.ts:204`).
- Add this test inside `describe('run — ordered path (first-service set)', …)` (fast — `FAILED` is terminal):

```typescript
it('aborts and does NOT deploy the rest when first-service ends in FAILED', async () => {
  const services = new Map<string, string>([
    ['web', A_UUID],
    ['worker', B_UUID],
  ]);
  const c = new FakeRailwayClient();
  c.setResponse('updateImage', { response: { serviceInstanceUpdate: { id: 'u' } } });
  c.setResponse('deployService', { response: { serviceInstanceDeployV2: 'deploy-id-x' } });
  c.setResponse('deploymentStatus', {
    response: { deployment: { id: 'deploy-id-x', status: 'FAILED', createdAt: 't' } },
  });
  c.setResponse('buildLogs', { response: { buildLogs: [] } });
  const inputs = makeInputs({ services, firstService: 'web' });
  const state = new DeployState(Array.from(inputs.services.keys()));

  await expect(run({ client: c, execFn: makeExecFn(), inputs, state })).rejects.toBeInstanceOf(
    ActionError,
  );
  expect(state.deployedLabels()).not.toContain('worker');
});
```

- [ ] **Step 2: Strip `waitSeconds` from the input-layer tests**

In `__tests__/inputs/schema.test.ts`:
- Remove `waitSeconds: '30',` from `makeRawInputs` (`schema.test.ts:28`).
- Remove `expect(result.data.waitSeconds).toBe(30);` (`schema.test.ts:103`).
- Delete both `wait-seconds` validation tests: `it('non-integer wait-seconds → …')` (`schema.test.ts:205-208`) and `it('wait-seconds over the 900 cap → …')` (`schema.test.ts:210-213`).

In `__tests__/inputs/parse.test.ts`:
- Remove `'wait-seconds': string;` from `InputsBundle` (`parse.test.ts:33`).
- Remove `'wait-seconds': '30',` from `stringDefaults` (`parse.test.ts:58`).
- Remove `expect(inputs.waitSeconds).toBe(30);` (`parse.test.ts:100`).

In `__tests__/log-strings.test.ts`:
- Remove `waitSeconds: 30,` (`log-strings.test.ts:64`).
- Remove the `waitSeconds: 0` override at `log-strings.test.ts:117` (keep the rest of that `makeInputs({ services, firstService: 'web' })` call).

In `__tests__/main.phase-dispatch.test.ts` (these mock a now-removed input; remove for cleanliness — harmless if left since the code no longer queries it):
- Remove the `case 'wait-seconds':` arm and its `return` line (`main.phase-dispatch.test.ts:82`).
- Remove `if (name === 'wait-seconds') return '30';` (`main.phase-dispatch.test.ts:200`).

- [ ] **Step 3: Run the suite to see the red baseline**

Run: `npx vitest run`
Expected: FAIL — the source still declares `waitSeconds`, so `run.ts`/type references and the removed-assertion mismatch produce failures. (Confirms a red baseline before the source edit.)

- [ ] **Step 4: Remove `waitSeconds` from the schema**

In `src/inputs/schema.ts`, delete the `waitSeconds` field (`schema.ts:135-140`):

```typescript
// DELETE this whole property:
    waitSeconds: z.coerce
      .number({ invalid_type_error: 'wait-seconds must be a non-negative integer' })
      .int('wait-seconds must be a non-negative integer')
      .nonnegative('wait-seconds must be a non-negative integer')
      .max(900, 'wait-seconds must not exceed 900 (15 min)')
      .default(30),
```

Update the schema doc comment (`schema.ts:112-116`): "all 11 action inputs" → "all 10 action inputs".

- [ ] **Step 5: Remove `waitSeconds` from parse**

In `src/inputs/parse.ts`: delete `waitSeconds: string;` from `RawInputs` (`parse.ts:18`), the `const waitSeconds = core.getInput('wait-seconds');` read (`parse.ts:56`), and `waitSeconds,` from the returned object (`parse.ts:71`).

- [ ] **Step 6: Remove `waitSeconds` wiring from `run.ts`**

In `src/run.ts`, replace the gate block (`run.ts:150-182`, from the `// Confirm SUCCESS …` comment through `core.info('')`) with:

```typescript
  // Confirm SUCCESS before letting the remaining services roll forward.
  // If first-service runs release-phase migrations (via Railway's pre-deploy
  // command), a failed migration marks this deployment FAILED and we abort
  // here — the remaining services are NOT deployed. The gate's timeouts are
  // fixed constants (see GATE_STALL_TIMEOUT_MS / GATE_TOTAL_TIMEOUT_MS) that
  // sit above Railway's 300s healthcheck window, so Railway's own
  // SUCCESS/FAILED verdict decides the normal case.
  let deploymentId = firstResult.deploymentId;
  if (deploymentId === null) {
    const latest = await getLatestDeploymentForService(client, {
      serviceId: firstId,
      environmentId: inputs.environmentId,
    });
    if (latest === null) {
      throw new ActionError(
        `Cannot confirm [${firstLabel}] deploy — Railway returned no deployment id`,
        `Railway returned: ${sanitizeForLog(JSON.stringify(firstResult.rawValue) ?? 'undefined')}`,
        'Refusing to deploy the remaining services without confirmation. Check the Railway dashboard.',
      );
    }
    deploymentId = latest.id;
    core.info(`  ↪ Recovered deployment id via serviceInstance fallback: ${deploymentId}`);
  }

  core.info(`  ⏳ Waiting for [${firstLabel}] to reach SUCCESS...`);
  await waitForDeployment(client, deploymentId);
  core.info(`  ✓ [${firstLabel}] deployment confirmed`);
  state.markDeployed(firstLabel);
  core.info('');
```

(Preserves the `deploymentId === null` fallback exactly; only removes the `timeoutMs: inputs.waitSeconds * 1000` argument and the stale comment.)

- [ ] **Step 7: Run the full suite + grep to confirm removal is complete**

Run: `npx vitest run`
Run: `grep -rn "waitSeconds\|wait-seconds" src/ __tests__/`
Expected: tests PASS; grep returns **nothing**. If grep finds a stray reference, remove it and re-run.

- [ ] **Step 8: Commit**

```bash
jj commit -m "feat: remove wait-seconds input; gate uses constant timeouts"
```

---

## Task 4: Update `action.yml` + docs

**Files:** `action.yml`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Remove the input from `action.yml`**

Delete the `wait-seconds` input block (`action.yml:30-33`):

```yaml
# DELETE:
  wait-seconds:
    description: "Seconds to wait after first-service redeploys before deploying the rest"
    required: false
    default: "30"
```

- [ ] **Step 2: Update `README.md`**

- Remove the `wait-seconds: "60"` line from the example (`README.md:59`).
- Remove the `wait-seconds` row from the Inputs table (`README.md:104`).
- Rewrite the "With `first-service` (3-step flow)" step that says "Wait `wait-seconds`" (`README.md:131`) to:

```markdown
2. Wait for `first-service` to reach `SUCCESS` (Railway's own verdict). A `FAILED`/`CRASHED` deploy — including a failed pre-deploy migration — aborts here and the remaining services are NOT deployed. The wait is bounded by internal constants (≈360s no-progress stall / ≈600s total), set above Railway's 300s healthcheck window; they only trip on a stuck deploy or platform delay.
```

- Add a Troubleshooting row:

```markdown
| `did not reach SUCCESS within Nms` / `stalled in <status>` | first-service didn't reach a terminal state before the internal cap (stuck deploy or Railway platform delay) | Check the Railway dashboard. If your service legitimately needs >300s to pass its healthcheck, raise `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` on the service AND revisit the gate constants in `src/railway/operations.ts`. |
```

- [ ] **Step 3: Update `CHANGELOG.md`**

Under `## [Unreleased]` add (this is a **minor** release, 1.1.0):

```markdown
### Removed

- **`wait-seconds` input.** The first-service gate is no longer configurable. Remove `wait-seconds:` from your workflow — a leftover value is ignored with a harmless GitHub "unexpected input" warning. Shipped as a minor (1.1.0) by maintainer decision.

### Changed

- The first-service gate now uses two internal constants instead of `wait-seconds`: a transition-based stall detector (~360s of no status progress) and a total wall-clock cap (~600s), both set **above Railway's default 300s healthcheck window**. Railway's own `SUCCESS`/`FAILED` verdict decides the normal case; the constants only guard against a platform-level hang. A first-service `FAILED`/`CRASHED` (including a failed pre-deploy migration) still aborts and does not deploy the rest.
- Status polling reduces in-gate retries and clamps the inter-poll sleep so a single slow status request can't consume the budget. Non-`SUCCESS` terminal statuses (`SLEEPING`/`REMOVED`/`SKIPPED`) now fail fast; `INITIALIZING`/`REMOVING` are modeled explicitly.
- Constants assume Railway's default 300s healthcheck window — documented in `src/railway/operations.ts`.
```

- [ ] **Step 4: Commit**

```bash
jj commit -m "docs: remove wait-seconds; document constant gate (1.1.0)"
```

---

## Task 5: Rebuild `dist/` + full verification + final commit

**Files:** `dist/index.js` (+ map/license as the bundler produces)

- [ ] **Step 1: Full local gate**

Run: `npm run verify`
Expected: typecheck + lint + all tests + bundle + size, all green. Fix any failure before committing.

- [ ] **Step 2: Rebuild and confirm the bundle changed**

Run: `npm run bundle`
Run: `git status --short dist/`
Expected: `dist/index.js` (and map) show modified.

- [ ] **Step 3: Verify dist freshness the way CI does**

Run: `npm run bundle && git diff --quiet dist/ && echo "dist is fresh"`
Expected: prints `dist is fresh` (exit 0).

- [ ] **Step 4: Commit the bundle**

```bash
jj commit -m "chore(dist): rebuild bundle for constant deploy-gate"
```

- [ ] **Step 5: Final confirmation**

Run: `npm run verify`
Expected: green — the state a 1.1.0 PR opens from.

---

## Self-Review

**Spec coverage (against the locked decision — remove `wait-seconds`, ship as 1.1.0; constant 600s cap + transition-based stall + terminal-status-decides):**
- Remove the input → Task 3 (schema + parse + run.ts + all test references) and Task 4 (action.yml + docs). Versioned 1.1.0 (CHANGELOG "Removed").
- Constant 600s total cap → `GATE_TOTAL_TIMEOUT_MS` (Task 2).
- Transition-based stall detector anchored to Railway's 300s healthcheck window → `GATE_STALL_TIMEOUT_MS = 360_000` (Task 2).
- Terminal-status-decides + migration-fail handled by pre-deploy → classifier (Task 1) + `run.ts` throws/aborts + FAILED-aborts-rest test (Task 3).
- Poll bounding (no ~95s-in-budget amplifier) → retries:1 + `sleepClamped` (Task 2).
- **Dropped** (per decisions): `on-gate-timeout`/`stall-timeout-seconds` inputs, `DeploymentTimeoutError`, `timed-out-services` output, `DeployState.markTimedOut`, "raise the default," and the keep-but-deprecate approach.

**Type consistency:** `classifyStatus(status: string): StatusClass` (Task 1) used in `waitForDeployment` (Task 2). `getDeploymentStatus(client, id, signal?, retryPolicy?)` — 4th param optional/additive; existing call sites unaffected. `GATE_TOTAL_TIMEOUT_MS`/`GATE_STALL_TIMEOUT_MS` defined in Task 2, consumed as `waitForDeployment` defaults; `run.ts` (Task 3) calls `waitForDeployment(client, deploymentId)`. `waitSeconds` fully removed from `ActionInputs`/`RawInputs` and every reference (verified by the Step-7 grep).

**Placeholder scan:** none — every code/edit step shows concrete content or exact line references from the current files.

**Version note:** removing an input is, by strict semver, a breaking change; it ships as **1.1.0** by maintainer decision. Practical impact is soft (a workflow still passing `wait-seconds:` gets a harmless GitHub "unexpected input" warning). After merge, remove `wait-seconds:` from the consuming workflow(s). Constants assume Railway's default 300s healthcheck; if a service raises `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`, bump `GATE_STALL_TIMEOUT_MS`/`GATE_TOTAL_TIMEOUT_MS`.

**Known residual limitation (unchanged, accepted):** for a genuinely destructive/non-backward-compatible migration, old still-running services hit the new schema the moment the pre-deploy migration completes — the gate can't prevent that (only expand/contract discipline or a quiesce→migrate→restart window can). Out of scope for this plan.
