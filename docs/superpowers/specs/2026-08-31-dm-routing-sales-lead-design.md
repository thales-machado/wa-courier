# DM Routing Split: imobiliariaBot vs. SaaS Sales Lead Channel — Design

> Branch: `local/imobiliaria-dm-bot` (experimental, never merges to `main` — see project CLAUDE.md).

## Context

Today `src/lib/imobiliariaBot.js` is the only DM handler: any DM is checked against
an external Postgres (`fn_checar_autorizacao`) and, if authorized, forwarded to a
single CRM webhook (real-estate agency's broker/client intake). Unauthorized DMs
are silently dropped.

The PIX group flow (`src/lib/inboundMedia.js` + `Courier.processIncomingMessage`)
is a separate, unrelated concern — media-only, group-only, no auth — and must stay
untouched by this work.

## Goal

Add a second, fully independent DM channel: the sales/lead-capture funnel for the
wa-courier SaaS product itself. Any DM not claimed by `imobiliariaBot` (unauthorized,
unresolvable, or the feature disabled) falls through to this new channel, which
forwards unconditionally (no authorization) to its own webhook. This channel has
**no relationship** to the real-estate agency's data or webhook — it is a distinct
product with distinct data.

## Non-goals

- No change to the PIX group flow.
- No change to `imobiliariaBot`'s Postgres-backed authorization logic or webhook
  contract, beyond making its entry point report whether it claimed the message.
- No sales-funnel business logic in wa-courier (n8n/CRM's job).
- No rate limiting (explicitly deferred — single-user testing for now).
- No new admin HTTP endpoints (both DM channels are env-var-only, same pattern
  `imobiliariaBot` already uses — no dynamic per-JID list to manage since both are
  catchall-style: one gated by Postgres, one open).
- No automated tests for this module (standing project decision for this branch).

## Design

### File changes

- `src/lib/inboundMedia.js`, `Courier.processIncomingMessage` — **untouched**.
- `src/lib/inboundContent.js` (**new**) — protocol-level parsing shared by both DM
  channels, no business logic:
  - `extractContent(message)` → `{ kind: 'text', text }` or
    `{ kind: 'media', type, ptt, mimetype, fileName, caption, declaredSize }`
    (moved as-is from `imobiliariaBot.js`, covering text/audio/image/document).
  - `isDmJid(jid)` (moved as-is from `imobiliariaBot.js`).
- `src/lib/imobiliariaBot.js` — same behavior, two changes:
  1. Imports `extractContent`/`isDmJid` from `inboundContent.js` instead of
     defining them locally.
  2. `handleIncomingDm(courier, message)` now **returns a boolean**: `true` if the
     message was authorized and forwarding was attempted (regardless of the
     webhook's own HTTP outcome), `false` for every early-return path (not a DM,
     `fromMe`, unsupported content, phone unresolved, denylisted, not authorized).
  3. New denylist check, right after phone resolution and before the Postgres
     query: if the resolved phone is in `WAC_IMOBILIARIA_DENYLIST`, return `false`
     immediately (no Postgres call). Lets a specific number be permanently excluded
     from this flow regardless of what Postgres says — used for the owner's own
     testing number so it always falls through to the sales channel.
- `src/lib/salesLeadBot.js` (**new**) — mirrors `imobiliariaBot.js`'s shape, minus
  Postgres/auth/cache:
  - `isEnabled()` → `Boolean(webhookUrl)`, `webhookUrl` from
    `WAC_SALES_LEAD_WEBHOOK_URL` (unset today — code must handle that gracefully,
    same as `inboundMediaWebhookUrl` does: log and skip, never throw).
  - `handleIncomingDm(courier, message)` — never throws. Extracts content via
    `inboundContent.extractContent`; if unsupported, returns. Forwards
    unconditionally (`authMode: none`) — text via JSON POST, media via multipart,
    both using the existing `signPayload`/`postJsonWithRetry` helpers in
    `./webhook.js` (same `X-Webhook-Signature` pattern as the other two webhooks).
    `from` is the raw `remoteJid` — no PN/LID phone normalization, since there's no
    Postgres lookup keyed by phone here.
- `src/lib/courier.js` (`handleIncomingMessages`) — replaces the single
  `dmBotEnabled` branch with a claim chain for DMs:

  ```js
  const dmBotEnabled = imobiliariaBot.isEnabled()
  const salesBotEnabled = salesLeadBot.isEnabled()
  if (allowedGroups.size === 0 && !dmBotEnabled && !salesBotEnabled) return

  for (const message of messages || []) {
    try {
      const remoteJid = message?.key?.remoteJid
      if (isDmJid(remoteJid)) {
        let claimed = false
        if (dmBotEnabled) claimed = await imobiliariaBot.handleIncomingDm(this, message)
        if (!claimed && salesBotEnabled) await salesLeadBot.handleIncomingDm(this, message)
      } else {
        await this.processIncomingMessage(message, allowedGroups)
      }
    } catch (error) {
      logger.error({ error }, 'Failed to process incoming message')
    }
  }
  ```

  `isDmJid` imported from `inboundContent.js` here too.

### Webhook payload — sales lead channel (new contract, no compatibility constraint)

Text (JSON body, signed the same way as the status webhook):

```json
{ "event": "sales_lead.message", "kind": "text", "from": "...", "messageId": "...", "ts": "...", "text": "..." }
```

Media (multipart form, signature over the metadata fields, same convention as
`forwardInboundMedia`/`imobiliariaBot.forwardMedia`):

- `event=sales_lead.message`, `kind=media`, `from`, `messageId`, `ts`, `type`,
  `ptt`, `fileName`, `mimetype`, `caption`, `file` (the blob).

No `authorized`/`tipo` field — this channel has no authorization concept.

### Denylist format

`WAC_IMOBILIARIA_DENYLIST` — comma-separated plain phone numbers, same normalized
format `resolvePhone` already produces (country code + area code + number, digits
only, e.g. `5511999999999` — placeholder, never a real number in this repo). Real
values live only in the deployer's local/production env, never committed.

### Env vars introduced

- `WAC_SALES_LEAD_WEBHOOK_URL` — sales lead channel's webhook target. Not set yet;
  code must behave correctly with it empty (`isEnabled()` false, channel inert).
- `WAC_IMOBILIARIA_DENYLIST` — comma-separated phone numbers excluded from the
  `imobiliariaBot` flow regardless of Postgres.

## Self-review

1. **Placeholder scan** — no TBD/TODO left; `WAC_SALES_LEAD_WEBHOOK_URL` being
   unset is a stated, intentional starting condition, not a placeholder.
2. **Internal consistency** — `courier.js`'s claim chain matches the return-boolean
   contract defined for `imobiliariaBot.handleIncomingDm`; `salesLeadBot` doesn't
   need a return value consumed by anything (last in the chain), but returns
   `undefined` implicitly like `imobiliariaBot` did before this change — harmless,
   no caller reads it.
3. **Scope check** — single implementation plan, three new/changed files plus one
   orchestration edit in `courier.js`. Not decomposed further.
4. **Ambiguity check** — "claimed" is defined precisely (authorized AND processed
   attempt started, independent of the webhook HTTP outcome) to avoid the ambiguous
   reading "claimed = webhook succeeded" (which would wrongly let a transient
   network failure re-route an authorized broker's message to the sales channel).
