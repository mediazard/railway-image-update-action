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
