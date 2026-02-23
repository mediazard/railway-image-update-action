# Local Test Harness for deploy.sh Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a local test harness to validate JSON construction in deploy.sh before requests are sent to Railway API.

**Architecture:** Extract and test the JSON-building functions in isolation. Add a dry-run mode that validates JSON without sending requests. Use bash tests to verify output for various credential scenarios.

**Tech Stack:** Bash, jq

---

## Task 1: Create JSON validation test script

**Files:**
- Create: `tests/test-json-output.sh`

**Step 1: Create JSON validation script**

```bash
#!/usr/bin/env bash
# Test that jq JSON construction produces valid output for all credential scenarios
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

test_json() {
  local description="$1"
  local image="$2"
  local username="${3:-}"
  local password="${4:-}"

  echo -n "Testing: $description... "

  local result
  if [[ -n "$username" && -n "$password" ]]; then
    result=$(jq -n \
      --arg image "$image" \
      --arg username "$username" \
      --arg password "$password" \
      '{source: {image: $image, credentials: {username: $username, password: $password}}}' 2>&1)
  else
    result=$(jq -n --arg image "$image" '{source: {image: $image}}' 2>&1)
  fi

  # Validate JSON
  if echo "$result" | jq . >/dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
    echo "    → $result"
    ((PASSED++))
    return 0
  else
    echo -e "${RED}✗ FAIL${NC}"
    echo "    → $result"
    ((FAILED++))
    return 1
  fi
}

test_variables_json() {
  local description="$1"
  local service_id="$2"
  local env_id="$3"
  local input_json="$4"

  echo -n "Testing variables: $description... "

  local result
  result=$(jq -n \
    --arg sid "$service_id" \
    --arg eid "$env_id" \
    --argjson input "$input_json" \
    '{sid: $sid, eid: $eid, input: $input}' 2>&1)

  if echo "$result" | jq . >/dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}"
    echo "    → $result"
    ((PASSED++))
    return 0
  else
    echo -e "${RED}✗ FAIL${NC}"
    echo "    → $result"
    ((FAILED++))
    return 1
  fi
}

echo "═══════════════════════════════════════════════════════════════════"
echo "JSON Construction Tests for deploy.sh"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

echo -e "${YELLOW}── build_image_source_input() tests ──${NC}"
echo ""

test_json "No credentials" "ghcr.io/org/app:latest"
test_json "Simple credentials" "ghcr.io/org/app:latest" "user" "pass"
test_json "Email as username" "ghcr.io/org/app:latest" "user@example.com" "password123"
test_json "Password with @" "ghcr.io/org/app:latest" "user" "p@ssword"
test_json "Password with quotes" "ghcr.io/org/app:latest" "user" 'pass"word'
test_json "Password with single quotes" "ghcr.io/org/app:latest" "user" "pass'word"
test_json "Password with backslash" "ghcr.io/org/app:latest" "user" 'pass\\word'
test_json "Password with dollar sign" "ghcr.io/org/app:latest" "user" 'pa$$word'
test_json "Password with newline" "ghcr.io/org/app:latest" "user" $'pass\nword'
test_json "Password with tab" "ghcr.io/org/app:latest" "user" $'pass\tword'
test_json "Unicode password" "ghcr.io/org/app:latest" "user" "pàsswörd🔐"
test_json "All special chars" "private.registry/org/app:v1" 'u"ser@test' 'p@$$!#%^&*(){}[]|\\:;<>?/'
test_json "GitHub token style" "ghcr.io/org/app:sha-abc123" "x-access-token" "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
test_json "AWS ECR style" "123456789.dkr.ecr.us-east-1.amazonaws.com/app:latest" "AWS" "eyJwYXlsb2FkIjoiZXhhbXBsZSJ9"

echo ""
echo -e "${YELLOW}── Full variables JSON tests ──${NC}"
echo ""

# Build a sample input JSON first
input_with_creds=$(jq -n \
  --arg image "ghcr.io/org/app:latest" \
  --arg username "user@test.com" \
  --arg password 'p@$$word"test' \
  '{source: {image: $image, credentials: {username: $username, password: $password}}}')

input_no_creds=$(jq -n --arg image "ghcr.io/org/app:latest" '{source: {image: $image}}')

test_variables_json "Service with credentials" "svc-abc123" "env-xyz789" "$input_with_creds"
test_variables_json "Service without credentials" "svc-def456" "env-xyz789" "$input_no_creds"
test_variables_json "UUID-style IDs" "550e8400-e29b-41d4-a716-446655440000" "6ba7b810-9dad-11d1-80b4-00c04fd430c8" "$input_no_creds"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}All $PASSED tests passed!${NC}"
  exit 0
else
  echo -e "${RED}$FAILED of $((PASSED + FAILED)) tests failed${NC}"
  exit 1
fi
```

