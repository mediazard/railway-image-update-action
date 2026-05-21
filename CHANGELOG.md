# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — TBD

### TypeScript rewrite

Complete reimplementation in TypeScript, bundled to `dist/index.js` via `@vercel/ncc`. Public input **names** and output **names** are unchanged from `v0.0.x` — but several runtime behaviors are net-new or stricter. **Read the Migration section carefully** before flipping `@v0` to `@v1`.

### Added

- **Two new inputs** with v0-compatible defaults that change runtime side effects:
  - `resolve-to-digest` (default `true`): resolves the image tag to a content-addressed `@sha256:...` before deploy via `docker buildx imagetools inspect`. This shells out to docker AND requires registry network access. v0 never did this.
  - `allow-mutable-tag` (default `false`): when `resolve-to-digest: false`, refuses to deploy `:latest`/`:main`/`:master`/`:develop`/`:stable`/no-tag refs unless explicitly allowed.
- **Two new outputs**:
  - `failed-services`: comma-separated labels that did NOT deploy (always written, even on partial failure).
  - `deployment-ids`: multiline `label=id` pairs returned by the Railway redeploy mutation.
- **`image-tag` output is now populated by the action** (not echoed from input). When `resolve-to-digest: true`, this is the resolved digest ref; otherwise the input image verbatim.
- **Automatic retry on transient HTTP failures** (429, 500, 502, 503, 504, network codes ENOTFOUND/ECONNRESET/ETIMEDOUT/etc.). 3 attempts, exponential backoff with jitter (~1–8s). v0 had no retry — every error was fatal on first response.
- **Per-attempt request timeout** (30s via `AbortController`). v0 inherited curl's defaults (~indefinite). NOTE: this caps a single HTTP attempt; with 3 retries the worst-case wall-clock per operation is ~95s.
- **Real `runs.post` cleanup**: v0 used a bash EXIT trap (in-process only); v1 saves `dockerLogoutRegistry` via `core.saveState` and the post step runs `docker logout` regardless of main outcome.
- **Bundled `dist/index.js`** (committed). Size budget gate (`npm run size`, 2.5 MB ceiling) and bundle-freshness CI check (`git diff --exit-code dist/`).
- **`FakeRailwayClient` test fixture** that throws on concurrent `request()`, enforcing the sequential-iteration invariant.
- **Defense-in-depth against argv injection**: `IMAGE_REF_PATTERN` rejects refs starting with `-`; every `docker` invocation uses `--` to terminate flags; stderr from `docker` is sanitized before being embedded in error details.
- **Workflow-command injection defense**: `api-token`, `token-type`, `first-service`, `registry-username` reject control chars + `%` via regex (would otherwise let an attacker-controlled input inject `::add-mask::` etc. through `core.info`).
- **`wait-seconds` upper bound** of 900 (15 min) to prevent runaway billing on misconfigured workflows.
- **CODEOWNERS self-protection**: `/.github/` is now owned so a future PR cannot silently remove the protections.

### Changed (behavior, not name)

- **Input validation is stricter** than v0:
  - `environment-id` MUST match the UUID regex (v0 only checked non-empty).
  - Each service ID MUST match the UUID regex (v0 only checked non-empty).
  - `image` MUST match `IMAGE_REF_PATTERN` (`^[a-z0-9][a-z0-9._/-]*(:tag|@sha256:hex)?$`). v0 accepted any non-empty string. Refs with uppercase, leading non-`[a-z0-9]`, or port-form registries (e.g. `localhost:5000/repo:tag`) are now rejected.
  - `wait-seconds` must coerce to a non-negative integer ≤ 900.
- **`image-tag` output value changes when `resolve-to-digest: true`** (the default): it's now `registry/repo@sha256:...`, not `registry/repo:tag`. Workflows that compared this output to the input image verbatim will mismatch. Mitigation: set `resolve-to-digest: false` (and either `allow-mutable-tag: true` or use an immutable tag).
- **Ordered-deploy step ordering changed**. v0: Step 1/3 = Update ALL → Step 2/3 = Redeploy first → Step 3/3 = Redeploy rest. v1: Step 1/3 = Update + Redeploy first → Step 2/3 = Update rest → Step 3/3 = Redeploy rest. The partial-failure roll-forward behavior shifts accordingly. Step header strings still say `Step 1/3` / `Step 2/3` / `Step 3/3` but their contents differ.
- **Service iteration order is now deterministic** (input order via `Map`). v0 used a bash associative array with hash-bucketed iteration. v1 is more predictable; an improvement, but observable.
- Inputs are read via `@actions/core.getInput` (boolean inputs via `getBooleanInput`). `core.setSecret` is now called immediately on `api-token` and `registry-password` read — before any code that could log. `registry-username` is intentionally **not** masked (OCI convention; v0 parity).
- Error annotations route through `@actions/core` (`core.error`, `core.notice`, `core.summary`) instead of bash `echo ::error::`. Stable error message strings (`RAILWAY_API_TOKEN is not set`, etc.) preserved verbatim for consumer log-grep compatibility.

### Removed

- All bash scripts (`scripts/deploy.sh`).
- All bash test harnesses (`tests/test-dry-run.sh`, `tests/test-json-output.sh`).
- `shellcheck` CI job.

### Runner requirements (NEW)

- **Node 20** (provided by `runs.using: node20` — automatic on GitHub-hosted runners; self-hosted runners must have Node 20 installed).
- **`docker buildx`** (when `resolve-to-digest: true`, the default) — for manifest digest inspection. Pre-installed on `ubuntu-latest`. Self-hosted runners without docker must set `resolve-to-digest: false` AND `allow-mutable-tag: true` (or use an `@sha256:` ref).

### Internal

- Test framework: vitest@^4 + @vitest/coverage-v8@^4 (the plan initially called for jest, but ts-jest startup hung in our development shell; vitest is faster, native-TS via esbuild, and zero npm-audit findings).
- 186 unit tests, 93% line / 84% branch coverage, ~400ms test runtime.
- `npm ci` runs with `ignore-scripts=true` to neuter fork-PR lockfile-tampering attacks.

### Migration

**TL;DR**: input *names* and output *names* are unchanged. Several *behaviors* are net-new. Pinning to `@v1` is opt-in.

- Existing `@v0.0.x` SHA-pinned consumers are unaffected.
- Existing `@v0` rolling-tag consumers stay on bash — `release.yml` only re-points the `v1` rolling tag for `v1.0.x` releases.
- **To opt into v1**: change `uses: ...@v0` → `uses: ...@v1` (or pin to a `v1.0.0` SHA). Then:
  - If your workflow runs on self-hosted runners, ensure Node 20 + docker buildx are available.
  - If your workflow inspects the `image-tag` output, expect a `@sha256:` digest now. To preserve the v0 echo behavior, set `resolve-to-digest: false` and either use an immutable tag or set `allow-mutable-tag: true`.
  - If you fed lax (non-UUID) IDs to v0, they will now reject at parse time. Use the actual Railway UUIDs.
  - If you grep `Step N/M` log content for specific phrasing (rare), update for the new step contents.
- `@v0` receives security patches only and is EOL 12 months after the `v1.0.0` release date.
