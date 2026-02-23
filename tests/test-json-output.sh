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
    ((PASSED++)) || true
    return 0
  else
    echo -e "${RED}✗ FAIL${NC}"
    echo "    → $result"
    ((FAILED++)) || true
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
    ((PASSED++)) || true
    return 0
  else
    echo -e "${RED}✗ FAIL${NC}"
    echo "    → $result"
    ((FAILED++)) || true
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