**Step 2: Make it executable**

Run: `chmod +x tests/test-json-output.sh`
Expected: No output, file is executable

**Step 3: Run validation**

Run: `./tests/test-json-output.sh`
Expected: All tests pass

**Step 4: Commit**

```bash
git add tests/test-json-output.sh
git commit -m "test: add JSON construction validation tests"
```

---

## Task 2: Add dry-run mode to deploy.sh

**Files:**
- Modify: `scripts/deploy.sh:4-5`

**Step 1: Add DRY_RUN and DEBUG variables after API_URL**

After line 4, add:
```bash
DRY_RUN="${DRY_RUN:-false}"
DEBUG="${DEBUG:-false}"

debug_log() {
  if [[ "$DEBUG" == "true" ]]; then
    echo "[DEBUG] $*" >&2
  fi
}
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: add DRY_RUN and DEBUG mode variables"
```

---

## Task 3: Add debug logging to build_image_source_input

**Files:**
- Modify: `scripts/deploy.sh:158-168` (build_image_source_input function)

**Step 1: Update build_image_source_input to log output**

Replace the function with:
```bash
build_image_source_input() {
  local result
  if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
    result=$(jq -n \
      --arg image "$IMAGE_TAG" \
      --arg username "$REGISTRY_USERNAME" \
      --arg password "$REGISTRY_PASSWORD" \
      '{source: {image: $image, credentials: {username: $username, password: $password}}}')
  else
    result=$(jq -n --arg image "$IMAGE_TAG" '{source: {image: $image}}')
  fi
  debug_log "build_image_source_input: $result"
  echo "$result"
}
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: add debug logging to build_image_source_input"
```

---

## Task 4: Add dry-run mode to railway_gql

**Files:**
- Modify: `scripts/deploy.sh:55-156` (railway_gql function)

**Step 1: Add dry-run check at start of railway_gql**

After line 58 (`local operation="${3:-GraphQL request}"`), add:
```bash

  debug_log "railway_gql operation: $operation"
  debug_log "railway_gql query: $query"
  debug_log "railway_gql variables: $variables"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Would send to $API_URL:"
    echo "[DRY-RUN]   Operation: $operation"
    echo "[DRY-RUN]   Variables: $variables" | jq . 2>/dev/null || echo "[DRY-RUN]   Variables: $variables"
    echo '{"data":{"dryRun":true}}'
    return 0
  fi
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
git add scripts/deploy.sh
git commit -m "feat: add dry-run mode to skip actual API calls"
```

---

## Task 5: Create dry-run test script

**Files:**
- Create: `tests/test-dry-run.sh`

**Step 1: Create the dry-run test script**

