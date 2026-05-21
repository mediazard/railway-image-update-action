# Railway Image Update Action

A reusable GitHub Action that updates Docker image source on Railway services and triggers redeployment via the Railway GraphQL API.

## Features

- Framework-agnostic, service-count-agnostic
- Supports ordered deployments (deploy one service first, wait, then deploy the rest)
- Supports account, workspace, and project-scoped API tokens
- Private registry authentication (AWS ECR, Azure ACR, GHCR, Docker Hub, self-hosted)
- **Resolves image tags to content-addressed digests by default** — prevents mutable-tag races
- TypeScript implementation, bundled to a single committed `dist/index.js` (no runtime install)
- Runs on `node20` (~200 ms cold start)

## Why digest pinning?

By default, the action resolves your image tag to a content-addressed digest (`sha256:...`) before calling Railway's API. This prevents a subtle race:

> You push `myapp:latest` and trigger a deploy. Concurrently, a different build also pushes to `myapp:latest`. Railway resolves the tag at pull time — potentially pulling the *other* build's image into *your* deployment.

With digest pinning, Railway gets `ghcr.io/myorg/myapp@sha256:<exact-digest>`, which is immutable. The image that reaches your container is exactly what you tested.

If you prefer to manage immutability yourself (e.g. you already use `sha-${{ github.sha }}` tags), set `resolve-to-digest: false`. Without explicit opt-in via `allow-mutable-tag: true`, the action will still fail fast if the ref looks mutable (`:latest`, `:main`, `:master`, `:develop`, `:stable`, or no tag).

## Usage

### Basic (single service)

```yaml
- name: Deploy to Railway
  id: deploy
  uses: mediazard/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: ghcr.io/myorg/myapp:sha-${{ github.sha }}
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}

- run: echo "Deployed ${{ steps.deploy.outputs.image-tag }}"
```

The `image-tag` output contains the resolved digest ref (e.g. `ghcr.io/myorg/myapp@sha256:...`), so you have an auditable record of exactly what was deployed.

### Ordered deployment (multiple services)

```yaml
- name: Deploy to Railway
  uses: mediazard/railway-image-update-action@v1
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

For images from private registries, credentials authenticate both the digest resolution step and Railway's pull:

```yaml
- name: Deploy from private registry
  uses: mediazard/railway-image-update-action@v1
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: private.registry.com/myorg/myapp:sha-${{ github.sha }}
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
    registry-username: ${{ secrets.REGISTRY_USERNAME }}
    registry-password: ${{ secrets.REGISTRY_PASSWORD }}
```

Both `registry-username` and `registry-password` must be provided together. Store credentials as GitHub secrets.

### Project-scoped token

```yaml
- uses: mediazard/railway-image-update-action@v1
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
| `token-type` | No | `bearer` | `bearer` for account/workspace, `project` for project-scoped |
| `environment-id` | Yes | — | Railway environment ID (UUID) |
| `image` | Yes | — | Full Docker image URI with tag or digest |
| `services` | Yes | — | Multiline `label:service_id` pairs. Labels are for logging only. |
| `first-service` | No | `""` | Label of service to deploy first. Others deploy after wait. |
| `wait-seconds` | No | `30` | Seconds to wait after first-service before deploying remaining |
| `registry-username` | No | `""` | Username for private registry (requires registry-password) |
| `registry-password` | No | `""` | Password/token for private registry (requires registry-username) |
| `resolve-to-digest` | No | `true` | Resolve the image tag to a content-addressed digest before deploying |
| `allow-mutable-tag` | No | `false` | When `resolve-to-digest: false`, allow deploying mutable tags |

## Outputs

| Output | Description |
|--------|-------------|
| `deployed-services` | Comma-separated list of deployed service labels (always written, even on failure) |
| `failed-services` | Comma-separated list of labels that did NOT deploy (empty on full success) |
| `image-tag` | The resolved image reference. With `resolve-to-digest: true` (default) this is a digest-pinned ref |
| `deployment-ids` | Newline-separated `label=id` pairs |

## How it works

### Without `first-service` (2-step flow)

1. **Step 1/2** — Update image source on all services
2. **Step 2/2** — Redeploy all services

Services are processed sequentially in input order. Sequential iteration is an invariant — never replaced with `Promise.all`. This preserves deterministic partial-failure semantics.

### With `first-service` (3-step flow)

1. **Step 1/3** — Update + redeploy `first-service`
2. Wait `wait-seconds`
3. **Step 2/3** — Update image source on remaining services
4. **Step 3/3** — Redeploy remaining services

If any step fails, only services that completed their own update + redeploy appear in `deployed-services`. Services not yet touched remain on the old image — safe to retry.

## Architecture

Pure TypeScript, bundled to a single `dist/index.js` via `@vercel/ncc`. The runtime is `node20` (provided by the GitHub Actions runner).

Dependencies (runtime — bundled):
- `@actions/core`, `@actions/exec` — Actions runtime
- `graphql-request@^7` — GraphQL client with `AbortController` support
- `p-retry@^4` — exponential backoff + jitter retry (CJS-only; v5+ is ESM and breaks ncc)
- `zod@~3.23` — input validation + response shape checks

The `dist/index.js` is committed so consumers don't pull `node_modules` at runtime; the bundle is reproducible (Node patch pinned in `.node-version`, ncc bundle-freshness gate in CI).

## Pinning the action version

| Pin style | Example | Trade-off |
|-----------|---------|-----------|
| Full SHA (recommended) | `@<full-sha>` | Immutable, supply-chain safe |
| Rolling major tag | `@v1` | Auto-updates within major; tag is force-pushed on each release |
| Specific version | `@v1.0.0` | Lightweight immutable tag |

See [SECURITY.md](SECURITY.md) for the full policy.

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `RAILWAY_API_TOKEN is not set` | Missing `api-token` input | Add `api-token: ${{ secrets.RAILWAY_API_TOKEN }}` |
| `Railway API authentication failed` | Invalid or expired token | Regenerate token in Railway dashboard |
| `Railway API access forbidden` | Token lacks permissions | Use a token with access to the target project |
| `first-service '...' not found` | Label doesn't match any service | Check spelling matches a label in `services` |
| `Refusing to deploy mutable tag` | `resolve-to-digest: false` + mutable tag + `allow-mutable-tag: false` | Use immutable tag, enable `resolve-to-digest: true`, or set `allow-mutable-tag: true` |
| `Failed to resolve manifest digest` | Registry unreachable or image not found | Check registry credentials, image existence, network access |

## License

MIT
