# Contributing

## Version control — jj (Jujutsu)

This repo uses **jj** (Jujutsu), colocated with git. Never run raw `git commit` / `git push` — use jj.

```bash
# Start a new change off main
jj new main -m "feat: short description"

# Edit files — jj tracks the working copy automatically, no staging area
# ...

# Update the commit message
jj describe -m "feat(scope): full message"

# Bookmark the change and push it to the git remote
jj bookmark create my-feature -r @
jj git push -b my-feature
```

See the [jj documentation](https://martinvonz.github.io/jj/latest/) for more.

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

After ANY src/ change, run `npm run bundle && git add dist/` before pushing. CI runs `git diff --exit-code dist/` and fails if you forget.

If `dist/` conflicts on rebase or merge, regenerate it: `npm run bundle && git add dist/`. We deliberately do NOT use `.gitattributes merge=ours` because it strands stale bundles silently.

## Changelog

User-facing changes (new inputs, changed behaviour, new outputs, bug fixes) require a `CHANGELOG.md` entry. Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

## Code style

- Strict TypeScript — no `any` in `src/` (test files are exempt).
- Dependency injection — modules expose interfaces or function parameters; `main.ts` is the only file that constructs concretes.
- Sequential service iteration is an **invariant** — never replace the `for...of await` loop in `run.ts` with `Promise.all`. The `FakeRailwayClient` fixture throws on concurrent `request()` to enforce this.
- Use libraries to reduce code: `zod` for validation, `graphql-request` for transport, `p-retry` for retries. Don't roll your own.
- Logs go through `@actions/core` — never `console.log` or `process.stdout.write` directly.

## Branch protection

`main` branch should have:
- Required PR review (at least 1 approval)
- Required status checks: `Build & Test`, `actionlint`
- Required up-to-date with base
- Restricted force-push

The rolling major tag (e.g. `v1`) is force-pushed by the release workflow — exclude it from branch protection.
