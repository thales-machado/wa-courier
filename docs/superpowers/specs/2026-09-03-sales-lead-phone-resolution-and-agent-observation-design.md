# Sales-lead phone resolution and human-agent observation — design

Branch: `local/imobiliaria-dm-bot` (experimental, never merged to `main`).

## Context

Three flows share `handleIncomingMessages` (`src/lib/courier.js:300`):

1. Group message → `processIncomingMessage` → PIX webhook (production, untouched).
2. DM claimed by `imobiliariaBot.handleIncomingDm` (registered broker/client) → CRM webhook.
3. DM not claimed → `salesLeadBot.handleIncomingDm` (catchall) → `WAC_SALES_LEAD_WEBHOOK_URL`.

`handleIncomingMessages` already guards `type !== 'notify'` (line 301) before any message reaches the claim chain, so both tasks below only ever see `notify`-type messages — no separate type check needed downstream.

This design covers two independent changes, both scoped to flow 3 (`src/lib/salesLeadBot.js`), plus one shared extraction that also touches flow 2 (`src/lib/imobiliariaBot.js`).

## Part A — resolve the lead's real phone number

### Problem

`salesLeadBot.handleIncomingDm` forwards `message.key.remoteJid` verbatim as `from`. When the contact has number-privacy enabled, `remoteJid` is an opaque `@lid` value with no derivable phone number, breaking downstream CRM/lead matching.

### Extraction

Move `resolvePhone` from `src/lib/imobiliariaBot.js:63-96` to `src/lib/identity.js`, unchanged in behavior:

```js
async function resolvePhone(socket, message) {
  const key = message?.key || {}
  const remoteJid = key.remoteJid

  let pnJid = normalizePnJid(remoteJid) || normalizePnJid(key.senderPn) || normalizePnJid(key.participantPn)
  let source = pnJid
    ? normalizePnJid(remoteJid)
      ? 'remoteJid'
      : normalizePnJid(key.senderPn)
        ? 'key.senderPn'
        : 'key.participantPn'
    : null

  if (!pnJid && isLidJid(remoteJid)) {
    try {
      const mapping = socket?.signalRepository?.lidMapping
      if (mapping && typeof mapping.getPNForLID === 'function') {
        pnJid = normalizePnJid(await mapping.getPNForLID(remoteJid))
        if (pnJid) source = 'lidMapping'
      }
    } catch (error) {
      logger.debug({ error: error?.message, remoteJid }, 'identity: lid->pn resolution failed')
    }
  }

  logger.debug(
    { remoteJid, senderPn: key.senderPn || null, participantPn: key.participantPn || null, resolved: pnJid, source },
    'identity: phone resolution'
  )

  if (!pnJid) return null
  const phone = pnJid.split('@')[0]
  return /^\d+$/.test(phone) ? phone : null
}
```

Log message text changes from `'imobiliaria: phone resolution'`/`'imobiliaria lid->pn resolution failed'` to `'identity: phone resolution'`/`'identity: lid->pn resolution failed'` (confirmed acceptable — the function moved modules, so the log prefix should reflect that). Everything else — cascade order, `source` derivation, dead `lidMapping` fallback (kept, not exercised by `baileys@6.7.24`), null-safety — is unchanged.

`identity.js` already imports `isLidJid`, `normalizePnJid` from `./utils` and has its own `logger` require — `resolvePhone` reuses both, no new imports needed beyond what's already there.

`imobiliariaBot.js` drops its local `resolvePhone` definition and its now-unused `isLidJid` import (kept: `normalizePnJid`, still used nowhere else in that file — check before removing), and calls `identity.resolvePhone(socket, message)` at the same call site (line 225). No other line in `imobiliariaBot.js` changes; this must be behavior-identical, including the denylist/auth-cache flow that depends on `resolvePhone`'s return value.

### salesLeadBot usage

