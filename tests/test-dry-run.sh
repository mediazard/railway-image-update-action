#!/usr/bin/env bash
# Test deploy.sh in dry-run mode — validates requests, output format, and error handling
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASSED=0
FAILED=0

# ── test helpers ─────────────────────────────────────────────────────

run_test() {
  local description="$1"
  shift

  export GITHUB_OUTPUT=$(mktemp)
  export DRY_RUN="true"

  local output
  local exit_code=0
  output=$(env "$@" "$PROJECT_ROOT/scripts/deploy.sh" 2>&1) || exit_code=$?

  rm -f "$GITHUB_OUTPUT"

  echo "$output"
  return $exit_code
}

assert_contains() {
  local output="$1"
  local expected="$2"
  local context="${3:-}"

  if [[ "$output" == *"$expected"* ]]; then
    return 0
  else
    echo -e "  ${RED}ASSERT FAILED: expected output to contain '$expected'${NC}"
    [[ -n "$context" ]] && echo "    Context: $context"
    return 1
  fi
}

assert_not_contains() {
  local output="$1"
  local unexpected="$2"
  local context="${3:-}"

  if [[ "$output" != *"$unexpected"* ]]; then
    return 0
  else
    echo -e "  ${RED}ASSERT FAILED: output should NOT contain '$unexpected'${NC}"
    [[ -n "$context" ]] && echo "    Context: $context"
    return 1
  fi
}

run_success_test() {
  local description="$1"
  shift

  echo -n "Testing: $description... "

  local output
  local exit_code=0
  output=$(run_test "$description" "$@") || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((PASSED++)) || true
    # Return output for assertion checks
    LAST_OUTPUT="$output"
    return 0
  else
    echo -e "${RED}✗ FAIL (exit code: $exit_code)${NC}"
    echo "$output" | tail -5
    ((FAILED++)) || true
    return 1
  fi
}

run_error_test() {
  local description="$1"
  local expected_error="$2"
  shift 2

  echo -n "Testing: $description... "

  local output
  local exit_code=0
  output=$(run_test "$description" "$@") || exit_code=$?

  if [[ $exit_code -ne 0 ]] && [[ "$output" == *"$expected_error"* ]]; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((PASSED++)) || true
    return 0
  elif [[ $exit_code -eq 0 ]]; then
    echo -e "${RED}✗ FAIL (expected failure, got success)${NC}"
    ((FAILED++)) || true
    return 1
  else
    echo -e "${RED}✗ FAIL (wrong error message)${NC}"
    echo "    Expected: $expected_error"
    echo "    Got: $(echo "$output" | grep 'ERROR' | head -1)"
    ((FAILED++)) || true
    return 1
  fi
}

# ── test suite ───────────────────────────────────────────────────────

echo "╔════════════════════════════════════════════════════════════════════╗"
echo "║           Railway Deploy Action - Dry Run Tests                    ║"
echo "╚════════════════════════════════════════════════════════════════════╝"

echo ""
echo -e "${YELLOW}── Success cases ──${NC}"
echo ""

LAST_OUTPUT=""

run_success_test "Basic single-service deploy" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Step 1/2" "should use 2-step format" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Step 2/2" "should use 2-step format" || ((FAILED++)) || true
  assert_not_contains "$LAST_OUTPUT" "Step 3/" "should NOT have step 3" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Deploy complete" "should show completion" || ((FAILED++)) || true
}

run_success_test "Multi-service with first-service" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-456" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES=$'web:svc-web\nworker:svc-worker\nclock:svc-clock' \
  FIRST_SERVICE="web" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Step 1/3" "should use 3-step format" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Step 2/3" "should use 3-step format" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Step 3/3" "should use 3-step format" || ((FAILED++)) || true
}

run_success_test "With registry credentials" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-789" \
  IMAGE_TAG="private.registry.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="testuser" \
  REGISTRY_PASSWORD="testpass" && {
  assert_contains "$LAST_OUTPUT" "Registry credentials: provided" "should show creds" || ((FAILED++)) || true
}

run_success_test "With special char credentials" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-special" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="user@example.com" \
  REGISTRY_PASSWORD='my"complex$pa$$word!'

run_success_test "Project token type" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_TOKEN_TYPE="project" \
  RAILWAY_ENV_ID="env-proj" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Token type: project" "should show project token" || ((FAILED++)) || true
}

echo ""
echo -e "${YELLOW}── Error cases ──${NC}"
echo ""

run_error_test "Missing API token" \
  "RAILWAY_API_TOKEN is not set" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Missing environment ID" \
  "RAILWAY_ENV_ID is not set" \
  RAILWAY_API_TOKEN="test-token" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Missing image" \
  "IMAGE_TAG is not set" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Missing services" \
  "SERVICES is not set" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Registry username without password" \
  "registry-username provided without registry-password" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="user"

run_error_test "Registry password without username" \
  "registry-password provided without registry-username" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_PASSWORD="pass"

run_error_test "Unknown first-service" \
  "first-service 'bogus' not found in services list" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-123" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="bogus" \
  WAIT_SECONDS="0"

echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}All $PASSED tests passed!${NC}"
  exit 0
else
  echo -e "${RED}$FAILED of $((PASSED + FAILED)) tests failed${NC}"
  exit 1
fi
