# Security Policy

## Supported versions

Only the latest minor release on each major line receives security updates.

| Version | Supported |
|---------|-----------|
| `v0.x` (latest minor) | Yes |
| older `v0.x` | No |

Once `v1.0.0` ships, support for `v0.x` will end 90 days after the `v1.0.0` release date.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: [REPLACE WITH SECURITY EMAIL]
<!-- TODO: replace the placeholder above with the org security address, e.g. security@mediazard.com -->

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof of concept
- The affected version(s)

You will receive an acknowledgement within 2 business days and a status update within 7 days.

## SHA-pinning recommendation

This action is designed to be pinned by consumers to a full commit SHA for maximum supply-chain safety:

```yaml
uses: mediazard/railway-image-update-action@<full-sha>  # vX.Y.Z
```

A rolling major tag (e.g. `@v0`) is provided for consumers who prefer auto-updating within a major version.
Pinning to a SHA gives you the strongest guarantee that a compromised tag cannot silently change what runs.