```bash
#!/usr/bin/env bash
# Test deploy.sh in dry-run mode to validate requests without hitting Railway API
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

run_dry_run() {
  local description="$1"
  shift

  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo -e "${YELLOW}$description${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  # Create temp GITHUB_OUTPUT file
  export GITHUB_OUTPUT=$(mktemp)
  export DRY_RUN="true"

  local exit_code=0
  env "$@" "$PROJECT_ROOT/scripts/deploy.sh" 2>&1 || exit_code=$?

  rm -f "$GITHUB_OUTPUT"

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}✓ Completed successfully${NC}"
  else
    echo -e "${RED}✗ Failed with exit code: $exit_code${NC}"
  fi

  return $exit_code
}

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║           Railway Deploy Action - Dry Run Tests                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"

FAILED=0

run_dry_run "Basic single-service deploy" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" || ((FAILED++))

run_dry_run "Multi-service with first-service" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-456" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES=$'web:svc-web\nworker:svc-worker\nclock:svc-clock' \
  FIRST_SERVICE="web" \
  WAIT_SECONDS="0" || ((FAILED++))

run_dry_run "With registry credentials (simple)" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-789" \
  IMAGE_TAG="private.registry.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="testuser" \
  REGISTRY_PASSWORD="testpass" || ((FAILED++))

run_dry_run "With registry credentials (special chars)" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-special" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="user@example.com" \
  REGISTRY_PASSWORD='my"complex$pa$$word!' || ((FAILED++))

run_dry_run "GitHub PAT style credentials" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-ghcr" \
  IMAGE_TAG="ghcr.io/harleytherapy/london:ci-railway-deploy-action-integration" \
  SERVICES=$'clock:svc-clock\nlondon:svc-london\nworker:svc-worker' \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="x-access-token" \
  REGISTRY_PASSWORD="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" || ((FAILED++))

echo ""
echo "════════════════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}All dry-run tests passed!${NC}"
else
  echo -e "${RED}$FAILED test(s) failed${NC}"
  exit 1
fi
```

**Step 2: Make it executable**

Run: `chmod +x tests/test-dry-run.sh`
Expected: No output, file is executable

**Step 3: Commit**

```bash
git add tests/test-dry-run.sh
git commit -m "test: add dry-run integration test"
```

---

## Task 6: Run all tests

**Files:**
- None (verification only)

**Step 1: Run JSON construction tests**

Run: `./tests/test-json-output.sh`
Expected: All tests pass

**Step 2: Run dry-run tests**

Run: `./tests/test-dry-run.sh`
Expected: All tests pass, showing the JSON that would be sent to Railway API

**Step 3: Run with DEBUG mode**

Run: `DEBUG=true ./tests/test-dry-run.sh 2>&1 | head -100`
Expected: Additional debug output showing function internals

---

## Task 7: Squash commits and release

**Files:**
- None

**Step 1: Squash commits**

```bash
git rebase -i HEAD~6
# Squash all into first commit with message:
# "feat: add local test harness with dry-run mode"
```

**Step 2: Push to main**

```bash
git push origin main
```

**Step 3: Tag new version**

```bash
git tag -a v0.0.3 -m "Add local test harness with dry-run mode"
git push origin v0.0.3
```

---

## Summary

| Task | Description | What it adds |
|------|-------------|--------------|
| 1 | JSON validation tests | Verifies jq constructs valid JSON for all credential types |
| 2 | DRY_RUN/DEBUG vars | Environment variables to control behavior |
| 3 | Debug logging | Shows JSON output for troubleshooting |
| 4 | Dry-run mode | Skip API calls, just show what would be sent |
| 5 | Dry-run test script | Integration test using dry-run mode |
| 6 | Run all tests | Verify everything works |
| 7 | Release | Tag v0.0.3 |

**Test commands:**
```bash
# Validate JSON construction
./tests/test-json-output.sh

# Run full script in dry-run mode
./tests/test-dry-run.sh

# Run with debug output
DEBUG=true ./tests/test-dry-run.sh

# Manual dry-run test
DRY_RUN=true RAILWAY_API_TOKEN=x RAILWAY_ENV_ID=y IMAGE_TAG=z SERVICES="a:b" FIRST_SERVICE="" WAIT_SECONDS=0 GITHUB_OUTPUT=/dev/null ./scripts/deploy.sh
```
