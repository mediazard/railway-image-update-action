#!/usr/bin/env bash
set -euo pipefail

API_URL="https://backboard.railway.app/graphql/v2"

DRY_RUN="${DRY_RUN:-false}"
DEBUG="${DEBUG:-false}"

# ── early-init state (must exist before trap fires) ──────────────────

DEPLOYED=()
DEPLOYMENT_IDS=()
LABELS=()
RESOLVED_IMAGE_TAG=""
DOCKER_LOGIN_REGISTRY=""
hdr_file=""

# ── unified exit trap (outputs + docker logout) ──────────────────────

flush_outputs() {
  local deployed_str failed_str
  local failed=()

  # Build comma-joined deployed list
  if [[ ${#DEPLOYED[@]} -gt 0 ]]; then
    IFS=',' deployed_str="${DEPLOYED[*]}"
  else
    deployed_str=""
  fi

  # Build failed list: LABELS minus DEPLOYED
  for lbl in "${LABELS[@]}"; do
    local found=0
    for d in "${DEPLOYED[@]}"; do
      if [[ "$d" == "$lbl" ]]; then
        found=1
        break
      fi
    done
    if [[ $found -eq 0 ]]; then
      failed+=("$lbl")
    fi
  done

  if [[ ${#failed[@]} -gt 0 ]]; then
    IFS=',' failed_str="${failed[*]}"
  else
    failed_str=""
  fi

  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "deployed-services=${deployed_str}" >> "$GITHUB_OUTPUT"
    echo "failed-services=${failed_str}" >> "$GITHUB_OUTPUT"
    if [[ -n "$RESOLVED_IMAGE_TAG" ]]; then
      echo "image-tag=${RESOLVED_IMAGE_TAG}" >> "$GITHUB_OUTPUT"
    fi
    if [[ ${#DEPLOYMENT_IDS[@]} -gt 0 ]]; then
      {
        printf 'deployment-ids<<EOF\n'
        printf '%s\n' "${DEPLOYMENT_IDS[@]}"
        printf 'EOF\n'
      } >> "$GITHUB_OUTPUT"
    fi
  fi

  # Best-effort docker logout if PR 2's resolve-to-digest logged us in
  if [[ -n "$DOCKER_LOGIN_REGISTRY" ]]; then
    docker logout "$DOCKER_LOGIN_REGISTRY" >/dev/null 2>&1 || true
  fi

  # Remove the auth-header tmpfile written near script start
  [[ -n "${hdr_file:-}" ]] && rm -f "$hdr_file"
}

trap flush_outputs EXIT

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

# ── validate input shapes ────────────────────────────────────────────

# WAIT_SECONDS must be a non-negative integer
if [[ -n "${WAIT_SECONDS:-}" ]] && [[ ! "${WAIT_SECONDS}" =~ ^[0-9]+$ ]]; then
  die "wait-seconds must be a non-negative integer" \
      "wait-seconds: '${WAIT_SECONDS}'" \
      "Use a numeric value, e.g. 'wait-seconds: 30'"
fi

# IMAGE_TAG must match a basic registry/repo shape with a tag or digest
# Accepts: registry/repo:tag  OR  registry/repo@sha256:<64 hex chars>
if [[ -n "${IMAGE_TAG:-}" ]] && \
   ! [[ "${IMAGE_TAG}" =~ ^[a-z0-9._/-]+(:[a-zA-Z0-9._-]+|@sha256:[0-9a-f]{64})?$ ]]; then
  die "image tag has an invalid format" \
      "image: '${IMAGE_TAG}'\nExpected: <registry>/<repo>:<tag>  or  <registry>/<repo>@sha256:<64-hex-chars>" \
      "Example: 'ghcr.io/my-org/my-app:sha-abc123' or 'ghcr.io/my-org/my-app@sha256:abc...'"
fi

# RAILWAY_ENV_ID must be a UUID
if [[ -n "${RAILWAY_ENV_ID:-}" ]] && \
   ! [[ "${RAILWAY_ENV_ID}" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  die "RAILWAY_ENV_ID is not a valid UUID" \
      "RAILWAY_ENV_ID: '${RAILWAY_ENV_ID}'" \
      "Copy the environment UUID from the Railway dashboard (Settings → Environments)"
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

RESOLVE_TO_DIGEST="${RESOLVE_TO_DIGEST:-true}"
ALLOW_MUTABLE_TAG="${ALLOW_MUTABLE_TAG:-false}"

# ── auth header ──────────────────────────────────────────────────────

RAILWAY_TOKEN_TYPE="${RAILWAY_TOKEN_TYPE:-bearer}"

if [[ "$RAILWAY_TOKEN_TYPE" == "project" ]]; then
  AUTH_HEADER="Project-Access-Token: $RAILWAY_API_TOKEN"
else
  AUTH_HEADER="Authorization: Bearer $RAILWAY_API_TOKEN"
fi

# Write auth header to a temp file (chmod 600) so it never appears in argv/ps.
# Cleanup happens inside flush_outputs() (the unified EXIT trap).
hdr_file=$(mktemp)
chmod 600 "$hdr_file"
printf '%s\n' "$AUTH_HEADER" > "$hdr_file"

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
    # Diagnostic output goes to stderr so callers can capture the JSON from stdout.
    echo "[DRY-RUN] Would send to $API_URL:" >&2
    echo "[DRY-RUN]   Operation: $operation" >&2
    echo "[DRY-RUN]   Body:" >&2
    echo "$body" | jq . 2>/dev/null >&2 || echo "$body" >&2
    # For deploy mutations, return a stub deployment ID so callers can exercise
    # the deployment-id logging path in dry-run mode.
    if [[ "$query" == *"serviceInstanceDeploy"* ]]; then
      echo '{"data":{"serviceInstanceDeploy":"dry-run-deploy-id"}}'
    else
      echo '{"data":{"dryRun":true}}'
    fi
    return 0
  fi

  # ── retry loop: up to 3 attempts with exponential backoff + jitter ──
  # Retries on HTTP 429/502/503/504 and curl exit codes 6/7/28.
  # Non-retryable 4xx errors (401, 403, 400, 404) exit immediately.
  local max_attempts=3
  local attempt=0
  local http_code response tmp_file curl_exit delay

  while true; do
    attempt=$(( attempt + 1 ))
    if [[ $attempt -gt 1 ]]; then
      echo "Attempt $attempt/$max_attempts for: $operation" >&2
    fi

    tmp_file=$(mktemp)
    curl_exit=0
    http_code=$(curl -s -w "%{http_code}" -X POST "$API_URL" \
      --header-file "$hdr_file" \
      -H "Content-Type: application/json" \
      -d "$body" \
      -o "$tmp_file" 2>&1) || curl_exit=$?

    if [[ $curl_exit -ne 0 ]]; then
      rm -f "$tmp_file"
      # Retryable curl exit codes: 6 (DNS), 7 (connect refused), 28 (timeout)
      if [[ $attempt -lt $max_attempts ]] && [[ $curl_exit -eq 6 || $curl_exit -eq 7 || $curl_exit -eq 28 ]]; then
        delay=$(( (2 ** (attempt - 1)) + (RANDOM % 3) ))
        echo "Attempt $attempt/$max_attempts failed (curl exit $curl_exit). Retrying in ${delay}s..." >&2
        sleep "$delay"
        continue
      fi
      case $curl_exit in
        6)  die "Could not resolve Railway API host" \
                "curl exit code: $curl_exit (DNS resolution failed) after $attempt attempt(s)" \
                "Check your network connection and DNS settings. Railway status: https://status.railway.app" ;;
        7)  die "Could not connect to Railway API" \
                "curl exit code: $curl_exit (connection refused) after $attempt attempt(s)" \
                "Railway API may be down. Check https://status.railway.app" ;;
        28) die "Railway API request timed out" \
                "curl exit code: $curl_exit (operation timeout) after $attempt attempt(s)" \
                "Try again or check Railway status at https://status.railway.app" ;;
        35) die "SSL/TLS connection failed" \
                "curl exit code: $curl_exit (SSL connect error)" \
                "Check your network security settings" ;;
        *)  die "Railway API request failed" \
                "curl exit code: $curl_exit after $attempt attempt(s)" \
                "Check your network connection" ;;
      esac
    fi

    response=$(<"$tmp_file")
    rm -f "$tmp_file"

    # Determine if we should retry based on HTTP status
    case $http_code in
      200)
        # Success — fall through to response handling below
        break
        ;;
      429 | 502 | 503 | 504)
        if [[ $attempt -lt $max_attempts ]]; then
          delay=$(( (2 ** (attempt - 1)) + (RANDOM % 3) ))
          echo "Attempt $attempt/$max_attempts failed (HTTP $http_code). Retrying in ${delay}s..." >&2
          sleep "$delay"
          continue
        fi
        # Final attempt exhausted
        case $http_code in
          429)
            die "Railway API rate limit exceeded" \
                "HTTP $http_code: Too Many Requests — $attempt attempt(s) made" \
                "Wait a few minutes and try again. Check https://status.railway.app"
            ;;
          *)
            die "Railway API server error" \
                "HTTP $http_code: Server Error after $attempt attempt(s)\nResponse: $response" \
                "Railway may be experiencing issues. Check https://status.railway.app"
            ;;
        esac
        ;;
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
      5*)
        if [[ $attempt -lt $max_attempts ]]; then
          delay=$(( (2 ** (attempt - 1)) + (RANDOM % 3) ))
          echo "Attempt $attempt/$max_attempts failed (HTTP $http_code). Retrying in ${delay}s..." >&2
          sleep "$delay"
          continue
        fi
        die "Railway API server error" \
            "HTTP $http_code: Server Error after $attempt attempt(s)\nResponse: $response" \
            "Railway may be experiencing issues. Check https://status.railway.app"
        ;;
      *)
        die "Unexpected Railway API response" \
            "HTTP $http_code\nResponse: $response" \
            "Check Railway status or report this issue"
        ;;
    esac
  done

  # ── GraphQL error handling ───────────────────────────────────────────
  # Use jq instead of grep to detect errors — handles escaped/nested JSON correctly.
  # Railway may return a partial response: {data: ..., errors: [...]}.
  # In that case, log the errors as warnings but return success so callers can
  # inspect the data payload. Only die when data is absent or null.
  if jq -e '.errors // empty' <<< "$response" >/dev/null 2>&1; then
    local error_messages
    error_messages=$(jq -r '.errors[].message' <<< "$response" 2>/dev/null || echo "$response")

    if jq -e '.data != null' <<< "$response" >/dev/null 2>&1; then
      # Partial success: data present alongside errors — warn but do not die
      echo "::warning::Railway GraphQL partial response during: $operation" >&2
      echo "  Warnings from Railway API:" >&2
      printf '%s\n' "$error_messages" | sed 's/^/    /' >&2
    else
      # No usable data — treat as failure
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
  fi

  echo "$response"
}

