# Railway Image Update Action

## Commands

- Typecheck: `npm run typecheck` (`tsc --noEmit`)
- Lint: `npm run lint` (eslint + prettier --check)
- Autofix lint/format: `npm run lint:fix`
- Run tests: `npm test` (vitest run with coverage)
- Watch tests: `npm run test:watch`
- Bundle to `dist/`: `npm run bundle` (ncc build of `src/main.ts`)
- Full gate (CI parity): `npm run verify` (typecheck + lint + test + bundle + size)
- Smoke-load the bundle: `npm run smoke`

## Version Control

This project uses **Jujutsu (jj)** instead of raw git for commits.

- `jj status` — check working copy status
- `jj commit -m "message"` — create a commit
- `jj log` — view commit history

Do NOT use `git commit` directly.

## Architecture

TypeScript GitHub Action running on `node20`, bundled to a single committed
`dist/index.js` via `@vercel/ncc`. No bash. `action.yml` points `main`/`post`
at `dist/index.js`; the entry module is `src/main.ts`, which delegates to
`src/run.ts`.

Flow (`src/run.ts`):
1. Read raw inputs from `@actions/core` (`src/inputs/parse.ts`)
2. Validate + coerce them with a zod schema (`src/inputs/schema.ts`)
3. Optionally resolve the image tag to a content-addressed digest
   (`src/image/digest.ts`); reject mutable tags unless allowed
   (`src/image/mutable.ts`)
4. Update the image source on all services via the Railway GraphQL API
5. If `first-service` is set: redeploy it, **gate on it reaching `SUCCESS`**
   (`waitForDeployment` in `src/railway/operations.ts`), then update + redeploy
   the rest. If not set: update all, then redeploy all
6. Write outputs (`src/outputs/writer.ts`), tracking per-service state
   (`src/outputs/state.ts`) so partial failures still report

## Key Files

- `action.yml` — Action metadata, inputs/outputs, `node20`/`dist` wiring
- `src/main.ts` — Entry point; top-level error mapping
- `src/run.ts` — Orchestration (`deployOrdered` / `deployParallel`, the gate)
- `src/inputs/parse.ts` — Read raw inputs from core
- `src/inputs/schema.ts` — Zod schema; per-field error messages
- `src/railway/client.ts` — GraphQL transport
- `src/railway/mutations.ts` — GraphQL docs + typed variables, `DeploymentStatus`
- `src/railway/operations.ts` — Image update, redeploy, build logs, deploy gate
- `src/railway/retry.ts` — `withRetry` (p-retry) + `isRetryableError`
- `src/railway/dry-run.ts` — Dry-run path (no live API calls)
- `src/image/{digest,mutable}.ts` — Digest resolution + mutable-tag guard
- `src/outputs/{state,writer}.ts` — Deploy state + `$GITHUB_OUTPUT` writer
- `src/errors.ts` — `ActionError`, `mapToActionError`
- `src/log-sanitize.ts` — `sanitizeForLog` (strips workflow-command injection)
- `dist/index.js` — Bundled output; **must be rebuilt and committed** on any src change
- `__tests__/` — Vitest suites mirroring `src/`

## Conventions

- Pure TypeScript, strict mode; deps declared in `package.json`
- Validate all inputs with zod (`ActionInputsSchema`); never trust raw strings
- Errors: `throw new ActionError(message, details, hint)` — caught + surfaced by `mapToActionError`
- Wrap every live GraphQL call in `withRetry()` (retries 429/5xx + network codes only)
- Sanitize anything echoed to logs with `sanitizeForLog()` (build logs, user input)
- Immutable updates (spread), async/await + try-catch

## Gotchas

- **Rebuild `dist/` after any `src/` change** (`npm run bundle`) and commit it —
  GitHub runs the bundle, not `src/`. A stale `dist/` ships old behavior silently.
- The first-service deploy gate is **fail-closed**: only `SUCCESS` proceeds;
  unknown statuses are treated as `progressing` and never as healthy.
- Gate timeouts are fixed constants (`GATE_STALL_TIMEOUT_MS` / `GATE_TOTAL_TIMEOUT_MS`)
  set above Railway's 300s healthcheck window; Railway's own verdict decides the normal case.
- Poll clock is monotonic (`performance.now()`); the inter-poll sleep is clamped to the remaining budget.
- Registry credentials: username and password must both be present or both absent.
- Digest resolution is on by default; a mutable tag with `resolve-to-digest: false` fails unless `allow-mutable-tag: true`.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `api-token` | Yes | Railway API token (account, workspace, or project) |
| `token-type` | No | `bearer` (default) or `project` |
| `environment-id` | Yes | Railway environment ID (UUID) |
| `image` | Yes | Full Docker image URI with tag or digest |
| `services` | Yes | Multiline `label:service_id` pairs |
| `first-service` | No | Label to redeploy first; gated on `SUCCESS` (default: `""`) |
| `registry-username` | No | Private registry username (with password) |
| `registry-password` | No | Private registry password (with username) |
| `resolve-to-digest` | No | Resolve tag to a content-addressed digest (default: `true`) |
| `allow-mutable-tag` | No | Allow a mutable tag when `resolve-to-digest` is false (default: `false`) |

## Outputs

- `deployed-services` — Comma-separated deployed service labels (always written)
- `failed-services` — Comma-separated labels not deployed (empty on full success)
- `image-tag` — Resolved image ref (digest-pinned when `resolve-to-digest` is true)
- `deployment-ids` — Newline-separated `label=deployment-id` pairs
