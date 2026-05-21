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

# Like run_success_test, but also captures GITHUB_OUTPUT content into LAST_GH_OUTPUT.
# Manages the GITHUB_OUTPUT file directly so the content survives back to the caller.
run_success_test_with_gh_output() {
  local description="$1"
  shift

  echo -n "Testing: $description... "

  local gh_out_file
  gh_out_file=$(mktemp)

  local output
  local exit_code=0
  output=$(env GITHUB_OUTPUT="$gh_out_file" DRY_RUN="true" "$@" "$PROJECT_ROOT/scripts/deploy.sh" 2>&1) || exit_code=$?

  LAST_GH_OUTPUT=$(<"$gh_out_file")
  rm -f "$gh_out_file"

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}✓ PASS${NC}"
    ((PASSED++)) || true
    LAST_OUTPUT="$output"
    return 0
  else
    echo -e "${RED}✗ FAIL (exit code: $exit_code)${NC}"
    echo "$output" | tail -5
    ((FAILED++)) || true
    return 1
  fi
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
LAST_GH_OUTPUT=""

# Valid UUIDs used across success tests
ENV_UUID_1="550e8400-e29b-41d4-a716-446655440000"
ENV_UUID_2="550e8400-e29b-41d4-a716-446655440001"
ENV_UUID_3="550e8400-e29b-41d4-a716-446655440002"
ENV_UUID_ORDER="550e8400-e29b-41d4-a716-446655440004"
ENV_UUID_DIGEST="550e8400-e29b-41d4-a716-446655440005"
SVC_UUID_API="550e8400-e29b-41d4-a716-446655440010"
SVC_UUID_WEB="550e8400-e29b-41d4-a716-446655440011"
SVC_UUID_WORKER="550e8400-e29b-41d4-a716-446655440012"
SVC_UUID_CLOCK="550e8400-e29b-41d4-a716-446655440013"
SVC_UUID_ALPHA="550e8400-e29b-41d4-a716-446655440020"
SVC_UUID_BETA="550e8400-e29b-41d4-a716-446655440021"
SVC_UUID_GAMMA="550e8400-e29b-41d4-a716-446655440022"

run_success_test "Basic single-service deploy" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Step 1/2" "should use 2-step format" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Step 2/2" "should use 2-step format" || ((FAILED++)) || true
  assert_not_contains "$LAST_OUTPUT" "Step 3/" "should NOT have step 3" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Deploy complete" "should show completion" || ((FAILED++)) || true
}

run_success_test "Multi-service with first-service" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_2" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES="$(printf 'web:%s\nworker:%s\nclock:%s' "$SVC_UUID_WEB" "$SVC_UUID_WORKER" "$SVC_UUID_CLOCK")" \
  FIRST_SERVICE="web" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Step 1/3" "should use 3-step format" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Step 2/3" "should use 3-step format" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Step 3/3" "should use 3-step format" || ((FAILED++)) || true
}

run_success_test "With registry credentials" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_3" \
  IMAGE_TAG="private.registry.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="testuser" \
  REGISTRY_PASSWORD="testpass" && {
  assert_contains "$LAST_OUTPUT" "Registry credentials: provided" "should show creds" || ((FAILED++)) || true
}

run_success_test "With special char credentials" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="user@example.com" \
  REGISTRY_PASSWORD='my"complex$pa$$word!'

run_success_test "Project token type" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_TOKEN_TYPE="project" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Token type: project" "should show project token" || ((FAILED++)) || true
}

run_success_test "Multi-service deploy order matches input order (no first-service)" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_ORDER" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES="$(printf 'alpha:%s\nbeta:%s\ngamma:%s' "$SVC_UUID_ALPHA" "$SVC_UUID_BETA" "$SVC_UUID_GAMMA")" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  deploy_lines=$(echo "$LAST_OUTPUT" | grep "↳ Deploying")
  first_deploy=$(echo "$deploy_lines" | sed -n '1p')
  second_deploy=$(echo "$deploy_lines" | sed -n '2p')
  third_deploy=$(echo "$deploy_lines" | sed -n '3p')
  assert_contains "$first_deploy" "[alpha]" "alpha should be deployed first (input order)" || ((FAILED++)) || true
  assert_contains "$second_deploy" "[beta]" "beta should be deployed second (input order)" || ((FAILED++)) || true
  assert_contains "$third_deploy" "[gamma]" "gamma should be deployed third (input order)" || ((FAILED++)) || true
}

run_success_test "Multi-service deploy order with first-service respects input order for remaining" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_2" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES="$(printf 'web:%s\nworker:%s\nclock:%s' "$SVC_UUID_WEB" "$SVC_UUID_WORKER" "$SVC_UUID_CLOCK")" \
  FIRST_SERVICE="web" \
  WAIT_SECONDS="0" && {
  deploy_lines=$(echo "$LAST_OUTPUT" | grep "↳ Deploying")
  first_deploy=$(echo "$deploy_lines" | sed -n '1p')
  second_deploy=$(echo "$deploy_lines" | sed -n '2p')
  third_deploy=$(echo "$deploy_lines" | sed -n '3p')
  assert_contains "$first_deploy" "[web]" "web should be deployed first (first-service)" || ((FAILED++)) || true
  assert_contains "$second_deploy" "[worker]" "worker should be deployed second (input order)" || ((FAILED++)) || true
  assert_contains "$third_deploy" "[clock]" "clock should be deployed third (input order)" || ((FAILED++)) || true
}

