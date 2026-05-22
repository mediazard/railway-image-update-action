# Security Policy

## Supported versions

| Version          | Status                                       |
|------------------|----------------------------------------------|
| `v1.x` (current) | Active development; security and bug fixes   |
| older            | Unsupported                                  |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub private vulnerability reporting](https://github.com/mediazard/railway-image-update-action/security/advisories/new) to report a vulnerability. Maintainers will be notified privately and can coordinate a fix and disclosure with you.

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof of concept
- The affected version(s)

You will receive an acknowledgement within 2 business days and a status update within 7 days.

## What this action handles

- **Railway API token** — read from the `api-token` input. The first thing the action does on startup is call `core.setSecret(value)` so any subsequent log line that contains the token is masked. The token is sent only to `https://backboard.railway.app/graphql/v2` over HTTPS.
- **Registry password** — read from the `registry-password` input and registered via `core.setSecret` immediately. Used only to `docker login` the registry during digest resolution.
- **Registry username** — read but NOT masked (OCI registry usernames are not secrets per convention; masking them in logs breaks debug-ability).

> ⚠️ **Store sensitive inputs as `secrets`, not `vars`.** GitHub auto-masks `${{ secrets.* }}` in logs; `${{ vars.* }}` is plain text. `core.setSecret` inside the action provides defense-in-depth but cannot retroactively mask log lines emitted before the action started.

## Hardening notes

- All GraphQL response error wrappers strip the request body and headers before logging — your token cannot leak through a stack trace. The error wrapper never sets `Error.cause`, so Node's default unhandled-rejection printer cannot walk back to the underlying transport error and re-emit the request body.
- **Argv injection defense**: image references with a leading `-` are rejected at parse time; every `docker` invocation uses `--` to terminate flags so a future input that slipped through couldn't be interpreted as a docker CLI flag (e.g. `--config`, `--host`).
- **Workflow-command injection defense**: inputs that flow into `ActionError.details` (`api-token`, `token-type`, `first-service`, `registry-username`) reject control chars (`\r`, `\n`) and `%` via regex at parse time. Stderr from `docker` is sanitized (`::` → `∶∶`) before being embedded in any error detail block.
- DRY_RUN logging recursively redacts any object key matching `password|secret|token|credentials` before JSON-stringifying — so even if a future GraphQL variables shape adds credentials at a new path, they won't reach the workflow log.
- **Supply chain**: `npm ci` runs with `ignore-scripts=true` (`.npmrc`), so a fork PR that tampers with `package-lock.json` cannot execute postinstall hooks on the CI runner.
- Bundle is committed (`dist/index.js`) so consumers don't pull `node_modules` at runtime; you can audit exactly what runs.
- The action pins all third-party actions in CI workflows by SHA, and Node by exact patch via `.node-version`.

## SHA-pinning recommendation

Pin consumers to a full commit SHA for maximum supply-chain safety:

```yaml
uses: mediazard/railway-image-update-action@<full-sha>  # vX.Y.Z
```

Rolling major tags (e.g. `@v1`) are provided for consumers who prefer auto-updating within a major version, but pinning by SHA gives you the strongest guarantee that a compromised tag cannot silently change what runs.
