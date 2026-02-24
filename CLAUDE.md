# Railway Image Update Action

## Commands

- Validate bash syntax: `bash -n scripts/deploy.sh`
- Run JSON tests: `./tests/test-json-output.sh`
- Run dry-run tests: `./tests/test-dry-run.sh`
- Run all tests: `./tests/test-json-output.sh && ./tests/test-dry-run.sh`
- Debug mode: `DEBUG=true ./tests/test-dry-run.sh`

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
1. Validate required inputs (token, env ID, image, services)
2. Validate registry credentials (both or neither)
3. Parse `services` multiline input into bash associative array
4. Update image source on ALL services via Railway GraphQL API
5. If `first-service` set: redeploy it, wait N seconds, redeploy rest
6. If no `first-service`: redeploy all together
7. Write deployed-services list to `$GITHUB_OUTPUT`

## Key Files

- `action.yml` — Action metadata, inputs/outputs, env-to-script mapping
- `scripts/deploy.sh` — All deploy logic (GraphQL calls, error handling, ordering)
- `tests/test-json-output.sh` — JSON construction tests (credential edge cases, body construction)
- `tests/test-dry-run.sh` — Integration tests (success + error cases with output assertions)

## Conventions

- Pure bash (no deps beyond `curl` + `jq`, both pre-installed on `ubuntu-latest`)
- Use `jq` for ALL JSON construction (never string concatenation)
- `die()` for errors: `die "message" "details" "hint"`
- `debug_log()` for debug output (prints to stderr)
- `DRY_RUN=true` skips API calls, returns mock response
- `validate_service_id()` for shared service ID checks

## Gotchas

- JSON escaping: MUST use `jq -n --arg` for credentials (special chars break string concat)
- Temp file pattern: `railway_gql()` uses `mktemp` to separate HTTP code from response body
- Bash associative arrays: use `${var+x}` to check key existence, not `[[ -v ]]`
- IFS handling: set `IFS=','` before writing `GITHUB_OUTPUT` for comma-separated list
- Registry credentials: username and password must both be present or both absent
- Input validation runs BEFORE auth header construction to avoid `set -u` errors

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `api-token` | Yes | Railway API token |
| `token-type` | No | `bearer` (default) or `project` |
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