build_service_update_input() {
  local result
  if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
    result=$(jq -n \
      --arg image "$RESOLVED_IMAGE_TAG" \
      --arg username "$REGISTRY_USERNAME" \
      --arg password "$REGISTRY_PASSWORD" \
      '{source: {image: $image}, registryCredentials: {username: $username, password: $password}}')
  else
    result=$(jq -n --arg image "$RESOLVED_IMAGE_TAG" '{source: {image: $image}}')
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

# Returns 0 (true) if the image ref looks mutable (no tag, or a known mutable tag).
# A ref is considered mutable if:
#   - it contains no ':' after the final '/' (i.e. no tag at all), or
#   - the tag portion matches: latest, main, master, develop, or stable.
# Refs already containing '@sha256:' are never mutable.
is_mutable_ref() {
  local ref="$1"

  # A digest-pinned ref is never mutable
  if [[ "$ref" == *"@sha256:"* ]]; then
    return 1
  fi

  # Extract tag portion: everything after the last ':'
  # But only if the ':' appears after the last '/' (to avoid matching port numbers)
  local after_slash="${ref##*/}"  # strip registry + path prefix
  if [[ "$after_slash" == *":"* ]]; then
    local tag="${after_slash##*:}"
    case "$tag" in
      latest|main|master|develop|stable) return 0 ;;
      *) return 1 ;;
    esac
  else
    # No tag separator found after the last path segment → tagless ref, mutable
    return 0
  fi
}

