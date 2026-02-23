#!/usr/bin/env bash
set -euo pipefail

API_URL="https://backboard.railway.app/graphql/v2"

DRY_RUN="${DRY_RUN:-false}"
DEBUG="${DEBUG:-false}"

debug_log() {
  if [[ "$DEBUG" == "true" ]]; then
    echo "[DEBUG] $*" >&2
  fi
}

# ── error handling ───────────────────────────────────────────────────

die() {
  local message="$1"
  local details="${2:-}"
  local hint="${3:-}"

  echo ""
  echo "::error::$message"
  echo "────────────────────────────────────────────────────────────────"
  echo "❌ ERROR: $message"
  echo ""

  if [[ -n "$details" ]]; then
    echo "Details:"
    echo "$details" | sed 's/^/  /'
    echo ""
  fi

  if [[ -n "$hint" ]]; then
    echo "💡 Hint: $hint"
    echo ""
  fi

  echo "────────────────────────────────────────────────────────────────"
  exit 1
}

# ── validate registry credentials ────────────────────────────────────

if [[ -n "${REGISTRY_USERNAME:-}" && -z "${REGISTRY_PASSWORD:-}" ]]; then
  die "registry-username provided without registry-password" \
      "Both credentials must be provided together" \
      "Add registry-password input to your workflow"
fi

if [[ -z "${REGISTRY_USERNAME:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
  die "registry-password provided without registry-username" \
      "Both credentials must be provided together" \
      "Add registry-username input to your workflow"
fi

HAS_REGISTRY_CREDENTIALS="false"
if [[ -n "${REGISTRY_USERNAME:-}" && -n "${REGISTRY_PASSWORD:-}" ]]; then
  HAS_REGISTRY_CREDENTIALS="true"
fi

# ── helpers ──────────────────────────────────────────────────────────

railway_gql() {
  local query="$1"
  local variables="$2"
  local operation="${3:-GraphQL request}"

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

  local http_code
  local response

  # Use a temp file to capture both response and http code
  local tmp_file
  tmp_file=$(mktemp)

  http_code=$(curl -s -w "%{http_code}" -X POST "$API_URL" \
    -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"query\": \"$query\", \"variables\": $variables}" \
    -o "$tmp_file" 2>&1) || {
    local curl_exit=$?
    rm -f "$tmp_file"

    case $curl_exit in
      6)  die "Could not resolve Railway API host" \
              "curl exit code: $curl_exit (DNS resolution failed)" \
              "Check your network connection and DNS settings" ;;
      7)  die "Could not connect to Railway API" \
              "curl exit code: $curl_exit (connection refused)" \
              "Railway API may be down. Check https://status.railway.app" ;;
      28) die "Railway API request timed out" \
              "curl exit code: $curl_exit (operation timeout)" \
              "Try again or check Railway status at https://status.railway.app" ;;
      35) die "SSL/TLS connection failed" \
              "curl exit code: $curl_exit (SSL connect error)" \
              "Check your network security settings" ;;
      *)  die "Railway API request failed" \
              "curl exit code: $curl_exit" \
              "Check your network connection" ;;
    esac
  }

  response=$(cat "$tmp_file")
  rm -f "$tmp_file"

  # Check HTTP status code
  case $http_code in
    200) ;; # OK, continue
    401)
      die "Railway API authentication failed" \
          "HTTP $http_code: Unauthorized\nAPI URL: $API_URL" \
          "Verify your RAILWAY_API_TOKEN is valid and not expired"
      ;;
    403)
      die "Railway API access forbidden" \
          "HTTP $http_code: Forbidden\nAPI URL: $API_URL" \
          "Check that your API token has permission for this operation"
      ;;
    404)
      die "Railway API endpoint not found" \
          "HTTP $http_code: Not Found\nAPI URL: $API_URL" \
          "The Railway API may have changed. Check for action updates."
      ;;
    429)
      die "Railway API rate limit exceeded" \
          "HTTP $http_code: Too Many Requests" \
          "Wait a few minutes and try again"
      ;;
    5*)
      die "Railway API server error" \
          "HTTP $http_code: Server Error\nResponse: $response" \
          "Railway may be experiencing issues. Check https://status.railway.app"
      ;;
    *)
      if [[ "$http_code" != "200" ]]; then
        die "Unexpected Railway API response" \
            "HTTP $http_code\nResponse: $response" \
            "Check Railway status or report this issue"
      fi
      ;;
  esac

  # Check for GraphQL errors
  if echo "$response" | grep -q '"errors"'; then
    local error_messages
    error_messages=$(echo "$response" | jq -r '.errors[].message' 2>/dev/null || echo "$response")

    # Provide specific hints based on common error patterns
    local hint="Check the Railway dashboard for more details"

    if echo "$error_messages" | grep -qi "not found"; then
      hint="Verify the service ID and environment ID are correct"
    elif echo "$error_messages" | grep -qi "permission"; then
      hint="Ensure your API token has access to this project"
    elif echo "$error_messages" | grep -qi "invalid"; then
      hint="Check that all input values are properly formatted"
    fi

    die "Railway GraphQL error during: $operation" \
        "Error(s):\n$error_messages" \
        "$hint"
  fi

  echo "$response"
}

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

update_image() {
  local service_id="$1"
  local name="$2"

  if [[ -z "$service_id" ]]; then
    die "Service ID is empty for [$name]" \
        "Service: $name\nService ID: (empty)" \
        "Check your services input - format should be 'label:service_id'"
  fi

  local input_json
  input_json=$(build_image_source_input)

  local variables
  variables=$(jq -n \
    --arg sid "$service_id" \
    --arg eid "$RAILWAY_ENV_ID" \
    --argjson input "$input_json" \
    '{sid: $sid, eid: $eid, input: $input}')

  echo "  ↳ Updating image on [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!,\$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:\$sid,environmentId:\$eid,input:\$input)}" \
    "$variables" \
    "update image on service [$name] (ID: $service_id)" \
    > /dev/null
}

redeploy() {
  local service_id="$1"
  local name="$2"

  if [[ -z "$service_id" ]]; then
    die "Service ID is empty for [$name]" \
        "Service: $name\nService ID: (empty)" \
        "Check your services input - format should be 'label:service_id'"
  fi

  local variables
  variables=$(jq -n \
    --arg sid "$service_id" \
    --arg eid "$RAILWAY_ENV_ID" \
    '{sid: $sid, eid: $eid}')

  echo "  ↳ Redeploying [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!){serviceInstanceRedeploy(serviceId:\$sid,environmentId:\$eid)}" \
    "$variables" \
    "redeploy service [$name] (ID: $service_id)" \
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
if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
  echo "🔐 Registry credentials: provided"
fi
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
