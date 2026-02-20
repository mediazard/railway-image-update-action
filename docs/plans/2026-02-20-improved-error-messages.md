# Improved Error Messages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enhance deploy.sh with detailed, actionable error messages that include context about what failed, why it might have failed, and how to fix it.

**Architecture:** Add a centralized `die()` function for consistent error formatting. Wrap each operation with context-specific error handling. Include relevant variable values in error output to aid debugging. Use GitHub Actions error annotations for visibility.

**Tech Stack:** Bash, GitHub Actions annotations (`::error::`, `::warning::`)

---

## Task 1: Add centralized error handling function

**Files:**
- Modify: `scripts/deploy.sh:6-28`

**Step 1: Add die() helper function after set -euo pipefail**

Replace the helpers section with:

```bash
#!/usr/bin/env bash
set -euo pipefail

API_URL="https://backboard.railway.app/graphql/v2"

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

# ── helpers ──────────────────────────────────────────────────────────

railway_gql() {
  local query="$1"
  local variables="$2"
  local operation="${3:-GraphQL request}"

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
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
jj commit -m "feat: add centralized error handling with detailed messages"
```

---

## Task 2: Update update_image with operation context

**Files:**
- Modify: `scripts/deploy.sh` (update_image function)

**Step 1: Update the update_image function**

```bash
update_image() {
  local service_id="$1"
  local name="$2"

  if [[ -z "$service_id" ]]; then
    die "Service ID is empty for [$name]" \
        "Service: $name\nService ID: (empty)" \
        "Check your services input - format should be 'label:service_id'"
  fi

  echo "  ↳ Updating image on [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!,\$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(serviceId:\$sid,environmentId:\$eid,input:\$input)}" \
    "{\"sid\":\"$service_id\",\"eid\":\"$RAILWAY_ENV_ID\",\"input\":{\"source\":{\"image\":\"$IMAGE_TAG\"}}}" \
    "update image on service [$name] (ID: $service_id)" \
    > /dev/null
}
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
jj commit -m "feat: add context to update_image errors"
```

---

## Task 3: Update redeploy with operation context

**Files:**
- Modify: `scripts/deploy.sh` (redeploy function)

**Step 1: Update the redeploy function**

```bash
redeploy() {
  local service_id="$1"
  local name="$2"

  if [[ -z "$service_id" ]]; then
    die "Service ID is empty for [$name]" \
        "Service: $name\nService ID: (empty)" \
        "Check your services input - format should be 'label:service_id'"
  fi

  echo "  ↳ Redeploying [$name]"
  railway_gql \
    "mutation(\$sid:String!,\$eid:String!){serviceInstanceRedeploy(serviceId:\$sid,environmentId:\$eid)}" \
    "{\"sid\":\"$service_id\",\"eid\":\"$RAILWAY_ENV_ID\"}" \
    "redeploy service [$name] (ID: $service_id)" \
    > /dev/null
}
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
jj commit -m "feat: add context to redeploy errors"
```

---

## Task 4: Add input validation with helpful errors

**Files:**
- Modify: `scripts/deploy.sh` (after helpers, before parsing)

**Step 1: Add input validation section**

Add this after the helpers section, before `declare -A SERVICE_MAP`:

```bash
# ── input validation ─────────────────────────────────────────────────

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
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
jj commit -m "feat: add input validation with helpful error messages"
```

---

## Task 5: Improve service parsing errors

**Files:**
- Modify: `scripts/deploy.sh` (service parsing section)

**Step 1: Update the service parsing with validation**

```bash
# ── parse services input ─────────────────────────────────────────────

declare -A SERVICE_MAP
DEPLOYED=()
line_num=0

while IFS= read -r line; do
  ((line_num++))
  [[ -z "$line" ]] && continue

  # Validate format: must contain exactly one colon
  if [[ "$line" != *:* ]]; then
    die "Invalid service format on line $line_num" \
        "Line: '$line'\nExpected format: 'label:service_id'" \
        "Each line must be 'label:service_id' (e.g., 'web:abc123-def456')"
  fi

  label="${line%%:*}"
  id="${line#*:}"

  if [[ -z "$label" ]]; then
    die "Empty label on line $line_num" \
        "Line: '$line'" \
        "Add a label before the colon (e.g., 'web:$id')"
  fi

  if [[ -z "$id" ]]; then
    die "Empty service ID for label '$label' on line $line_num" \
        "Line: '$line'" \
        "Add the service ID after the colon (e.g., '$label:your-service-id')"
  fi

  # Check for duplicate labels
  if [[ -n "${SERVICE_MAP[$label]+x}" ]]; then
    die "Duplicate service label '$label'" \
        "Label '$label' appears multiple times in services input" \
        "Each service label must be unique"
  fi

  SERVICE_MAP["$label"]="$id"
done <<< "$SERVICES"

if [[ ${#SERVICE_MAP[@]} -eq 0 ]]; then
  die "No services found in input" \
      "Services input:\n$SERVICES" \
      "Add at least one 'label:service_id' pair"
fi
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
jj commit -m "feat: improve service parsing with detailed validation errors"
```

---

## Task 6: Improve first-service error

**Files:**
- Modify: `scripts/deploy.sh` (first-service check)

**Step 1: Update the first-service validation**

Replace the existing first-service check:

```bash
if [[ -n "$FIRST_SERVICE" ]]; then
  echo "Step 2/3: Redeploying [$FIRST_SERVICE] first"

  if [[ -z "${SERVICE_MAP[$FIRST_SERVICE]+x}" ]]; then
    available_labels=$(IFS=', '; echo "${!SERVICE_MAP[*]}")
    die "first-service '$FIRST_SERVICE' not found in services list" \
        "Requested first-service: $FIRST_SERVICE\nAvailable services: $available_labels" \
        "Use one of the available service labels, or remove the first-service input"
  fi
```

**Step 2: Verify bash syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: Commit**

```bash
jj commit -m "feat: improve first-service error with available options"
```

---

## Task 7: Final verification and squash

**Files:**
- None (verification only)

**Step 1: Verify full script syntax**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 2: View all commits**

Run: `jj log --limit 10`
Expected: 6 commits for this feature

**Step 3: Squash all commits into one**

```bash
jj squash --from <first-commit>::<last-commit> --into <first-commit> -m "feat: add detailed error messages with context and hints

- Centralized die() function for consistent error formatting
- HTTP status code handling with specific messages
- curl error code handling (DNS, timeout, SSL, etc.)
- GraphQL error parsing with contextual hints
- Input validation with workflow examples
- Service parsing validation with line numbers
- first-service error shows available options"
```

**Step 4: Push to main**

```bash
jj bookmark set main -r @ && jj git push --bookmark main
```

**Step 5: Update version tags**

```bash
git tag -fa v1.0.1 -m "Improved error messages" && git tag -fa v1 -m "Point to latest v1.x.x" && git push origin v1.0.1 v1 --force
```

---

## Summary

| Task | Description | What it adds |
|------|-------------|--------------|
| 1 | Centralized error handling | `die()` function, HTTP/curl error handling |
| 2 | update_image context | Operation name in errors |
| 3 | redeploy context | Operation name in errors |
| 4 | Input validation | Required field checks with examples |
| 5 | Service parsing | Line numbers, format validation |
| 6 | first-service error | Shows available service labels |
| 7 | Final verification | Squash and release |

**Error message format:**
```
::error::Brief message for GitHub UI

────────────────────────────────────────────────────────────────
❌ ERROR: Brief message

Details:
  Contextual information
  Variable values

💡 Hint: How to fix it

────────────────────────────────────────────────────────────────
```
