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
  WAIT_SECONDS="0" || ((FAILED++)) || true

run_dry_run "Multi-service with first-service" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-456" \
  IMAGE_TAG="ghcr.io/test/app:sha-abc123" \
  SERVICES=$'web:svc-web\nworker:svc-worker\nclock:svc-clock' \
  FIRST_SERVICE="web" \
  WAIT_SECONDS="0" || ((FAILED++)) || true

run_dry_run "With registry credentials (simple)" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-789" \
  IMAGE_TAG="private.registry.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="testuser" \
  REGISTRY_PASSWORD="testpass" || ((FAILED++)) || true

run_dry_run "With registry credentials (special chars)" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-special" \
  IMAGE_TAG="ghcr.io/test/app:latest" \
  SERVICES="api:svc-abc123" \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="user@example.com" \
  REGISTRY_PASSWORD='my"complex$pa$$word!' || ((FAILED++)) || true

run_dry_run "GitHub PAT style credentials" \
  RAILWAY_API_TOKEN="test-token" \
  RAILWAY_ENV_ID="env-ghcr" \
  IMAGE_TAG="ghcr.io/harleytherapy/london:ci-railway-deploy-action-integration" \
  SERVICES=$'clock:svc-clock\nlondon:svc-london\nworker:svc-worker' \
  FIRST_SERVICE="" \
  WAIT_SECONDS="0" \
  REGISTRY_USERNAME="x-access-token" \
  REGISTRY_PASSWORD="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" || ((FAILED++)) || true

echo ""
echo "════════════════════════════════════════════════════════════════════"
if [[ $FAILED -eq 0 ]]; then
  echo -e "${GREEN}All dry-run tests passed!${NC}"
else
  echo -e "${RED}$FAILED test(s) failed${NC}"
  exit 1
fi