`handleIncomingDm` calls `identity.resolvePhone(socket, message)` right after obtaining `socket` (mirroring where `imobiliariaBot` calls it), before content extraction — resolution failure must never block forwarding, so the result is just carried through as data, not branched on for control flow (except logging).

### Payload contract

`from` stays the raw `remoteJid` (addressable JID). A new field `fromPn` carries the resolved phone (plain digits) or `null`. `fromPn` is **not** part of the HMAC-signed string for either text or media — this is the change that keeps the current n8n `Montar Payload Canônico` node working unmodified.

**Text (`forwardText`):** body sent becomes `{ event, kind, from, fromPn, messageId, ts, text }`, but the string signed must remain exactly `JSON.stringify({ event, kind, from, messageId, ts, text })` (today's 6-field shape) — otherwise the signature diverges from what n8n reconstructs, even though `fromPn` isn't one of the fields n8n uses. See "webhook.js change" below for how this is achieved without duplicating the signing/retry logic.

**Media (`forwardMedia`):** already builds its own signed string manually (`` `${messageId||''}.${ts}.${from}.${media.fileName}.${media.mimetype}` ``), independent of the multipart body. Add `form.append('fromPn', fromPn || '')` to the form without touching the signed string — no further change needed here.

### webhook.js change

`postJsonWithRetry(url, body, { secret, ... })` currently signs `JSON.stringify(body)` — the entire body, verbatim. Adding `fromPn` to the object passed as `body` would change what gets signed, breaking the n8n-side reconstruction even though the *intent* is to keep it out of the signature.

Add an optional `signedPayload` option: when provided, sign that exact string instead of `JSON.stringify(body)`; when omitted, behavior is identical to today (signs the body). This is additive and backward-compatible — `imobiliariaBot.forwardText` (the only other JSON caller) keeps calling `postJsonWithRetry` without the new option and is unaffected.

```js
async function postJsonWithRetry(url, body, { secret, signedPayload, timeoutMs = 5000, retryDelaysMs = defaultRetryDelaysMs } = {}) {
  const payload = JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers['X-Webhook-Signature'] = `sha256=${signPayload(secret, signedPayload ?? payload)}`
  // ...unchanged from here
}
```

`salesLeadBot.forwardText` then calls:

```js
async function forwardText({ from, fromPn, messageId, ts, text }) {
  const body = { event: 'sales_lead.message', kind: 'text', from, fromPn, messageId, ts, text }
  const signedPayload = JSON.stringify({ event: body.event, kind: body.kind, from, messageId, ts, text })
  return postJsonWithRetry(webhookUrl, body, {
    secret: process.env.WAC_WEBHOOK_SECRET || undefined,
    signedPayload
  })
}
```

### Resolution failure

If `resolvePhone` returns `null`, forward anyway with `fromPn: null` (JSON) / `fromPn: ''` (multipart form field, since form fields can't carry `null`). Never drop the message.

## Part B — observe the human agent's replies

### Problem

`salesLeadBot.handleIncomingDm` discards every `fromMe: true` message with a silent `return` (line 69). Messages sent from the paired phone (a separate linked device from wa-courier's own socket, in WhatsApp multi-device terms) arrive via `messages.upsert` exactly like any other message, but never reach the CRM — so the n8n-side inactivity clock that would un-escalate a conversation never resets.

### Echo investigation (resolved)

Confirmed by reading `baileys@6.7.24` source directly:

- `messages.upsert` is only ever emitted from `src/Socket/messages-recv.js`, inside `handleMessage`/`handleNotification`, both driven by `<message>`/notification stanzas **received** over the WebSocket (decoded via `decodeMessageNode`/`decryptMessageNode`, `fromMe` derived from `stanza.attrs.participant || stanza.attrs.from`).
- `src/Socket/messages-send.js` (home of `sendMessage`) never emits `messages.upsert` — it only emits `messages.update` to reflect local send state.

Conclusion: **wa-courier's own sends never echo back through `messages.upsert`.** There is no feedback loop to guard against. A message sent by the paired phone (a different linked device) fans out to wa-courier's socket as a normal incoming stanza with `fromMe: true, type: 'notify'` — exactly the signal Part B needs, with nothing to filter out.

This removes the need for any `messageId` tracking, in-memory table, or `data/sent.ndjson` cross-reference — the entire mechanism the prompt asked to evaluate the cost/benefit of is unnecessary given this finding.

### Change

In `salesLeadBot.handleIncomingDm`:

- Remove the unconditional `if (message?.key?.fromMe) return`.
- When `fromMe` is true: this DM already reached `salesLeadBot` only because `imobiliariaBot` didn't claim it (courier.js's claim chain — `imobiliariaBot.handleIncomingDm` already returns `false` immediately for any `fromMe` message, at its own line 199, before touching Postgres). So "not claimed" is the exact same test already used for the inbound case; no new state or lookup is needed.
- Text: forward via `forwardText`, with `direction: 'outbound'` added to the payload (inbound case gets `direction: 'inbound'` for symmetry, so the n8n consumer never has to infer direction from absence). `fromPn` is not meaningful for outbound (it's *our* message, not the lead's) — omit it or send `null`; going with `null` for a consistent shape. `from` is still `remoteJid` (the conversation being replied into).
- Media: log at `info` level (`'sales-lead: outbound media from agent; not forwarded'`) and drop, per explicit scope limit.
- `direction` is a new field, same treatment as `fromPn`: added to the body, excluded from the signed string for text; added to the multipart form (not applicable here since outbound is text-only, so `forwardMedia`'s signed string is untouched by this task).

### Signed-string impact for Part B

Text forwarding's signed string gains no new field from Part B beyond what Part A already introduced as the mechanism (`signedPayload` override) — `direction` goes into `body`, stays out of `signedPayload`, same as `fromPn`. Canonical signed string for all text forwards, inbound or outbound, remains `JSON.stringify({ event, kind, from, messageId, ts, text })`.

## Files touched

- `src/lib/identity.js` — add `resolvePhone` (moved from `imobiliariaBot.js`).
- `src/lib/imobiliariaBot.js` — remove local `resolvePhone`, call `identity.resolvePhone`; remove now-unused imports if any.
- `src/lib/salesLeadBot.js` — use `identity.resolvePhone`; add `fromPn`/`direction` fields; replace the `fromMe` early-return with outbound forwarding.
- `src/lib/webhook.js` — add optional `signedPayload` param to `postJsonWithRetry`.

## Out of scope (explicitly, per the prompt)

- The 1-hour inactivity clock and `escalado_humano` state transition — n8n's responsibility, not wa-courier's.
- Outbound media forwarding — log and drop only.
- `imobiliariaBot`'s own payload contract — untouched, no `fromPn`/`direction` added there (it already resolves and forwards `phone`, and has no outbound-observation requirement in this prompt).
- Rate limiting, message deduplication, persistence of anything new to disk.

## Verification checklist (from the originating prompt, carried into the plan's final task)

1. Image/document in PIX groups still triggers the PIX webhook unchanged.
2. Registered broker's DM still claimed by `imobiliariaBot`, does not fall through to sales catchall.
3. Unregistered `@lid`-addressed DM text arrives at the lead webhook with `fromPn` resolved via `key.senderPn`.
4. HMAC signature for text and media payloads unchanged from today (verified by asserting the exact signed string in tests, not just "webhook accepted").
5. Reply sent from the paired phone arrives at the webhook with `direction: 'outbound'`.
6. Reply sent by wa-courier itself (`POST /messages/text`) does not arrive at the webhook at all (confirmed structurally: no code path exists for wa-courier's own sends to re-enter `handleIncomingMessages`, since `messages.upsert` never fires for them — this is a code-review/architecture check, not a runtime test, given point 6 is a negative/absence claim).
