# Railway Deploy Action Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a reusable composite GitHub Action that updates Docker image tags on Railway services and triggers redeployment via the Railway GraphQL API.

**Architecture:** Pure bash composite action with no external dependencies beyond `curl` and `jq` (pre-installed on GitHub runners). The action accepts service mappings as `label:id` pairs, updates the Docker image source on all services via GraphQL, then optionally redeploys a "first service" before the rest with a configurable wait period.

**Tech Stack:** Bash, GitHub Actions (composite), Railway GraphQL API v2

**Version Control:** Uses `jj` (Jujutsu) instead of plain git.

---

## Task 1: Create action.yml metadata file

**Files:**
- Create: `action.yml`

**Step 1: Create the action metadata file**

```yaml
name: "Railway Deploy"
description: "Update Docker image and redeploy services on Railway via GraphQL API"
author: "HarleyTherapy"

inputs:
  api-token:
    description: "Railway API token"
    required: true
  environment-id:
    description: "Railway environment ID"
    required: true
  image:
    description: "Full Docker image URI with tag (e.g. ghcr.io/org/app:sha-abc123)"
    required: true
  services:
    description: "Multiline label:service_id pairs. Labels are for logging only. All services get the same image."
    required: true
  first-service:
    description: "Label of the service to redeploy before all others. Remaining services deploy after wait."
    required: false
    default: ""
  wait-seconds:
    description: "Seconds to wait after first-service redeploys before deploying the rest"
    required: false
    default: "30"

outputs:
  deployed-services:
    description: "Comma-separated list of deployed service names"
    value: ${{ steps.deploy.outputs.deployed-services }}
  image-tag:
    description: "The image tag that was deployed"
    value: ${{ inputs.image }}

runs:
  using: "composite"
  steps:
    - name: Deploy to Railway
      id: deploy
      shell: bash
      env:
        RAILWAY_API_TOKEN: ${{ inputs.api-token }}
        RAILWAY_ENV_ID: ${{ inputs.environment-id }}
        IMAGE_TAG: ${{ inputs.image }}
        SERVICES: ${{ inputs.services }}
        FIRST_SERVICE: ${{ inputs.first-service }}
        WAIT_SECONDS: ${{ inputs.wait-seconds }}
      run: ${{ github.action_path }}/scripts/deploy.sh
```

**Step 2: Verify the file was created**

Run: `cat action.yml`
Expected: The YAML content above is displayed

**Step 3: Commit with jj**

```bash
jj commit -m "feat: add action.yml metadata file"
```

---

## Task 2: Create the deploy script

**Files:**
- Create: `scripts/deploy.sh`

**Step 1: Create the scripts directory and deploy.sh file**

```bash
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
```

**Step 2: Make the script executable**

Run: `chmod +x scripts/deploy.sh`
Expected: No output (success)

**Step 3: Verify the script is executable**

Run: `ls -la scripts/deploy.sh`
Expected: `-rwxr-xr-x` permissions shown

**Step 4: Run shellcheck to validate script**

Run: `shellcheck scripts/deploy.sh || echo "shellcheck not installed, skipping"`
Expected: No errors (or shellcheck not installed message)

**Step 5: Commit with jj**

```bash
jj commit -m "feat: add deploy.sh script with Railway GraphQL API integration"
```

---

## Task 3: Create README.md documentation

**Files:**
- Create: `README.md`

**Step 1: Create the README file**

```markdown
# Railway Deploy Action

A reusable composite GitHub Action that updates Docker image tags on Railway services and triggers redeployment via the Railway GraphQL API.

## Features

- Framework-agnostic, service-count-agnostic
- Supports ordered deployments (deploy one service first, wait, then deploy the rest)
- Pure bash — no Node.js or additional dependencies
- Works with any Docker registry accessible by Railway

## Usage

### Basic (single service)

```yaml
- name: Deploy to Railway
  uses: HarleyTherapy/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: ghcr.io/myorg/myapp:latest
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
```

### Ordered deployment (multiple services)

```yaml
- name: Deploy to Railway
  uses: HarleyTherapy/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_PROD_ENV_ID }}
    image: ghcr.io/myorg/myapp:sha-${{ github.sha }}
    services: |
      web:${{ vars.RAILWAY_WEB_SERVICE_ID }}
      worker:${{ vars.RAILWAY_WORKER_SERVICE_ID }}
      clock:${{ vars.RAILWAY_CLOCK_SERVICE_ID }}
    first-service: web
    wait-seconds: "60"