# Resolves an image ref to its digest-pinned form.
# Prints the resolved ref (e.g. ghcr.io/org/app@sha256:...) to stdout.
# Dies with a clear message if resolution fails.
resolve_image_digest() {
  local ref="$1"

  # Already pinned — nothing to do
  if [[ "$ref" == *"@sha256:"* ]]; then
    debug_log "resolve_image_digest: ref already digest-pinned, skipping"
    echo "$ref"
    return 0
  fi

  # Under DRY_RUN, return a stub so existing tests stay green
  if [[ "$DRY_RUN" == "true" ]]; then
    local stub_ref="${ref%%:*}@sha256:dryrun"
    # Keep registry + path but replace tag with stub digest
    # Pattern: strip :<tag> if present, then append @sha256:dryrun
    if [[ "$ref" == *:* ]]; then
      stub_ref="${ref%:*}@sha256:dryrun"
    else
      stub_ref="${ref}@sha256:dryrun"
    fi
    echo "[DRY-RUN] Resolving manifest digest for: $ref" >&2
    echo "[DRY-RUN] Resolved to (stub): $stub_ref" >&2
    echo "$stub_ref"
    return 0
  fi

  echo "  🔍 Resolving manifest digest for: $ref" >&2

  # Extract registry host (everything before the first '/')
  local registry="${ref%%/*}"

  # Docker login if credentials provided
  local logged_in="false"
  if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
    debug_log "resolve_image_digest: logging in to $registry"
    if ! echo "$REGISTRY_PASSWORD" | docker login "$registry" \
         -u "$REGISTRY_USERNAME" --password-stdin >/dev/null 2>&1; then
      die "Registry login failed during digest resolution" \
          "Registry: $registry\nUsername: $REGISTRY_USERNAME" \
          "Verify registry-username and registry-password are correct"
    fi
    logged_in="true"
  fi

  # Record registry so the unified flush_outputs EXIT trap logs us out
  if [[ "$logged_in" == "true" ]]; then
    DOCKER_LOGIN_REGISTRY="$registry"
  fi

  local digest
  local inspect_err
  inspect_err=$(mktemp)

  if ! digest=$(docker buildx imagetools inspect "$ref" \
       --format '{{json .Manifest}}' 2>"$inspect_err" | jq -r '.digest'); then
    local err_detail
    err_detail=$(<"$inspect_err")
    rm -f "$inspect_err"
    die "Failed to resolve manifest digest for image" \
        "Image: $ref\nError: $err_detail" \
        "Check that the image exists, is accessible, and registry credentials are correct"
  fi
  rm -f "$inspect_err"

  if [[ -z "$digest" || "$digest" == "null" ]]; then
    die "Manifest digest resolution returned empty result" \
        "Image: $ref\nReturned digest: (empty)" \
        "Ensure the image tag exists and the registry is reachable"
  fi

  # Build the digest-pinned ref: strip any existing tag, append @sha256:...
  local base_ref="$ref"
  # Remove :<tag> suffix if present (but not if it looks like a port before a slash)
  local after_slash="${ref##*/}"
  if [[ "$after_slash" == *":"* ]]; then
    base_ref="${ref%:*}"
  fi
  local resolved="${base_ref}@${digest}"

  echo "  ✓ Resolved: $resolved" >&2
  echo "$resolved"
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
  local response
  response=$(railway_gql \
    "mutation(\$sid:String!,\$eid:String!){serviceInstanceDeploy(serviceId:\$sid,environmentId:\$eid)}" \
    "$variables" \
    "deploy service [$name] (ID: $service_id)")

  # Parse deployment ID from response.
  # Railway's serviceInstanceDeploy mutation returns the deployment ID as a plain
  # string at .data.serviceInstanceDeploy (not a nested object).
  local deploy_id
  deploy_id=$(printf '%s' "$response" | jq -r '.data.serviceInstanceDeploy // empty' 2>/dev/null || true)

  if [[ -n "$deploy_id" && "$deploy_id" != "null" && "$deploy_id" != "true" ]]; then
    echo "[$name] deployment-id: $deploy_id"
    DEPLOYMENT_IDS+=("$name=$deploy_id")
  else
    echo "[$name] deployment-id: (unavailable — raw response: $response)" >&2
  fi
}

