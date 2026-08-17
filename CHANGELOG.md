# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed
- **Inbound media webhook signature moved from a multipart form field to the
  `X-Webhook-Signature` header** (**breaking**): it now matches the status webhook exactly —
  same header name, same `sha256=<hex>` format, same HMAC over
  `messageId.ts.groupJid.sender.fileName.mimetype`. Previously the signature only traveled as
  a `signature` field inside the multipart body, forcing receivers to parse (and buffer) the
  whole request — file included — before they could verify and reject it. Receivers now check
  the header first, matching the pattern used by GitHub/Stripe-style webhooks.
  - **Migration**: read `X-Webhook-Signature` instead of the `signature` form field. The HMAC
    input and algorithm are unchanged, so the expected hash itself doesn't change.

## [2.0.0] - 2026-08-15

### Removed
- **`POST /messages/image`** (**breaking**): it was a strict subset of `POST /messages/media` —
  use that with `type: "image"` and `mediaUrl`/`mediaBase64` instead of `imageUrl`/`imageBase64`.
  The web UI already sends through `/messages/media` only.

### Added
- `GET /ui-config` (authenticated): exposes the effective `WAC_MEDIA_MAX_BYTES` so clients can
  mirror the server-side cap.

### Fixed
- The web UI attachment limit now follows `WAC_MEDIA_MAX_BYTES` (via `/ui-config`) instead of a
  hardcoded 8MB that drifted from the server's real limit in both directions.
- Copy-to-clipboard actions in the UI no longer report success when the clipboard write fails
  (permission denied / non-HTTPS context); the generated API key stays visible for manual copy.

## [1.0.0] - 2026-08-15

Initial public release.

### Messaging
- Single-session WhatsApp HTTP gateway powered by Baileys: text and media (image, video,
  audio, document) to groups and contacts, phone-number resolution, group directory with
  name search and metadata (`?raw=true` opts into the raw Baileys payload).
- **Outbound send queue**: every `/messages/*` request is serialized through a single queue
  with a minimum gap between sends (`WAC_SEND_QUEUE_INTERVAL_MS`, default 1500ms) to stay
  under WhatsApp's burst detection (`rate-overlimit`). The queue is capped
  (`WAC_SEND_QUEUE_MAX_PENDING`, default 100) and drained on `SIGTERM`
  (`WAC_SHUTDOWN_DRAIN_TIMEOUT_MS`, default 20s) so accepted messages aren't dropped on
  restart — pair it with a container stop grace period above the drain timeout
  (`stop_grace_period: 30s` in the provided compose file).
- Send endpoints answer `202 { queued: true }`: they validate and enqueue rather than wait
  for WhatsApp to confirm. Accepted messages appear immediately in `GET /messages/recent`
  (and the UI) as `"queued": true`, and the same entry is updated in place with the outcome.
- The session connects at boot and auto-reconnects with exponential backoff and jitter;
  a remote logout clears stale credentials and returns to the QR pairing state.

### Webhooks
- Delivery-status webhook (`WAC_STATUS_WEBHOOK_URL`) and inbound-media forwarding from
  allow-listed groups (`WAC_INBOUND_MEDIA_WEBHOOK_URL`, multipart/form-data), both with
  optional HMAC-SHA256 signing (`WAC_WEBHOOK_SECRET`) and short network-failure retries.

### Web UI
- Login-gated web UI (`WAC_WEB_USER`/`WAC_WEB_PASS`) for pairing (QR), sending, group
  directory, inbound-media allowlist and recent activity — fully independent from the API
  key. Strict security headers on every response (`X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, CSP without `unsafe-inline`).

### Security
- The API key comes from `WAC_API_KEY` and nowhere else: the gateway never generates,
  stores, reveals or rotates one. Unset means the HTTP API answers
  `503 api_key_not_configured`; the web UI keeps working.
- Credentials (API key, web password, session tokens) are compared in constant time.
- `mediaUrl` fetches are SSRF-guarded: private/internal addresses are blocked, every
  redirect hop is re-validated, and downloads are streamed with an incremental size cap
  (`WAC_MEDIA_MAX_BYTES`, default 20MB, both directions) under a timeout that covers the
  whole body. `mediaBase64` payloads are checked against the same cap (`413`).
- Web logout rotates the session-signing secret, invalidating every outstanding session
  token. Session cookies are `HttpOnly`/`SameSite=Lax`, with `Secure` opt-in
  (`WAC_COOKIE_SECURE`).
- Per-IP rate limits: 30 sends/min, and a separate 10 per 5 minutes budget for login
  attempts. `WAC_TRUST_PROXY` reads the client IP from `X-Forwarded-For` behind a reverse
  proxy.
- Optional IP/CIDR allowlist for every route (`WAC_ALLOWED_CIDRS`), always allowing
  loopback so container healthchecks keep working; invalid entries fail the boot on
  purpose.
- `/metrics` and `/health*` are intentionally unauthenticated (see `SECURITY.md` for how
  to restrict them on untrusted networks).

### Operations
- Prometheus metrics (sends, acks, inbound media, queue depth/rejections, connection
  state) and a ready-made Grafana dashboard; `/health` (liveness), `/health/ready`
  (readiness) and `/widget` (compact authenticated summary).
- Multi-arch container images (amd64/arm64) published to GHCR; compose file pins a
  released version. CI runs lint, tests and dependency audit on every pull request and
  publishes on push/tag, with actions pinned by commit SHA.
