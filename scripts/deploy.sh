#!/usr/bin/env bash
set -euo pipefail

API_URL="https://backboard.railway.app/graphql/v2"

# ── helpers ──────────────────────────────────────────────────────────

railway_gql() {
  local query="$1"
  local variables="$2"

  response=$(curl -sf -X POST "$API_URL" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\", \"variables\": $variables}" 2>&1) || {
    echo "::error::Railway API request failed"
    echo "$response"
    exit 1
  }

  if echo "$response" | grep -q '"errors"'; then
    echo "::error::Railway GraphQL error"
    echo "$response" | jq -r '.errors[].message' 2>/dev/null || echo "$response"
    exit 1
  fi

  echo "$response"
}

update_image() {
  local service_id="$1"
  local name="$2"

  echo "  ↳ Updating image on [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!,\$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:\$sid,environmentId:\$eid,input:\$input)}" \
    "{\"sid\":\"$service_id\",\"eid\":\"$RAILWAY_ENV_ID\",\"input\":{\"source\":{\"image\":\"$IMAGE_TAG\"}}}" \
    > /dev/null
}

redeploy() {
  local service_id="$1"
  local name="$2"

  echo "  ↳ Redeploying [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!){serviceInstanceRedeploy(serviceId:\$sid,environmentId:\$eid)}" \
    "{\"sid\":\"$service_id\",\"eid\":\"$RAILWAY_ENV_ID\"}" \
    > /dev/null
}

# ── parse services input ─────────────────────────────────────────────

declare -A SERVICE_MAP
DEPLOYED=()

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  label="${line%%:*}"
  id="${line#*:}"
  SERVICE_MAP["$label"]="$id"
done <<< "$SERVICES"

echo "🐳 Image: $IMAGE_TAG"
echo "🌍 Environment: $RAILWAY_ENV_ID"
echo "📦 Services (${#SERVICE_MAP[@]}): ${!SERVICE_MAP[*]}"
echo ""

# ── step 1: update image on all services ─────────────────────────────

echo "Step 1/3: Updating image source on all services"
for label in "${!SERVICE_MAP[@]}"; do
  update_image "${SERVICE_MAP[$label]}" "$label"
done
echo ""

# ── step 2: redeploy with optional ordering ─────────────────────────

if [[ -n "$FIRST_SERVICE" ]]; then
  echo "Step 2/3: Redeploying [$FIRST_SERVICE] first"

  if [[ -z "${SERVICE_MAP[$FIRST_SERVICE]+x}" ]]; then
    echo "::error::first-service '$FIRST_SERVICE' not found in services list"
    exit 1
  fi

  redeploy "${SERVICE_MAP[$FIRST_SERVICE]}" "$FIRST_SERVICE"
  DEPLOYED+=("$FIRST_SERVICE")

  echo "  ⏳ Waiting ${WAIT_SECONDS}s for first service to stabilise..."
  sleep "$WAIT_SECONDS"
  echo ""

  echo "Step 3/3: Redeploying remaining services"
  for label in "${!SERVICE_MAP[@]}"; do
    if [[ "$label" != "$FIRST_SERVICE" ]]; then
      redeploy "${SERVICE_MAP[$label]}" "$label"
      DEPLOYED+=("$label")
    fi
  done
else
  echo "Step 2/3: No first-service specified — redeploying all together"
  for label in "${!SERVICE_MAP[@]}"; do
    redeploy "${SERVICE_MAP[$label]}" "$label"
    DEPLOYED+=("$label")
  done
  echo "Step 3/3: Skipped (no ordering needed)"
fi

echo ""
echo "✅ Deploy complete (${#DEPLOYED[@]} services): ${DEPLOYED[*]}"

# ── outputs ──────────────────────────────────────────────────────────

IFS=','
echo "deployed-services=${DEPLOYED[*]}" >> "$GITHUB_OUTPUT"
