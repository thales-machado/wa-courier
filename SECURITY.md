# Security Policy

## Supported versions

Only the latest release (`latest` image tag / most recent `vX.Y.Z`) receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via [GitHub Security Advisories](https://github.com/thaleslimao/wa-courier/security/advisories/new)
("Report a vulnerability"). You should receive a response within 7 days.

## Scope notes

- WA Courier is designed to run on a private network behind a reverse proxy. Exposing it directly
  to the internet is not a supported deployment model — use `WAC_ALLOWED_CIDRS` and keep the API
  key secret.
- The WhatsApp connection relies on [Baileys](https://github.com/WhiskeySockets/Baileys)
  (unofficial WhatsApp Web protocol). Protocol-level issues should be reported upstream.
