# Railway Deploy Action

A reusable composite GitHub Action that updates Docker image tags on Railway services and triggers redeployment via the Railway GraphQL API.

## Features

- Framework-agnostic, service-count-agnostic
- Supports ordered deployments (deploy one service first, wait, then deploy the rest)
- Supports account, workspace, and project-scoped API tokens
- Private registry authentication (AWS ECR, Azure ACR, GHCR, Docker Hub, self-hosted)
- **Resolves image tags to content-addressed digests by default** — prevents mutable-tag races
- Pure bash — no Node.js or additional dependencies beyond `docker`, `jq`, and `curl`
- Works with any Docker registry accessible by Railway

## Why digest pinning?

By default, this action resolves your image tag to a content-addressed digest (`sha256:...`) before calling Railway's API. This prevents a subtle race:

> You push `myapp:latest` and trigger a deploy. Concurrently, a different build also pushes to `myapp:latest`. Railway resolves the tag at pull time — potentially pulling the *other* build's image into *your* deployment.

With digest pinning, Railway gets `ghcr.io/myorg/myapp@sha256:<exact-digest>`, which is immutable. The image that reaches your container is exactly what you tested.

**If you prefer to manage immutability yourself** (e.g. you already use `sha-${{ github.sha }}` tags), you can set `resolve-to-digest: false`. Without explicit opt-in via `allow-mutable-tag: true`, the action will still fail fast if the ref looks mutable (`:latest`, `:main`, `:master`, `:develop`, `:stable`, or no tag at all).

## Usage

### Basic (single service)

```yaml
- name: Deploy to Railway
  id: deploy
  uses: mediazard/railway-image-update-action@v0
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: ghcr.io/myorg/myapp:sha-${{ github.sha }}
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}

- name: Print deployed digest
  run: echo "Deployed ${{ steps.deploy.outputs.image-tag }}"
```

The `image-tag` output contains the resolved digest ref (e.g. `ghcr.io/myorg/myapp@sha256:...`), so you have an auditable record of exactly what was deployed.

### Ordered deployment (multiple services)

```yaml
- name: Deploy to Railway
  id: deploy
  uses: mediazard/railway-image-update-action@v0
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

### Private registry authentication

For images from private registries (AWS ECR, Azure ACR, private Docker Hub, self-hosted), credentials are used both to authenticate the digest resolution step and to allow Railway to pull the image:

```yaml
- name: Deploy from private registry
  id: deploy
  uses: mediazard/railway-image-update-action@v0
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: private.registry.com/myorg/myapp:sha-${{ github.sha }}
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
    registry-username: ${{ secrets.REGISTRY_USERNAME }}
    registry-password: ${{ secrets.REGISTRY_PASSWORD }}
