# Railway Image Update Action

A GitHub Action that points one or more Railway services at a Docker image and redeploys them, using the Railway GraphQL API.

## Features

- Works with any framework and any number of services; every service gets the same image
- Ordered deployments: deploy one service first, wait for Railway to report `SUCCESS`, then deploy the rest
- Account, workspace and project-scoped Railway tokens
- Private registries (AWS ECR, Azure ACR, GHCR, Docker Hub, self-hosted)
- **Resolves image tags to content-addressed digests by default**, so the image Railway pulls is exactly the one you built
- A `dry-run` mode that shows the API calls without sending them
- Runs on `node24`; the bundle is committed, so nothing is installed at runtime

## Quick start

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - name: Deploy to Railway
        id: deploy
        uses: mediazard/railway-image-update-action@<full-commit-sha> # vX.Y.Z
        with:
          api-token: ${{ secrets.RAILWAY_TOKEN }}
          token-type: project
          environment-id: ${{ vars.RAILWAY_ENV_ID }}
          image: ghcr.io/myorg/myapp:sha-${{ github.sha }}
          services: |
            api:${{ vars.RAILWAY_API_SERVICE_ID }}

      - run: echo "Deployed ${{ steps.deploy.outputs.image-tag }}"
```

Replace `<full-commit-sha>` with the 40-character commit SHA of the release you want, and keep the version in the comment so Dependabot can update it (see [Pinning the action version](#pinning-the-action-version)).

The action makes no GitHub API calls and needs no `GITHUB_TOKEN` scopes, so `permissions: {}` is enough. Use `contents: read` if the same job checks out the repository.

The `image-tag` output holds the resolved digest ref (for example `ghcr.io/myorg/myapp@sha256:...`), a record of exactly what was deployed.

## Railway tokens

| Token     | Scope                                       | Header the action sends | `token-type`       |
| --------- | ------------------------------------------- | ----------------------- | ------------------ |
| Account   | Every resource your Railway account can see | `Authorization: Bearer` | `bearer` (default) |
| Workspace | One workspace                               | `Authorization: Bearer` | `bearer` (default) |
| Project   | One environment of one project              | `Project-Access-Token`  | `project`          |

- **Recommended: a project token for the target environment.** It is the least privilege that works. Create a project token in the Railway dashboard for the environment you deploy to.
- A project token only works for its own environment. Its environment must be the one in `environment-id`; otherwise Railway answers with "forbidden" or "not found" errors.
- Setting the wrong `token-type` for a token (for example a project token with the default `bearer`) fails with `Railway API authentication failed`.
- Store the token in `secrets`, never in `vars` or in the workflow file.

## Finding environment and service IDs

In the Railway dashboard, open the project and press `Cmd + K` (macOS) or `Ctrl + K` (Windows/Linux). The command palette has "Copy Environment ID" and "Copy Service ID" entries. Both are UUIDs.

The IDs are not secrets, so store them as repository or environment variables (`vars`), as in the examples.

## Usage

### Ordered deployment (multiple services)

```yaml
- name: Deploy to Railway
  uses: mediazard/railway-image-update-action@<full-commit-sha> # vX.Y.Z
  with:
    api-token: ${{ secrets.RAILWAY_TOKEN }}
    token-type: project
    environment-id: ${{ vars.RAILWAY_PROD_ENV_ID }}
    image: ghcr.io/myorg/myapp:sha-${{ github.sha }}
    services: |
      web:${{ vars.RAILWAY_WEB_SERVICE_ID }}
      worker:${{ vars.RAILWAY_WORKER_SERVICE_ID }}
      clock:${{ vars.RAILWAY_CLOCK_SERVICE_ID }}
    first-service: web
