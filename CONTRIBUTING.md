# Contributing

## Version control — git

```bash
# Start a branch off main
git switch main && git pull
git switch -c my-feature

# Edit, then stage and commit
git add -A
git commit -m "feat(scope): short description"

# Push and open a PR
git push -u origin my-feature
```

## Node version

This project pins Node to the exact patch in `.node-version` for **bundle reproducibility** (ncc's output depends on Node patch).

Use [`nodenv`](https://github.com/nodenv/nodenv) or [`nvm`](https://github.com/nvm-sh/nvm) — both respect `.node-version` / `.nvmrc` automatically:

```bash
nodenv install "$(cat .node-version)"   # one-time
nodenv local "$(cat .node-version)"     # cd into repo applies it
```

`engine-strict=true` in `.npmrc` blocks `npm install` if the wrong Node version is active.

We use **npm exclusively** — do not commit `pnpm-lock.yaml`, `yarn.lock`, or `bun.lockb`. The CI runs `npm ci`.

## Running locally

```bash
npm ci             # install
npm run typecheck  # tsc --noEmit
npm run lint       # eslint + prettier
npm test           # vitest with coverage threshold (90/85)
npm run bundle     # ncc → dist/index.js
npm run size       # bundle size budget gate
npm run smoke      # node -e "require('./dist/index.js')"
npm run verify     # everything above
```

After ANY src/ change, run `npm run bundle && git add dist/` before pushing. CI runs `npm run bundle`, then fails if `git status --porcelain dist/` is non-empty (modified *or new* files).

If `dist/` conflicts on rebase or merge, regenerate it: `npm run bundle && git add dist/`. We deliberately do NOT use `.gitattributes merge=ours` because it strands stale bundles silently.

## Changelog

User-facing changes (new inputs, changed behaviour, new outputs, bug fixes) require a `CHANGELOG.md` entry. Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## Code style

- Strict TypeScript — no `any` in `src/` (test files are exempt).
- Dependency injection — modules expose interfaces or function parameters; `main.ts` is the only file that constructs concretes.
- Sequential service iteration is an **invariant** — never replace the `for...of await` loop in `run.ts` with `Promise.all`. The `FakeRailwayClient` fixture throws on concurrent `request()` to enforce this.
- Use libraries to reduce code: `zod` for validation, `graphql-request` for transport, `p-retry` for retries. Don't roll your own.
- Logs go through `@actions/core` — never `console.log` or `process.stdout.write` directly.
- Don't reference private deployments, workflow run ids or company names in code, comments, tests or docs.

## Branch protection

Once enabled by the maintainer, `main` is protected by a repository ruleset that targets the default branch:

- Every change goes through a pull request. Required approvals: **0**. This is a solo-maintained project and you can't approve your own PR, so the protection is "PR plus green checks", not a second reviewer.
- Required status checks: `Build & Test` and `actionlint` (the job `name:` values in `ci.yml`), and the branch must be up to date with `main`. Renaming either job silently blocks every PR until the ruleset is updated to match.
- No force-push and no deletion of `main`.

The ruleset targets branches only, so the rolling major tag (e.g. `v1`), which the release workflow force-pushes, is unaffected.

## Releasing

1. In a PR, bump the version with `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`) and move the `[Unreleased]` changelog section to `[X.Y.Z] — YYYY-MM-DD`.
2. After the PR merges, tag the merge commit on `main` and push the tag:
   ```bash
   git switch main && git pull
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```
3. The release workflow runs only for semver tags (`vX.Y.Z` or `vX.Y.Z-suffix`). It checks that the tag matches `package.json`, that the tagged commit is on `main` (a tag pushed before its merge reaches `main` fails), and that `dist/` is fresh. Then it publishes the GitHub release.
4. The rolling major tag (`v1`) moves only for a stable `v1.x.y` or later. Prereleases (`-rc.N` and other `-` suffixes) need the same full version, suffix included (e.g. `1.2.0-rc.1`), in `package.json` on `main`, and are published as prereleases. Neither prereleases nor `v0.x` tags ever create or move a rolling tag. The rolling tag also only moves forward: a stable release whose commit is not a descendant of the current `v1` (e.g. a `v1.2.1` hotfix published after `v1.3.0`) leaves it alone.

## Dependabot

npm PRs that change bundled code fail the `dist/` check by design, because Dependabot doesn't rebuild `dist/`. Check out the branch, run `npm run bundle`, and commit `dist/`.