```

## Inputs

| Input            | Required | Default | Description                                                                 |
| ---------------- | -------- | ------- | --------------------------------------------------------------------------- |
| `api-token`      | Yes      | —       | Railway API token                                                           |
| `environment-id` | Yes      | —       | Railway environment ID                                                      |
| `image`          | Yes      | —       | Full Docker image URI with tag                                              |
| `services`       | Yes      | —       | Multiline `label:service_id` pairs. Labels are for logging only.            |
| `first-service`  | No       | `""`    | Label of service to deploy first. Others deploy after wait.                 |
| `wait-seconds`   | No       | `30`    | Seconds to wait after first-service before deploying remaining services.    |

## Outputs

| Output              | Description                                |
| ------------------- | ------------------------------------------ |
| `deployed-services` | Comma-separated list of deployed services  |
| `image-tag`         | The image tag that was deployed            |

## How It Works

1. Parses the `services` input into label:id pairs
2. Updates the Docker image source on **all** services via Railway GraphQL API
3. If `first-service` is set:
   - Redeploys that service first
   - Waits `wait-seconds`
   - Redeploys remaining services
4. If `first-service` is not set:
   - Redeploys all services together

## Prerequisites

- Railway account with API access
- `jq` and `curl` available on runner (pre-installed on `ubuntu-latest`)
- Docker image already pushed to a registry accessible by Railway

## License

MIT
```

**Step 2: Verify the file was created**

Run: `head -20 README.md`
Expected: First 20 lines of README displayed

**Step 3: Commit with jj**

```bash
jj commit -m "docs: add README with usage examples"
```

---

## Task 4: Create LICENSE file

**Files:**
- Create: `LICENSE`

**Step 1: Create the MIT license file**

```text
MIT License

Copyright (c) 2026 HarleyTherapy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

**Step 2: Commit with jj**

```bash
jj commit -m "chore: add MIT license"
```

---

## Task 5: Create self-test workflow

**Files:**
- Create: `.github/workflows/test.yml`

**Step 1: Create the test workflow file**

```yaml
name: Test Action

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  shellcheck:
    name: Shellcheck
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Run shellcheck
        run: shellcheck scripts/deploy.sh

  yaml-lint:
    name: YAML Lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Lint action.yml
        run: |
          python3 -c "import yaml; yaml.safe_load(open('action.yml'))"
          echo "action.yml is valid YAML"

  dry-run:
    name: Dry Run (syntax check)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check bash syntax
        run: bash -n scripts/deploy.sh

      - name: Verify script is executable
        run: test -x scripts/deploy.sh
```

**Step 2: Verify the workflow file was created**

Run: `cat .github/workflows/test.yml`
Expected: The YAML content above is displayed

**Step 3: Commit with jj**

```bash
jj commit -m "ci: add self-test workflow with shellcheck and yaml lint"
```

---

## Task 6: Final verification and tag

**Files:**
- None (verification only)

**Step 1: Verify repo structure matches spec**

Run: `find . -type f -not -path './.git/*' -not -path './.jj/*' | sort`
Expected:
```
./.github/workflows/test.yml
./LICENSE
./README.md
./action.yml
./docs/plans/2026-02-20-railway-deploy-action.md
./scripts/deploy.sh
./specs.md
```

**Step 2: Run all local validations**

Run: `bash -n scripts/deploy.sh && echo "Syntax OK"`
Expected: `Syntax OK`

**Step 3: View jj log to confirm all commits**

Run: `jj log --limit 10`
Expected: 5 commits showing:
- ci: add self-test workflow
- chore: add MIT license
- docs: add README with usage examples
- feat: add deploy.sh script
- feat: add action.yml metadata file

**Step 4: Create initial version tag with jj**

Run: `jj git push --change @ && git tag -a v1.0.0 -m "Initial release"`
Expected: Changes pushed and tag created

**Step 5: Create floating major version tag**

Run: `git tag -a v1 -m "Point to latest v1.x.x"`
Expected: No output (success)

**Step 6: Push tags to remote**

Run: `git push origin --tags`
Expected: Tags pushed to remote

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Action metadata | `action.yml` |
| 2 | Deploy script | `scripts/deploy.sh` |
| 3 | Documentation | `README.md` |
| 4 | License | `LICENSE` |
| 5 | CI workflow | `.github/workflows/test.yml` |
| 6 | Verification & tagging | — |

Total: 5 files to create, 5 commits, 2 tags
