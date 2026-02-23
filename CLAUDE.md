# Railway Image Update Action

> **Status: Work in Progress (WIP)**

## Commands

- Validate bash syntax: `bash -n scripts/deploy.sh`
- Run JSON tests: `./tests/test-json-output.sh`
- Dry-run deploy: `DRY_RUN=true ./scripts/deploy.sh` (requires env vars set)
- Debug mode: `DEBUG=true DRY_RUN=true ./scripts/deploy.sh`

## Version Control

This project uses **Jujutsu (jj)** instead of raw git for commits.

- `jj status` — check working copy status
- `jj commit -m "message"` — create a commit
- `jj log` — view commit history

Do NOT use `git commit` directly.

## Architecture

Composite GitHub Action (pure bash, no Node/Python).
Single entry point: `action.yml` -> `scripts/deploy.sh`

Flow:
1. Parse `services` multiline input into bash associative array
2. Validate registry credentials (both or neither)
3. Update image source on ALL services via Railway GraphQL API
4. If `first-service` set: redeploy it, wait N seconds, redeploy rest
5. If no `first-service`: redeploy all together
6. Write deployed-services list to `$GITHUB_OUTPUT`

## Key Files

- `action.yml` — Action metadata, inputs/outputs, env-to-script mapping
- `scripts/deploy.sh` — All deploy logic (GraphQL calls, error handling, ordering)
- `tests/test-json-output.sh` — JSON construction tests (credential edge cases)
- `specs.md` — Original specification document

## Conventions

- Pure bash (no deps beyond `curl` + `jq`, both pre-installed on `ubuntu-latest`)
- Use `jq --arg` for ALL JSON construction (never string concatenation)
- `die()` for errors: `die "message" "details" "hint"`
- `debug_log()` for debug output (prints to stderr)
- `DRY_RUN=true` skips API calls, returns mock response

## Gotchas

- JSON escaping: MUST use `jq -n --arg` for credentials (special chars break string concat)
- Temp file pattern: `railway_gql()` uses `mktemp` to separate HTTP code from response body
- Bash associative arrays: use `${var+x}` to check key existence, not `[[ -v ]]`
- IFS handling: set `IFS=','` before writing `GITHUB_OUTPUT` for comma-separated list
- Registry credentials: username and password must both be present or both absent

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `api-token` | Yes | Railway API token |
| `environment-id` | Yes | Railway environment ID |
| `image` | Yes | Full Docker image URI with tag |
| `services` | Yes | Multiline `label:service_id` pairs |
| `first-service` | No | Label to redeploy first (default: `""`) |
| `wait-seconds` | No | Wait after first-service (default: `"30"`) |
| `registry-username` | No | Private registry username |
| `registry-password` | No | Private registry password |

## Outputs

- `deployed-services` — Comma-separated deployed service labels
- `image-tag` — Echo of input image
