# Contributing

## Version control — jj (Jujutsu)

This repo uses **jj** (Jujutsu), colocated with git. Never run raw `git commit` / `git push` — use jj instead.

```bash
# Start a new change off main
jj new main -m "feat: short description"

# Edit files — jj tracks working copy automatically, no staging area
# ...

# Set / update the commit message
jj describe -m "feat(Scope): full message"

# Push (auto-tug bookmarks + git push)
jj push
```

See the [jj documentation](https://martinvonz.github.io/jj/latest/) for more.

## Running tests locally

Requires `bash`, `jq`, and `curl` (all pre-installed on `ubuntu-latest`).

```bash
# Validate bash syntax
bash -n scripts/deploy.sh

# JSON construction tests
./tests/test-json-output.sh

# Dry-run integration tests
./tests/test-dry-run.sh

# Both test suites
./tests/test-json-output.sh && ./tests/test-dry-run.sh

# Debug output
DEBUG=true ./tests/test-dry-run.sh
```

ShellCheck and actionlint run in CI. To run them locally:

```bash
# ShellCheck
shellcheck scripts/*.sh tests/*.sh

# actionlint (installs to ./actionlint)
bash <(curl -fsSL https://raw.githubusercontent.com/rhysd/actionlint/main/scripts/download-actionlint.bash)
./actionlint action.yml .github/workflows/*.yml
```

## Branch protection

The `main` branch should have branch protection enabled in GitHub settings:

- Require pull request reviews before merging (at least 1 approval)
- Require status checks to pass before merging (shellcheck, actionlint, tests)
- Require branches to be up to date before merging
- Restrict force-pushes

[GitHub branch protection documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule)

**Note:** The rolling major tag (e.g. `v0`) is force-pushed by the release workflow — this tag is excluded from branch protection.

## Changelog

User-facing changes (new inputs, changed behaviour, new outputs, bug fixes) require a CHANGELOG entry. Format:

```
## [Unreleased]

### Added
- `resolve-to-digest` input: resolves mutable tags to digests before deploy (#PR)

### Fixed
- Service deploy order is now deterministic (insertion order) (#PR)
```

Use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions.

## Code style

- Pure bash — no Node.js, Python, or additional runtimes
- Use `jq` for all JSON construction (never string concatenation)
- Error handling: `die "message" "details" "hint"` three-arg form
- New tests use `run_success_test` / `run_error_test` / `assert_contains` helpers from `tests/test-dry-run.sh`
