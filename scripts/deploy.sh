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

  echo "" >&2
  echo "::error::$message" >&2
  echo "────────────────────────────────────────────────────────────────" >&2
  echo "❌ ERROR: $message" >&2
  echo "" >&2

  if [[ -n "$details" ]]; then
    echo "Details:" >&2
    printf '%b\n' "$details" | sed 's/^/  /' >&2
    echo "" >&2
  fi

  if [[ -n "$hint" ]]; then
    echo "💡 Hint: $hint" >&2
    echo "" >&2
  fi

  echo "────────────────────────────────────────────────────────────────" >&2
  exit 1
}

# ── validate required inputs ────────────────────────────────────────

if [[ -z "${RAILWAY_API_TOKEN:-}" ]]; then
  die "RAILWAY_API_TOKEN is not set" \
      "The api-token input is required" \
      "Add 'api-token: \${{ secrets.RAILWAY_API_TOKEN }}' to your workflow"
fi

if [[ -z "${RAILWAY_ENV_ID:-}" ]]; then
  die "RAILWAY_ENV_ID is not set" \
      "The environment-id input is required" \
      "Add 'environment-id: \${{ vars.RAILWAY_ENV_ID }}' to your workflow"
fi

if [[ -z "${IMAGE_TAG:-}" ]]; then
  die "IMAGE_TAG is not set" \
      "The image input is required" \
      "Add 'image: ghcr.io/your-org/your-app:tag' to your workflow"
fi

if [[ -z "${SERVICES:-}" ]]; then
  die "SERVICES is not set" \
      "The services input is required" \
      "Add 'services: |' with 'label:service_id' pairs to your workflow"
fi

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

# ── auth header ──────────────────────────────────────────────────────

RAILWAY_TOKEN_TYPE="${RAILWAY_TOKEN_TYPE:-bearer}"

if [[ "$RAILWAY_TOKEN_TYPE" == "project" ]]; then
  AUTH_HEADER="Project-Access-Token: $RAILWAY_API_TOKEN"
else
  AUTH_HEADER="Authorization: Bearer $RAILWAY_API_TOKEN"
fi

# ── helpers ──────────────────────────────────────────────────────────

railway_gql() {
  local query="$1"
  local variables="$2"
  local operation="${3:-GraphQL request}"

  debug_log "railway_gql operation: $operation"
  debug_log "railway_gql query: $query"
  debug_log "railway_gql variables: $variables"

  local body
  body=$(jq -n --arg q "$query" --argjson v "$variables" '{query: $q, variables: $v}')

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] Would send to $API_URL:"
    echo "[DRY-RUN]   Operation: $operation"
    echo "[DRY-RUN]   Body:"
    echo "$body" | jq . 2>/dev/null || echo "$body"
    echo '{"data":{"dryRun":true}}'
    return 0
  fi

  local http_code
  local response
  local tmp_file
  tmp_file=$(mktemp)

  http_code=$(curl -s -w "%{http_code}" -X POST "$API_URL" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$body" \
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

  response=$(<"$tmp_file")
  rm -f "$tmp_file"

  case $http_code in
    200) ;;
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
    400)
      die "Railway API bad request during: $operation" \
          "HTTP $http_code: Bad Request\nResponse: $response" \
          "Check that service IDs, environment ID, and input fields are correct"
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
      die "Unexpected Railway API response" \
          "HTTP $http_code\nResponse: $response" \
          "Check Railway status or report this issue"
      ;;
  esac

  if echo "$response" | grep -q '"errors"'; then
    local error_messages
    error_messages=$(echo "$response" | jq -r '.errors[].message' 2>/dev/null || echo "$response")

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

build_service_update_input() {
  local result
  if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
    result=$(jq -n \
      --arg image "$IMAGE_TAG" \
      --arg username "$REGISTRY_USERNAME" \
      --arg password "$REGISTRY_PASSWORD" \
      '{source: {image: $image}, registryCredentials: {username: $username, password: $password}}')
  else
    result=$(jq -n --arg image "$IMAGE_TAG" '{source: {image: $image}}')
  fi
  debug_log "build_service_update_input: $result"
  echo "$result"
}

validate_service_id() {
  local service_id="$1"
  local name="$2"

  if [[ -z "$service_id" ]]; then
    die "Service ID is empty for [$name]" \
        "Service: $name\nService ID: (empty)" \
        "Check your services input - format should be 'label:service_id'"
  fi
}

update_image() {
  local service_id="$1"
  local name="$2"

  validate_service_id "$service_id" "$name"

  local input_json
  input_json=$(build_service_update_input)

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

  validate_service_id "$service_id" "$name"

  local variables
  variables=$(jq -n \
    --arg sid "$service_id" \
    --arg eid "$RAILWAY_ENV_ID" \
    '{sid: $sid, eid: $eid}')

  echo "  ↳ Deploying [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!){serviceInstanceDeploy(serviceId:\$sid,environmentId:\$eid)}" \
    "$variables" \
    "deploy service [$name] (ID: $service_id)" \
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

if [[ "$AUTH_HEADER" == Project-Access-Token:* ]]; then
  echo "🔑 Token type: project"
else
  echo "🔑 Token type: account/workspace"
fi
echo "🐳 Image: $IMAGE_TAG"
echo "🌍 Environment: $RAILWAY_ENV_ID"
echo "📦 Services (${#SERVICE_MAP[@]}): ${!SERVICE_MAP[*]}"
if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
  echo "🔐 Registry credentials: provided"
fi
echo ""

# ── update + redeploy ────────────────────────────────────────────────

if [[ -n "${FIRST_SERVICE:-}" ]]; then
  # ── ordered deploy (3 steps) ──────────────────────────────────────

  echo "Step 1/3: Updating image source on all services"
  for label in "${!SERVICE_MAP[@]}"; do
    update_image "${SERVICE_MAP[$label]}" "$label"
  done
  echo ""

  if [[ -z "${SERVICE_MAP[$FIRST_SERVICE]+x}" ]]; then
    available_labels=$(printf '%s, ' "${!SERVICE_MAP[@]}")
    die "first-service '$FIRST_SERVICE' not found in services list" \
        "Requested first-service: $FIRST_SERVICE\nAvailable services: ${available_labels%, }" \
        "Use one of the available service labels, or remove the first-service input"
  fi

  echo "Step 2/3: Redeploying [$FIRST_SERVICE] first"
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
  # ── parallel deploy (2 steps) ─────────────────────────────────────

  echo "Step 1/2: Updating image source on all services"
  for label in "${!SERVICE_MAP[@]}"; do
    update_image "${SERVICE_MAP[$label]}" "$label"
  done
  echo ""

  echo "Step 2/2: Redeploying all services"
  for label in "${!SERVICE_MAP[@]}"; do
    redeploy "${SERVICE_MAP[$label]}" "$label"
    DEPLOYED+=("$label")
  done
fi

echo ""
echo "✅ Deploy complete (${#DEPLOYED[@]} services): ${DEPLOYED[*]}"

# ── outputs ──────────────────────────────────────────────────────────

IFS=','
echo "deployed-services=${DEPLOYED[*]}" >> "$GITHUB_OUTPUT"
