# Reusable GitHub Action: Railway Deploy

## Overview

A composite GitHub Action that updates Docker image tags on Railway services and triggers redeployment via the Railway GraphQL API. Framework-agnostic, service-count-agnostic. Lives in its own repo, referenced by any number of consumer repos.

**Repo:** `<org>/railway-image-update-action`

---

## What It Does

1. Takes a list of Railway service IDs (all sharing the same Docker image)
2. Updates the Docker image source on every service
3. If `first-service` is set: redeploys that service, waits, then redeploys the rest
4. If `first-service` is not set: redeploys all services together

The action is fully agnostic — no assumptions about service names, counts, frameworks, or what services do. Labels are arbitrary and used only for logging.

---

## Usage (in app repos)

### Production deploy (3 services, ordered)

```yaml
- name: Deploy to Railway
  uses: <org>/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_PROD_ENV_ID }}
    image: ghcr.io/<org>/app-a:sha-${{ github.sha }}
    services: |
      web:${{ vars.RAILWAY_WEB_SERVICE_ID }}
      worker:${{ vars.RAILWAY_WORKER_SERVICE_ID }}
      clock:${{ vars.RAILWAY_CLOCK_SERVICE_ID }}
    first-service: web
```

### Single service (no ordering)

```yaml
- name: Deploy API
  uses: <org>/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_PROD_ENV_ID }}
    image: ghcr.io/<org>/api:latest
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
```

### Five services, two deployed first

```yaml
- name: Deploy all
  uses: <org>/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_PROD_ENV_ID }}
    image: ghcr.io/<org>/platform:sha-${{ github.sha }}
    services: |
      web:${{ vars.RAILWAY_WEB_SERVICE_ID }}
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
      worker:${{ vars.RAILWAY_WORKER_SERVICE_ID }}
      scheduler:${{ vars.RAILWAY_SCHEDULER_SERVICE_ID }}
      mailer:${{ vars.RAILWAY_MAILER_SERVICE_ID }}
    first-service: web
```

---

## Inputs

| Input            | Required | Description                                                                                                                                              |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-token`      | Yes      | Railway API token                                                                                                                                        |
| `environment-id` | Yes      | Railway environment ID                                                                                                                                   |
| `image`          | Yes      | Full Docker image URI with tag                                                                                                                           |
| `services`       | Yes      | Multiline `label:service_id` pairs (one per line). Labels are for logging only — the action doesn't interpret them. All services receive the same image. |
| `first-service`  | No       | Label of the service to redeploy before all others. Remaining services deploy after the wait. If omitted, all services deploy together.                  |
| `wait-seconds`   | No       | Seconds to wait after first-service redeploy before deploying the rest. Default: `30`                                                                    |

---

## Outputs

| Output              | Description                                                |
| ------------------- | ---------------------------------------------------------- |
| `deployed-services` | Comma-separated list of service names that were redeployed |
| `image-tag`         | The image tag that was deployed                            |

---

## Repo Structure

```
railway-image-update-action/
├── action.yml          # Action metadata + composite steps
├── scripts/
│   └── deploy.sh       # Main deploy logic
├── README.md           # Usage docs
├── LICENSE
└── .github/
    └── workflows/
        └── test.yml    # Self-test workflow
```

---

## action.yml

```yaml
name: "Railway Deploy"
description: "Update Docker image and redeploy services on Railway via GraphQL API"
author: "<org>"

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

---

## scripts/deploy.sh

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

---

## Consumer Example: Production Deploy Workflow

```yaml
name: Deploy Production
on:
  workflow_dispatch:

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image-tag: ${{ steps.meta.outputs.image-tag }}

    steps:
      - uses: actions/checkout@v4

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        id: meta
        run: |
          TAG="${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:sha-${{ github.sha }}"
          docker build -t "$TAG" .
          docker push "$TAG"
          echo "image-tag=$TAG" >> "$GITHUB_OUTPUT"

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Deploy to Railway
        uses: <org>/railway-image-update-action@v1
        with:
          api-token: ${{ secrets.RAILWAY_API_TOKEN }}
          environment-id: ${{ vars.RAILWAY_PROD_ENV_ID }}
          image: ${{ needs.build.outputs.image-tag }}
          services: |
            web:${{ vars.RAILWAY_WEB_SERVICE_ID }}
            worker:${{ vars.RAILWAY_WORKER_SERVICE_ID }}
            clock:${{ vars.RAILWAY_CLOCK_SERVICE_ID }}
          first-service: web
```

---

## Consumer Example: Multi-Slot Deploy Workflow

```yaml
name: Deploy Staging Slot
on:
  workflow_dispatch:
    inputs:
      branch:
        description: "Branch to deploy"
        required: true
      slot:
        description: "Staging slot"
        required: true
        type: choice
        options:
          - stg1
          - stg2

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    outputs:
      image-tag: ${{ steps.meta.outputs.image-tag }}

    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.inputs.branch }}

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push
        id: meta
        run: |
          SAFE_BRANCH=$(echo "${{ github.event.inputs.branch }}" | sed 's/[^a-zA-Z0-9._-]/-/g')
          SHORT_SHA=$(git rev-parse --short HEAD)
          TAG="${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${SAFE_BRANCH}-${SHORT_SHA}"
          docker build -t "$TAG" .
          docker push "$TAG"
          echo "image-tag=$TAG" >> "$GITHUB_OUTPUT"

  deploy:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Resolve environment
        id: env
        run: |
          if [[ "${{ github.event.inputs.slot }}" == "stg1" ]]; then
            echo "env-id=${{ vars.RAILWAY_STG1_ENV_ID }}" >> "$GITHUB_OUTPUT"
          else
            echo "env-id=${{ vars.RAILWAY_STG2_ENV_ID }}" >> "$GITHUB_OUTPUT"
          fi

      - name: Deploy to Railway
        uses: <org>/railway-image-update-action@v1
        with:
          api-token: ${{ secrets.RAILWAY_API_TOKEN }}
          environment-id: ${{ steps.env.outputs.env-id }}
          image: ${{ needs.build.outputs.image-tag }}
          services: |
            web:${{ vars.RAILWAY_WEB_SERVICE_ID }}
            worker:${{ vars.RAILWAY_WORKER_SERVICE_ID }}
            clock:${{ vars.RAILWAY_CLOCK_SERVICE_ID }}
          first-service: web
          wait-seconds: "60"
```

---

## Versioning

Use git tags for versioned releases:

```bash
git tag -a v1.0.0 -m "Initial release"
git push origin v1.0.0

# Point v1 major tag to latest v1.x.x
git tag -fa v1 -m "Update v1 tag"
git push origin v1 --force
```

Consumers reference `@v1` (floats to latest v1.x.x) or pin to `@v1.0.0`.

---

## Prerequisites

- Railway account with API access (Pro plan required for private registry auth)
- `jq` available on runner (pre-installed on `ubuntu-latest`)
- `curl` available on runner (pre-installed)
- Docker image already pushed to a registry accessible by Railway
- No additional dependencies — pure bash composite action

---

## Future Improvements

- Poll deployment status instead of fixed `sleep` for first-service wait
- Slack notification on success/failure as optional input
- Support rollback (re-set previous image tag)
- Dry-run mode (update image but don't redeploy)
