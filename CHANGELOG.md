# Changelog

All notable changes follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] — TBD

### TypeScript rewrite

Complete reimplementation in TypeScript, bundled to `dist/index.js` via `@vercel/ncc`. Public inputs and outputs are byte-identical to `v0.x.y` — consumer workflows do not need to change.

### Added
- Real `runs.post` cleanup. v0 used a bash EXIT trap (in-process only); v1 saves `dockerLogoutRegistry` via `core.saveState` and the post step runs `docker logout` regardless of main outcome.
- Per-request `AbortController` timeout (default 30 seconds). v0 inherited curl's defaults; an unresponsive Railway can no longer hang the action indefinitely.
- Bundle size budget gate (`npm run size`, 2.5 MB ceiling — the plan's initial 500 KB target was unrealistic with `graphql-request` + `zod` + `p-retry` + `@actions/*` in the dep tree) and bundle-freshness CI check (`git diff --exit-code dist/`).
- `client.roundtrip.test.ts` — msw-intercepted on-wire test for credential JSON round-trip (replaces v0's `test-json-output.sh`).
- `FakeRailwayClient` test fixture that throws on concurrent `request()`, enforcing the sequential-iteration invariant.
- Defense-in-depth against argv injection: `IMAGE_REF_PATTERN` rejects refs starting with `-`; docker commands use `--` to terminate flags.

### Changed
- Inputs are read via `@actions/core.getInput` (boolean inputs via `getBooleanInput` per the Actions YAML 1.2 spec). `core.setSecret` is now called immediately on `api-token` and `registry-password` read — before any code that could log. `registry-username` is intentionally **not** masked (OCI convention; v0 parity).
- Retry strategy is equivalent (exponential 1–8s with jitter, 3 attempts) but the exact delay distribution is no longer byte-identical to v0's bash math. `p-retry`'s `randomize: true` produces 1–2s / 2–4s / 4–8s vs v0's 1–3s / 2–4s / 4–6s.
- Error annotations route through `@actions/core` (`core.error`, `core.notice`, `core.summary`) instead of hand-rolled `::error::` echoes. The set of preserved log strings is unchanged.

### Removed
- All bash scripts (`scripts/deploy.sh`).
- All bash test harnesses (`tests/test-dry-run.sh`, `tests/test-json-output.sh`).
- `shellcheck` CI job.

### Migration
- Existing `@v0` pinned consumers are unaffected. To opt into TypeScript, change `@v0` to `@v1` (or pin to a specific `v1.0.0` SHA). Inputs and outputs are unchanged.
- `@v0` receives security patches only and is EOL 12 months after the `v1.0.0` release date.
