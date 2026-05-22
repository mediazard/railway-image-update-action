# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — TBD

First release of the TypeScript implementation. The action is bundled to a single committed `dist/index.js` via `@vercel/ncc` and runs on `node20`.

### Inputs

- `api-token` (required) — Railway API token (account, workspace, or project).
- `token-type` — `bearer` (default) or `project`.
- `environment-id` (required) — Railway environment UUID.
- `image` (required) — Full Docker image URI with tag or digest.
- `services` (required) — Multiline `label:service_id` pairs.
- `first-service` — Label to deploy first (ordered flow). Default: `""`.
- `wait-seconds` — Seconds between first-service deploy and the rest. Default `30`, capped at `900`.
- `registry-username` / `registry-password` — Private registry credentials. Either both set or both empty.
- `resolve-to-digest` — Resolve the image to `@sha256:...` before deploy via `docker buildx imagetools inspect`. Default `true`. Requires `docker buildx` on the runner.
- `allow-mutable-tag` — When `resolve-to-digest: false`, allow deploying `:latest` / `:main` / etc. Default `false`.

### Outputs

- `deployed-services` — Comma-separated labels that deployed (always written, even on partial failure).
- `failed-services` — Labels that did NOT deploy.
- `image-tag` — Resolved image ref (digest-pinned when `resolve-to-digest: true`).
- `deployment-ids` — Multiline `label=id` pairs.

### Runtime behavior

- Sequential service iteration (input order). Never `Promise.all` — enforced by a `FakeRailwayClient` fixture that throws on concurrent calls and by an `@typescript-eslint/no-floating-promises` lint rule.
- Automatic retry on transient HTTP failures (429, 500, 502, 503, 504, network codes ENOTFOUND/ECONNRESET/ETIMEDOUT/etc.). 3 attempts, exponential backoff with jitter (~1–8s).
- Per-attempt request timeout (30s via `AbortController`). Worst case ~95s per operation with retries.
- Real `runs.post` cleanup: `docker logout` runs in the post step regardless of main outcome, via `core.saveState`.

### Hardening

- `core.setSecret` is called on `api-token` and `registry-password` BEFORE any other input read.
- `IMAGE_REF_PATTERN` rejects refs starting with `-`; every `docker` invocation uses `--` to terminate flags; stderr from `docker` is sanitized before being embedded in error details.
- `api-token`, `token-type`, `first-service`, `registry-username` reject control chars + `%` to defeat workflow-command injection through `core.info`.
- `npm ci` runs with `ignore-scripts=true` so a fork-PR lockfile change cannot execute postinstall hooks on the CI runner.
- All third-party actions in CI workflows pinned by SHA. Node patch pinned via `.node-version`. Bundle size budget gate at 2.5 MB.

### Tooling

- Test framework: `vitest@^4` + `@vitest/coverage-v8@^4`. 197 unit tests, ~93% line coverage, ~400ms test runtime.
- Defensive response handling: `redeploy()` extracts the deployment-id string from any of the known Railway response shapes (`"id"`, `null`, `true`) and degrades to `null` on anything unexpected — the deploy already succeeded server-side, so a response-shape surprise becomes a warning, not a failed workflow.
- `client.roundtrip.test.ts` exercises real `graphql-request` against `msw`-intercepted Railway responses captured from production.