# ── resolve image digest ─────────────────────────────────────────────

RESOLVED_IMAGE_TAG="$IMAGE_TAG"

if [[ "$RESOLVE_TO_DIGEST" == "true" ]]; then
  RESOLVED_IMAGE_TAG=$(resolve_image_digest "$IMAGE_TAG")
else
  # resolve-to-digest is off — check for mutable refs unless explicitly allowed
  if [[ "$ALLOW_MUTABLE_TAG" != "true" ]] && is_mutable_ref "$IMAGE_TAG"; then
    die "Refusing to deploy mutable tag" \
        "Image: $IMAGE_TAG\nThe tag appears to be mutable (e.g. :latest, :main, :master, :develop, :stable, or no tag)" \
        "Either use an immutable tag (e.g. sha-\${{ github.sha }} or @sha256:...), set resolve-to-digest: true (the default), or set allow-mutable-tag: true to bypass this check"
  fi
fi

# ── parse services input ─────────────────────────────────────────────

declare -A SERVICE_MAP

# UUID pattern used for both service IDs and RAILWAY_ENV_ID validation
UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

while IFS= read -r line; do
  # Strip trailing \r (CRLF from Windows editors) and skip blank lines
  line="${line%$'\r'}"
  [[ -z "$line" ]] && continue

  label="${line%%:*}"
  id="${line#*:}"

  # Trim leading/trailing whitespace and \r from label and id
  label="${label#"${label%%[![:space:]]*}"}"
  label="${label%"${label##*[![:space:]]}"}"
  id="${id#"${id%%[![:space:]]*}"}"
  id="${id%"${id##*[![:space:]]}"}"

  # Reject empty label
  if [[ -z "$label" ]]; then
    die "Service label is empty" \
        "Offending line: '$line'" \
        "Each line in 'services' must be 'label:service_uuid'"
  fi

  # Validate service UUID shape
  if [[ ! "$id" =~ $UUID_PATTERN ]]; then
    die "Service ID for [$label] is not a valid UUID" \
        "Label: '$label'\nService ID: '$id'" \
        "Copy the service UUID from the Railway dashboard (Service → Settings)"
  fi

  SERVICE_MAP["$label"]="$id"
  LABELS+=("$label")
done <<< "$SERVICES"

if [[ "$AUTH_HEADER" == Project-Access-Token:* ]]; then
  echo "🔑 Token type: project"
else
  echo "🔑 Token type: account/workspace"
fi
if [[ "$RESOLVED_IMAGE_TAG" != "$IMAGE_TAG" ]]; then
  echo "🐳 Image (input):    $IMAGE_TAG"
  echo "🐳 Image (resolved): $RESOLVED_IMAGE_TAG"
else
  echo "🐳 Image: $IMAGE_TAG"
fi
echo "🌍 Environment: $RAILWAY_ENV_ID"
echo "📦 Services (${#LABELS[@]}): ${LABELS[*]}"
if [[ "$HAS_REGISTRY_CREDENTIALS" == "true" ]]; then
  echo "🔐 Registry credentials: provided"
fi
echo ""

# ── update + redeploy ────────────────────────────────────────────────

if [[ -n "${FIRST_SERVICE:-}" ]]; then
  # ── ordered deploy (3 steps) ──────────────────────────────────────

  if [[ -z "${SERVICE_MAP[$FIRST_SERVICE]+x}" ]]; then
    available_labels=$(printf '%s, ' "${LABELS[@]}")
    die "first-service '$FIRST_SERVICE' not found in services list" \
        "Requested first-service: $FIRST_SERVICE\nAvailable services: ${available_labels%, }" \
        "Use one of the available service labels, or remove the first-service input"
  fi

  echo "Step 1/3: Updating image source and redeploying [$FIRST_SERVICE] first"
  update_image "${SERVICE_MAP[$FIRST_SERVICE]}" "$FIRST_SERVICE"
  redeploy "${SERVICE_MAP[$FIRST_SERVICE]}" "$FIRST_SERVICE"
  DEPLOYED+=("$FIRST_SERVICE")

  echo "  ⏳ Waiting ${WAIT_SECONDS}s for first service to stabilise..."
  sleep "$WAIT_SECONDS"
  echo ""

  echo "Step 2/3: Updating image source on remaining services"
  for label in "${LABELS[@]}"; do
    if [[ "$label" != "$FIRST_SERVICE" ]]; then
      update_image "${SERVICE_MAP[$label]}" "$label"
    fi
  done
  echo ""

  echo "Step 3/3: Redeploying remaining services"
  for label in "${LABELS[@]}"; do
    if [[ "$label" != "$FIRST_SERVICE" ]]; then
      redeploy "${SERVICE_MAP[$label]}" "$label"
      DEPLOYED+=("$label")
    fi
  done
else
  # ── parallel deploy (2 steps) ─────────────────────────────────────

  echo "Step 1/2: Updating image source on all services"
  for label in "${LABELS[@]}"; do
    update_image "${SERVICE_MAP[$label]}" "$label"
  done
  echo ""

  echo "Step 2/2: Redeploying all services"
  for label in "${LABELS[@]}"; do
    redeploy "${SERVICE_MAP[$label]}" "$label"
    DEPLOYED+=("$label")
  done
fi

echo ""
echo "✅ Deploy complete (${#DEPLOYED[@]} services): ${DEPLOYED[*]}"