run_success_test "Digest-resolution skipped for @sha256 input" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_DIGEST" \
  IMAGE_TAG="ghcr.io/foo/bar@sha256:0000000000000000000000000000000000000000000000000000000000000000" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  RESOLVE_TO_DIGEST="true" && {
  assert_not_contains "$LAST_OUTPUT" "Resolving manifest digest" "should skip resolution for already-pinned ref" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Deploy complete" "should complete successfully" || ((FAILED++)) || true
}

run_success_test "DRY_RUN digest resolution produces stub digest" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_DIGEST" \
  IMAGE_TAG="ghcr.io/foo/bar:sha-abc123" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  RESOLVE_TO_DIGEST="true" && {
  assert_contains "$LAST_OUTPUT" "Resolving manifest digest" "should attempt resolution in dry-run" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "sha256:dryrun" "should use stub digest in dry-run" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "Deploy complete" "should complete successfully" || ((FAILED++)) || true
}

run_success_test "Mutable tag allowed when resolve-to-digest=false and allow-mutable-tag=true" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_DIGEST" \
  IMAGE_TAG="ghcr.io/foo/bar:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  RESOLVE_TO_DIGEST="false" \
  ALLOW_MUTABLE_TAG="true" && {
  assert_contains "$LAST_OUTPUT" "Deploy complete" "should complete with allow-mutable-tag=true" || ((FAILED++)) || true
}

run_success_test_with_gh_output "deployment-ids output written in dry-run" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_2" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES="$(printf 'web:%s\nworker:%s' "$SVC_UUID_WEB" "$SVC_UUID_WORKER")" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "deployment-id: dry-run-deploy-id" \
    "should log deployment-id line per service" || ((FAILED++)) || true
  assert_contains "$LAST_GH_OUTPUT" "deployment-ids" \
    "deployment-ids key should appear in GITHUB_OUTPUT" || ((FAILED++)) || true
  assert_contains "$LAST_GH_OUTPUT" "web=dry-run-deploy-id" \
    "web label=id pair should appear in GITHUB_OUTPUT" || ((FAILED++)) || true
  assert_contains "$LAST_GH_OUTPUT" "worker=dry-run-deploy-id" \
    "worker label=id pair should appear in GITHUB_OUTPUT" || ((FAILED++)) || true
}


echo ""
echo -e "${YELLOW}── Error cases ──${NC}"
echo ""

run_error_test "Missing API token" \
  "RAILWAY_API_TOKEN is not set" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Missing environment ID" \
  "RAILWAY_ENV_ID is not set" \
  RAILWAY_API_TOKEN="test-token" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Missing image" \
  "IMAGE_TAG is not set" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Missing services" \
  "SERVICES is not set" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Registry username without password" \
  "registry-username provided without registry-password" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="user"

run_error_test "Registry password without username" \
  "registry-password provided without registry-username" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_PASSWORD="pass"

run_error_test "Unknown first-service" \
  "first-service 'bogus' not found in services list" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="bogus" \
  WAIT_SECONDS="0"

run_error_test "Refuses mutable tag when resolve-to-digest=false and allow-mutable-tag=false" \
  "Refusing to deploy mutable tag" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_DIGEST" \
  IMAGE_TAG="ghcr.io/foo/bar:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  RESOLVE_TO_DIGEST="false" \
  ALLOW_MUTABLE_TAG="false"

run_error_test "Refuses mutable tag :main when resolve-to-digest=false" \
  "Refusing to deploy mutable tag" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_DIGEST" \
  IMAGE_TAG="ghcr.io/foo/bar:main" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  RESOLVE_TO_DIGEST="false" \
  ALLOW_MUTABLE_TAG="false"

run_error_test "Refuses tagless ref when resolve-to-digest=false" \
  "Refusing to deploy mutable tag" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_DIGEST" \
  IMAGE_TAG="ghcr.io/foo/bar" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  RESOLVE_TO_DIGEST="false" \
  ALLOW_MUTABLE_TAG="false"

echo ""
echo -e "${YELLOW}── PR3 robustness: input validation ──${NC}"
echo ""

run_error_test "Non-numeric wait-seconds" \
  "wait-seconds must be a non-negative integer" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="abc"

run_error_test "Malformed image tag" \
  "image tag has an invalid format" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="not a valid image" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Non-UUID environment ID" \
  "RAILWAY_ENV_ID is not a valid UUID" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="not-a-uuid" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:$SVC_UUID_API" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_error_test "Non-UUID service ID" \
  "Service ID for [web] is not a valid UUID" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="web:not-a-uuid" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0"

run_success_test "Whitespace in services input" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="$ENV_UUID_1" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES=$'web:  550e8400-e29b-41d4-a716-446655440000  \n  worker:  550e8400-e29b-41d4-a716-446655440001  ' \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" && {
  assert_contains "$LAST_OUTPUT" "Deploy complete" "should succeed with trimmed IDs" || ((FAILED++)) || true
  # If trimming worked, both service labels appear in the deploy summary
  assert_contains "$LAST_OUTPUT" "web" "web label should be present after trimming" || ((FAILED++)) || true
  assert_contains "$LAST_OUTPUT" "worker" "worker label should be present after trimming" || ((FAILED++)) || true
  # The Services header lists discovered labels, confirming UUIDs were accepted by the parser
  assert_contains "$LAST_OUTPUT" "Services (2)" "both services should be parsed" || ((FAILED++)) || true
}

echo ""
echo "═══════════════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}All $PASSED tests passed!${NC}"
  exit 0
else
  echo -e "${RED}$FAILED of $((PASSED + FAILED)) tests failed${NC}"
  exit 1
fi