```

`web` is updated and redeployed first. Only once Railway reports its deployment as `SUCCESS` are `worker` and `clock` updated and redeployed. Put the service that runs your migrations (for example as a pre-deploy command) first: if it fails, nothing else is touched.

### Private registry

```yaml
- name: Deploy from a private registry
  uses: mediazard/railway-image-update-action@<full-commit-sha> # vX.Y.Z
  with:
    api-token: ${{ secrets.RAILWAY_TOKEN }}
    token-type: project
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: registry.example.com/myorg/myapp:sha-${{ github.sha }}
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
    registry-username: ${{ secrets.REGISTRY_USERNAME }}
    registry-password: ${{ secrets.REGISTRY_PASSWORD }}
```

Set both `registry-username` and `registry-password`, or neither. See [Private registries](#private-registries) for where the credentials go.

### Account or workspace token

```yaml
- uses: mediazard/railway-image-update-action@<full-commit-sha> # vX.Y.Z
  with:
    api-token: ${{ secrets.RAILWAY_API_TOKEN }}
    environment-id: ${{ vars.RAILWAY_ENV_ID }}
    image: ghcr.io/myorg/myapp:sha-${{ github.sha }}
    services: |
      api:${{ vars.RAILWAY_API_SERVICE_ID }}
```

`token-type` defaults to `bearer`, which is right for account and workspace tokens.

## Inputs

| Input               | Required | Default  | Description                                                                                                                                                                                   |
| ------------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-token`         | Yes      | —        | Railway API token (account, workspace, or project). See [Railway tokens](#railway-tokens)                                                                                                     |
| `token-type`        | No       | `bearer` | `bearer` for account/workspace tokens, `project` for project tokens                                                                                                                           |
| `environment-id`    | Yes      | —        | Railway environment ID (UUID)                                                                                                                                                                 |
| `image`             | Yes      | —        | Full Docker image URI with tag or digest. Registry credentials are sent to this image's registry, so never build it from untrusted input                                                      |
| `services`          | Yes      | —        | Multiline `label:service_id` pairs. Labels are for logging and outputs only. See [Service labels](#service-labels)                                                                            |
| `first-service`     | No       | `""`     | Label of the service to deploy first. The others deploy only after it reaches `SUCCESS`                                                                                                       |
| `registry-username` | No       | `""`     | Username for a private registry (requires `registry-password`)                                                                                                                                |
| `registry-password` | No       | `""`     | Password or token for a private registry (requires `registry-username`)                                                                                                                       |
| `resolve-to-digest` | No       | `true`   | Resolve the image tag to a content-addressed digest before deploying                                                                                                                          |
| `allow-mutable-tag` | No       | `false`  | When `resolve-to-digest: false`, allow deploying a tag that looks mutable                                                                                                                     |
| `dry-run`           | No       | `false`  | Log the Railway API calls without sending them. Nothing changes on Railway; `deployed-services` and `failed-services` are written empty, and `image-tag` and `deployment-ids` are not written |

## Outputs

| Output              | Description                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `deployed-services` | Comma-separated labels whose redeploy Railway accepted (see [What the outputs mean](#what-the-outputs-mean)). Always written |
| `failed-services`   | Comma-separated labels that were not deployed, including any never attempted after an earlier failure. Empty on full success |
| `image-tag`         | The image reference sent to Railway. With `resolve-to-digest: true` (the default) this is a digest-pinned ref                |
| `deployment-ids`    | Newline-separated `label=deployment-id` pairs                                                                                |

## What the outputs mean

"Deployed" means different things for the first service and the rest:

| Service                                                       | Listed in `deployed-services` when                                                                  |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `first-service` (ordered mode)                                | Railway reported its deployment as `SUCCESS`                                                        |
| Every other service, and all services without `first-service` | Railway **accepted the redeploy request**. The deployment may still be building, and may later fail |

So `deployed-services` does not prove that the non-first services are healthy. Check them in the Railway dashboard, or use their ids from `deployment-ids`.

- **Partial failure:** services are processed one at a time, in input order. When a step fails, `deployed-services` lists the services that got that far and `failed-services` lists the rest, including services that were never attempted. Untouched services keep their old image.
- **Input errors:** if the inputs fail validation, nothing is attempted and both `deployed-services` and `failed-services` are written empty. An empty `failed-services` alone does not mean success; check the step's outcome.
- **`deployment-ids`:** the first service has an entry as soon as it was redeployed, because the gate needs its id (so the entry can be present even when the gate then failed). Another service can be missing when Railway returns no id for it; the log then shows a `deployment-id: (unavailable` warning.
- **Dry run:** `deployed-services` and `failed-services` are written empty; `image-tag` and `deployment-ids` are not written.

## Service labels

Each `services` line is `label:service_id`. The line is split at the first `:`, so a label can never contain `:`. Blank lines are ignored. A label:

- must not be empty;
- must not contain control characters, the line separators U+2028 and U+2029, commas, `[` or `]`.

Spaces, `/`, other punctuation and non-ASCII letters are fine. `first-service` follows the same rules, and also must not contain `:` or `%`. `registry-username` must not contain line breaks, `%`, `[` or `]`, and `api-token` must not contain line breaks or `%`.

## Private registries

The registry host is taken from `image`, following Docker's own rule:

| `image`                               | Registry host                              |
| ------------------------------------- | ------------------------------------------ |
| `myorg/app:1.2.3`, `nginx:1.27`       | Docker Hub (`https://index.docker.io/v1/`) |
| `docker.io/myorg/app:1.2.3`           | Docker Hub (`https://index.docker.io/v1/`) |
| `ghcr.io/myorg/app:1.2.3`             | `ghcr.io`                                  |
| `registry.example.com/team/app:1.2.3` | `registry.example.com`                     |

The first path segment is a host only when it contains a `.` or is `localhost`; otherwise the image is on Docker Hub.

When `registry-username` and `registry-password` are set, they are sent to **two** places:

1. **The image's registry**, via `docker login` on the runner, so the digest can be resolved (only with `resolve-to-digest: true`).
2. **Railway**, with the image update, so Railway can pull the image.

> [!WARNING]
> **`image` must be trusted.** The registry credentials go to whatever host `image` names. Never build `image`, `registry-username` or `registry-password` from untrusted input, such as a pull request title, branch name or issue text.

Other details:

- The post step runs `docker logout` for that host, even after a failed login. On a persistent self-hosted runner this also removes any login to the same host that existed before the job.
- `docker login` is given about 1 minute and the digest lookup about 2 minutes before they are stopped, so an unresponsive registry fails the step instead of hanging the job.
- `resolve-to-digest: true` needs `docker buildx` on the runner (see [Runner requirements](#runner-requirements)).

## Digest pinning and mutable tags

By default, the action resolves your image tag to a content-addressed digest (`sha256:...`) before calling Railway's API. This prevents a subtle race:

> You push `myapp:latest` and trigger a deploy. Meanwhile a different build also pushes `myapp:latest`. Railway resolves the tag when it pulls, so it may pull the _other_ build's image into _your_ deployment.

With digest pinning, Railway gets `ghcr.io/myorg/myapp@sha256:<exact-digest>`, which cannot change. The image that reaches your container is exactly the one you tested.

If you manage immutability yourself (for example with `sha-${{ github.sha }}` tags), set `resolve-to-digest: false`. The action then refuses a ref that looks mutable unless you also set `allow-mutable-tag: true`.

The mutable-tag check is a **heuristic**: it only recognises `latest`, `main`, `master`, `develop`, `stable` and a missing tag. Other moving tags such as `prod`, `edge` or `v1` are not detected. Digest resolution is the real protection.

## Dry run

Set `dry-run: true` to see what the action would do:

- Inputs are validated, and the mutable-tag check runs as usual.
- Each Railway API request is logged instead of sent. Credentials in the logged request are redacted.
- Digest resolution is skipped (no `docker` call); a stub digest is used in the logged requests.
- Nothing changes on Railway. `deployed-services` and `failed-services` are written empty; `image-tag` and `deployment-ids` are not written.

The old `DRY_RUN` environment variable is no longer read. If a truthy `DRY_RUN` is set and the `dry-run` input is not, the step fails with `DRY_RUN environment variable is no longer supported` rather than deploying for real.

## How it works

### Without `first-service` (2 steps)

1. **Step 1/2:** update the image source on all services.
2. **Step 2/2:** redeploy all services.

### With `first-service` (3 steps)

1. **Step 1/3:** update and redeploy `first-service`.
2. Wait for `first-service` to reach `SUCCESS` (Railway's own verdict). A `FAILED` or `CRASHED` deployment, including a failed pre-deploy migration, stops the run here, and the remaining services are not deployed. The wait gives up after about 6 minutes without any status change, or 10 minutes in total. Both limits are above Railway's default 300-second healthcheck window, so normally Railway decides.
3. **Step 2/3:** update the image source on the remaining services.
4. **Step 3/3:** redeploy the remaining services.

Services are always processed one at a time, in input order. A redeploy request is sent at most once: if it fails in a way that may have reached Railway, the action stops and asks you to check the dashboard instead of resending it.

## Runner requirements

- **Node 24**, provided by the runner (`using: node24`). GitHub-hosted runners are fine. Self-hosted runners need **actions/runner v2.328.0 or newer**; macOS 13.4 or earlier and ARM32 can't run node24 actions.
- **`docker buildx`**, required when `resolve-to-digest: true` (the default). It is pre-installed on `ubuntu-latest`. On a runner without docker, either install docker and buildx, or set `resolve-to-digest: false` and use an immutable tag or `@sha256:` ref (or set `allow-mutable-tag: true`).
- **Linux runners** are the supported configuration. `windows-latest` and `macos-latest` may work without docker but are not tested.

## Pinning the action version

| Pin style                     | Example                       | Trade-off                                                                                                    |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Full commit SHA (recommended) | `@<full-commit-sha> # vX.Y.Z` | Cannot be changed under you                                                                                  |
| Specific version tag          | `@vX.Y.Z`                     | A tag, so it can be moved. It becomes immutable only once immutable releases are enabled for this repository |
| Rolling major tag             | `@v1`                         | Moves to every stable v1 release                                                                             |

To keep SHA pins current, enable Dependabot for GitHub Actions:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

See [SECURITY.md](SECURITY.md) for the full policy.

## Troubleshooting

| Error                                                                                                       | Likely cause                                                                                                                                                       | Fix                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api-token is required`                                                                                     | The `api-token` input is empty. Often the secret is missing, misnamed, or not available to the workflow (secrets are not passed to workflows triggered from forks) | Set `api-token: ${{ secrets.YOUR_SECRET }}` and check the secret exists for this repository or environment                                                 |
| `services is required`                                                                                      | The `services` input is empty                                                                                                                                      | Add at least one `label:service_id` line                                                                                                                   |
| `environment-id must be a UUID`                                                                             | `environment-id` is empty or not a UUID                                                                                                                            | Copy the environment ID from the Railway dashboard (see [Finding environment and service IDs](#finding-environment-and-service-ids))                       |
| `services: service ID for '…' is not a valid UUID`                                                          | A `services` line has a bad or missing service ID                                                                                                                  | Use `label:service_id`, with the service ID copied from Railway                                                                                            |
| `services: label contains forbidden characters`                                                             | A label breaks the [label rules](#service-labels)                                                                                                                  | Rename the label                                                                                                                                           |
| `first-service contains forbidden characters`                                                               | `first-service` breaks the [label rules](#service-labels), or contains `:` or `%`                                                                                  | Use the bare label, exactly as written in `services`                                                                                                       |
| `first-service '…' not found in services list`                                                              | `first-service` does not match any label in `services`                                                                                                             | Fix the spelling (labels are case-sensitive), or remove `first-service`                                                                                    |
| `image is not a valid Docker image reference`                                                               | `image` has uppercase letters in the name, a registry port (`host:5000/...`), a leading `-`, or other unsupported characters                                       | Use a lowercase `registry/name:tag` or `registry/name@sha256:<digest>` reference                                                                           |
| `registry-username provided without registry-password` (or the reverse)                                     | Only one registry credential is set                                                                                                                                | Set both, or neither                                                                                                                                       |
| `Railway API authentication failed`                                                                         | The token is invalid or expired, or `token-type` does not match the token                                                                                          | Create a new token, and use `token-type: project` for project tokens                                                                                       |
| `Railway API rejected the request (forbidden)`                                                              | The token has no access to this project or environment. With a project token: the token is for a different environment                                             | Use a token for the environment in `environment-id`                                                                                                        |
| `Railway API resource not found` or `Railway GraphQL error during: …`                                       | A wrong environment or service ID, or a token that cannot see them                                                                                                 | Check the IDs and the token's scope; the error details show Railway's message                                                                              |
| `Railway API rate limit reached` / `Railway API is currently unavailable`                                   | Railway kept returning 429 or 5xx after automatic retries                                                                                                          | Wait, check Railway's status page, then re-run                                                                                                             |
| A failed redeploy whose hint says "The redeploy request may have reached Railway before the request failed" | The redeploy request failed in a way that might have happened after Railway accepted it, so it was not resent                                                      | Check the service's deployments in the Railway dashboard before re-running, to avoid a duplicate deployment                                                |
| `Deployment … ended in FAILED` (or `CRASHED`, etc.)                                                         | `first-service` failed to build, start or pass its healthcheck. The remaining services were not deployed                                                           | Read the build logs in the error details and in the Railway dashboard, fix, and re-run                                                                     |
| `Deployment … stalled in …` / `Deployment … did not reach SUCCESS within …`                                 | `first-service` made no progress for about 6 minutes, or took over 10 minutes                                                                                      | Check the deployment in the Railway dashboard. If its healthcheck legitimately takes over ~5 minutes, don't gate on that service, and please open an issue |
| `Cannot confirm […] deploy — Railway returned no deployment id`                                             | Railway accepted the redeploy but did not say which deployment it started, so the gate cannot judge it                                                             | Check the Railway dashboard, then re-run                                                                                                                   |
| `Refusing to deploy mutable tag`                                                                            | `resolve-to-digest: false` with a tag that looks mutable, and `allow-mutable-tag: false`                                                                           | Use an immutable tag (e.g. `sha-${{ github.sha }}`), turn `resolve-to-digest` back on, or set `allow-mutable-tag: true`                                    |
| `Registry login failed during digest resolution`                                                            | Wrong registry credentials, or credentials for a different registry than the one `image` names                                                                     | Check `registry-username`/`registry-password` and the [registry host](#private-registries)                                                                 |
| `Registry login timed out after 60s`                                                                        | The registry did not answer `docker login`                                                                                                                         | Check the image host and the runner's network access to it                                                                                                 |
| `Failed to resolve manifest digest for image`                                                               | The image or tag does not exist, the registry is unreachable, credentials are missing, or `docker buildx` is not installed                                         | Check that the image exists and is accessible; the error details include docker's output                                                                   |
| `Resolving the image digest timed out after 120s`                                                           | The registry did not answer the manifest lookup                                                                                                                    | Check the image host and the runner's network access to it                                                                                                 |
| `DRY_RUN environment variable is no longer supported`                                                       | A truthy `DRY_RUN` env var is set but the `dry-run` input is not                                                                                                   | Set `dry-run: true` for a dry run, or unset `DRY_RUN` for this step to deploy                                                                              |

Re-running with [debug logging](https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/troubleshooting-workflows/enabling-debug-logging) enabled shows more detail.

## Security

See [SECURITY.md](SECURITY.md) for what the action does with your secrets and how to report a vulnerability.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The action is TypeScript under `src/`, bundled with `@vercel/ncc` into the committed `dist/index.js`; runtime dependencies are listed in `package.json`.

## License

[MIT](LICENSE)