```

> **Note**: Both `registry-username` and `registry-password` must be provided together. Store credentials as GitHub secrets, never as plain text.

### Project-scoped token

If using a Railway project token instead of an account/workspace token:

```yaml
- name: Deploy to Railway
  uses: mediazard/railway-image-update-action@v0
  with:
    api-token: ${{ secrets.RAILWAY_PROJECT_TOKEN }}
    token-type: project
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: ghcr.io/myorg/myapp:latest
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-token` | Yes | — | Railway API token (account, workspace, or project) |
| `token-type` | No | `bearer` | Token type: `bearer` for account/workspace, `project` for project-scoped |
| `environment-id` | Yes | — | Railway environment ID |
| `image` | Yes | — | Full Docker image URI with tag or digest |
| `services` | Yes | — | Multiline `label:service_id` pairs. Labels are for logging only. |
| `first-service` | No | `""` | Label of service to deploy first. Others deploy after wait. |
| `wait-seconds` | No | `30` | Seconds to wait after first-service before deploying remaining services. |
| `registry-username` | No | `""` | Username for private registry authentication (requires registry-password) |
| `registry-password` | No | `""` | Password/token for private registry authentication (requires registry-username) |
| `resolve-to-digest` | No | `true` | Resolve the image tag to a content-addressed digest before deploying. Prevents mutable-tag races. Set to `false` only if you pin images yourself. |
| `allow-mutable-tag` | No | `false` | When `resolve-to-digest` is `false`, allow deploying a mutable tag (`:latest`, `:main`, `:master`, `:develop`, `:stable`, or no tag). Defaults to `false` to fail fast on unsafe refs. |

## Outputs

| Output | Description |
|--------|-------------|
| `deployed-services` | Comma-separated list of service labels that were successfully deployed. Always written — even on partial or full failure — so callers can identify what moved. |
| `failed-services` | Comma-separated list of service labels that were **not** deployed. Empty string on full success. Use this to detect partial failures without parsing error messages. |
| `image-tag` | The resolved image reference that was deployed. When `resolve-to-digest` is `true` (default), this is a digest-pinned ref (e.g. `ghcr.io/org/app@sha256:...`). Capture it via `steps.<id>.outputs.image-tag` for an auditable deploy record. |
| `deployment-ids` | Newline-separated `label=id` pairs for each deployed service (e.g. `web=abc123`). Use to deep-link into the Railway dashboard or check deployment status programmatically. |

### Partial failure handling

All outputs (`deployed-services`, `failed-services`, `image-tag`, `deployment-ids`) are written to `$GITHUB_OUTPUT` via a single `EXIT` trap, so they are always populated regardless of whether the action succeeds or fails mid-way. If the action exits with a non-zero code you can inspect these outputs to determine exactly which services moved and which did not. Recovery is straightforward: fix the root cause and re-run the action — services that already deployed will simply be redeployed with the same image, which is idempotent.

## How It Works

### Without `first-service`

2-step flow. Services are processed in input order.

1. **Step 1/2** — Update image source on all services via Railway GraphQL API
2. **Step 2/2** — Redeploy all services

### With `first-service`

3-step flow. Services are processed in input order. The first-service update and redeploy happen atomically before any other service is touched, eliminating silent half-deploys if the first redeploy fails.

1. **Step 1/3** — Update image source on `first-service`, then redeploy it immediately
2. Wait `wait-seconds` for the first service to stabilise
3. **Step 2/3** — Update image source on remaining services (in input order)
4. **Step 3/3** — Redeploy remaining services (in input order)

If any step fails, only services that have already completed their own update+redeploy will appear in `deployed-services`. Services that have not been touched yet are still running the old image and old deployment — safe to retry.

## Prerequisites

- Railway account with API access
- `jq`, `curl`, and `docker` (with `buildx`) available on runner (pre-installed on `ubuntu-latest`)
- Docker image already pushed to a registry accessible by Railway

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `RAILWAY_API_TOKEN is not set` | Missing `api-token` input | Add `api-token: ${{ secrets.RAILWAY_API_TOKEN }}` |
| `Railway API authentication failed` | Invalid or expired token | Regenerate token in Railway dashboard |
| `Railway API access forbidden` | Token lacks permissions | Use a token with access to the target project |
| `first-service '...' not found` | Label doesn't match any service | Check spelling matches a label in `services` |
| `registry-username provided without registry-password` | Only one credential provided | Provide both or neither |
| `Refusing to deploy mutable tag` | `resolve-to-digest: false` + mutable tag + `allow-mutable-tag: false` | Use an immutable tag, enable `resolve-to-digest: true` (default), or set `allow-mutable-tag: true` |
| `Failed to resolve manifest digest` | Registry unreachable or image not found | Check registry credentials, image existence, and network access |

## Backwards Compatibility

`resolve-to-digest` defaults to `true`. For most consumers this is a transparent improvement — Railway receives a digest instead of a tag, and behaviour is otherwise identical. One edge case: if you relied on Railway re-resolving a mutable tag between runs to pick up an image pushed by a separate workflow (i.e. you intentionally push `:latest` from two places), you will need to set `resolve-to-digest: false` AND `allow-mutable-tag: true`. This pattern is strongly discouraged — prefer using `sha-${{ github.sha }}` tags so each workflow pins its own image.

## Pinning the action version

| Pin style | Example | Trade-off |
|-----------|---------|-----------|
| Full SHA (recommended) | `@11bd71901bbe5b1630ceea73d27597364c9af683` | Immutable — supply-chain safe |
| Rolling major tag | `@v0` | Auto-updates within major; tag is force-pushed on each release |
| Specific version | `@v0.2.1` | Lightweight immutable tag — good middle ground |

For production workflows, SHA-pinning is strongly recommended. See [SECURITY.md](SECURITY.md) for the full policy.

## Security

- **API tokens and registry credentials** should always be stored as [GitHub encrypted secrets](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- Never hardcode sensitive values in workflow files
- All JSON payloads are constructed with `jq` to prevent injection
- Registry credentials are passed securely to Railway and are not logged

## License

MIT
