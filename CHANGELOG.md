# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `WAC_TRUST_PROXY`: reads the client IP from `X-Forwarded-For` when behind a reverse proxy,
  so the per-IP rate limiters and `WAC_ALLOWED_CIDRS` see real client addresses instead of the
  proxy's.
- `WAC_COOKIE_SECURE`: marks the web session cookie `Secure` for HTTPS deployments.
- Web logout now rotates the signing secret, invalidating every outstanding session token —
  previously it only cleared the browser's cookie and the token stayed valid until its TTL.
- **Outbound send queue**: every `/messages/*` request is serialized through a single queue with
  a minimum gap between sends (`WAC_SEND_QUEUE_INTERVAL_MS`, default 1500ms), to stay under
  WhatsApp's own burst detection (`rate-overlimit`). The queue is capped
  (`WAC_SEND_QUEUE_MAX_PENDING`, default 100) and drained on `SIGTERM`
  (`WAC_SHUTDOWN_DRAIN_TIMEOUT_MS`, default 20s) so accepted messages aren't dropped on restart.
- Queue metrics: `wa_courier_send_queue_depth` and `wa_courier_send_queue_rejected_total`, so a
  backlog or refused sends can be alerted on rather than only seen in the UI.
- Accepted messages appear in `GET /messages/recent` (and the UI) immediately as
  `"queued": true`, instead of being invisible between the `202` and the actual send. The same
  entry is updated in place with the outcome, so one message is still one row.

### Changed
- **`GET /group/:jid` no longer includes the raw Baileys payload by default** (**breaking**):
  pass `?raw=true` to get it back, matching how `GET /groups` already treats `raw`. The raw
  object doubled the response and exposed the library's internal shape as API surface.
- Internal cleanup, no behavior change: the media size ceiling is parsed once (`utils`), the
  three queued-send handlers share one skeleton, the Baileys disconnect status-code extraction
  is a shared helper, `sleep` has a single definition, the declared media size rides on
  `extractInboundMedia` instead of a second extraction pass, and dead exports were dropped.
- `stop_grace_period: 30s` in `docker-compose.yml`, and the shutdown drain is documented:
  Docker's 10s default would `SIGKILL` the gateway mid-drain and lose already-accepted
  messages. Deployments not using this compose file need the equivalent setting.
- The HTTP body limit is derived from `WAC_MEDIA_MAX_BYTES` instead of being fixed at 12MB.
  Base64 inflates a file by 4/3, so the old fixed limit capped base64 uploads well below the
  configured media size — and did it with a generic Fastify `413` rather than `media_too_large`.
- **The API key now comes from `WAC_API_KEY` and nowhere else** (**breaking**). The gateway no
  longer generates, stores, reveals or rotates a key: `config.json` has no `apiKey` field,
  `GET /auth/api-key` and `POST /auth/rotate-api-key` are gone (replaced by
  `GET /auth/api-key-status`), and the UI offers a client-side "Generate a key" helper instead
  of reveal/copy/rotate. Rotating means editing the env var and restarting.
  - **Upgrading**: copy your current key out of `data/config.json` (or reveal it in the UI)
    into `WAC_API_KEY` *before* deploying, otherwise integrations start getting `401`.
  - With no key set the HTTP API answers `503 api_key_not_configured`; the web UI still works,
    since it authenticates with `WAC_WEB_USER`/`WAC_WEB_PASS`.
- **Send endpoints answer `202` instead of `200`** (**breaking**): they validate and enqueue,
  they no longer wait for WhatsApp to confirm, so the response carries `{ queued: true }`
  rather than a `messageId`. The delivery outcome shows up in `GET /messages/recent` and the
  status webhook, as before.
- Media given as `mediaUrl` is now fetched by the gateway itself, validating every redirect hop
  against the SSRF rules and capping the download — previously only the first URL was checked
  and a redirect could reach an internal address.
- API keys are compared in constant time, matching how the web password and session tokens were
  already handled.

- Added Biome as linter/formatter; CI runs `npm run lint`.
- Added `docker-compose.yml`, `.env.example`, and community docs (CONTRIBUTING, SECURITY,
  CODE_OF_CONDUCT).
- **Internal restructuring**: `src/index.js` (previously ~1400 lines) is now a thin bootstrap.
  Routes were split by domain into `src/routes/*`, and session/auth/error-handling logic moved
  into `src/lib/{courier,accessControl,errors,logger,securityHeaders,staticAssets}.js`, with
  `src/config.js` as the single source of env vars and paths. No route behavior changed.
- **Login brute-force protection**: `/auth/login` now has its own rate limit (10 attempts per
  5 minutes per IP, separate from the 30/min send limiter), returning `429` once exceeded.
- **Error responses no longer leak internal details**: unmapped server errors (`500`) now return
  a generic message to the client; the real error is still logged server-side. Documented error
  codes (`400`/`409` — e.g. `session_not_paired`, `number_not_on_whatsapp`) are unchanged.
- **Security headers** added to every response (`X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, a strict `Content-Security-Policy` with no `unsafe-inline`). The web UI's
  inline `<script>` blocks and the two inline `style=""` attributes were moved to external
  files/CSS classes to support the stricter CSP.
- `WAC_ALLOWED_CIDRS` now always allows loopback (`127.0.0.1`/`::1`), regardless of the
  configured ranges — fixes the Docker `HEALTHCHECK` (which calls `localhost` from inside the
  container) getting blocked when an allowlist is set without an explicit loopback entry.

### Fixed
- The session now connects at boot. Previously it only connected on the first request that
  needed it, so after a restart the inbound-media forwarding stayed silent — losing messages
  from monitored groups — until someone opened the UI or sent a message.
- Queued sends resolve the socket when they actually run instead of capturing it upfront, so a
  reconnect while a message waits in the queue no longer makes it fail against a dead socket.
- The per-IP rate limiter now evicts stale buckets; previously every IP that ever called was
  kept in memory for the life of the process.
- `mediaBase64` payloads are checked against `WAC_MEDIA_MAX_BYTES` on their decoded size and
  rejected with `413 media_too_large`; before, the base64 path could exceed the configured cap
  by the body-limit slack (~1MB) without a specific error.
- `mediaUrl` downloads are read incrementally and aborted past `WAC_MEDIA_MAX_BYTES`; before,
  a response without `Content-Length` (chunked) was buffered whole before the size check, so a
  hostile server could stream the process out of memory. The fetch timeout now also covers the
  body, not just the headers.
- A cookie with malformed percent-encoding made every authenticated route answer `500`
  (`decodeURIComponent` throwing inside cookie parsing); it is now ignored and auth proceeds to
  the normal `401`.
- A queued send task that threw outside its own error handling became an `unhandledRejection`
  (fatal by default in Node); the queue promise now has a terminal catch.
- Sent-log records that resolved after being evicted from the in-memory log leaked an entry in
  the message-id index forever.
- Appends and periodic compaction of `sent.ndjson`/`received.ndjson` are serialized; they could
  interleave and lose lines.

### Security
- `docker-compose.yml` pins the image to a released version instead of `latest`, and the CI
  workflow pins actions by commit SHA — both guard against a mutable tag pulling in unreviewed
  changes.
- `/metrics` and `/health*` being deliberately unauthenticated is now documented in
  `SECURITY.md`, with the recommendation to restrict them via `WAC_ALLOWED_CIDRS` or the
  reverse proxy on untrusted networks.

## [1.0.0]

Initial release: single-session WhatsApp gateway with web UI, messaging API (text/media to groups
and contacts), delivery-status and inbound-media webhooks, Prometheus metrics, and Grafana
dashboard.
