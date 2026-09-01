# DM Routing Split: imobiliariaBot vs. Sales Lead Channel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split DM handling into two independent handlers — the existing Postgres-backed `imobiliariaBot` and a new, always-on `salesLeadBot` catchall — chained in `courier.js` so any DM not claimed by the first falls through to the second.

**Architecture:** Extract the protocol-level message parsing (`extractContent`, `isDmJid`) out of `imobiliariaBot.js` into a new shared, business-logic-free module `inboundContent.js`. `imobiliariaBot.js` keeps its Postgres auth/cache/webhook logic, gains a phone denylist check, and its `handleIncomingDm` now returns a boolean ("claimed"). A new `salesLeadBot.js` mirrors its shape minus Postgres — it claims and forwards unconditionally. `courier.js`'s `handleIncomingMessages` chains the two handlers for DM-eligible messages; the PIX group path is untouched.

**Tech Stack:** Node.js (CommonJS), Baileys, `node:crypto` HMAC via `./webhook.js`, Fetch API (`FormData`/`Blob`/multipart).

**Spec:** `docs/superpowers/specs/2026-08-31-dm-routing-sales-lead-design.md`

## Global Constraints

- Branch `local/imobiliaria-dm-bot` only — never opens a PR, never merges to `main`.
- `src/lib/inboundMedia.js` and `Courier.processIncomingMessage` (PIX group flow) — never touched.
- Code and comments in English (repo-wide convention, applies even on this branch — only `Claude.md` and this branch's own spec/plan docs are pt-br).
- No automated tests for this module (standing decision) — verification is `npm run lint`, `npm test` (existing suite must stay green — it must not regress), and manual reasoning/`node -e` smoke checks, not new test files.
- No rate limiting.
- No new admin HTTP endpoints.
- `WAC_SALES_LEAD_WEBHOOK_URL` is unset today — `salesLeadBot` must stay fully inert (no throws, no wasted work) when it's empty.
- Real phone numbers, message content, or JIDs must never appear in code, comments, commit messages, or this plan — placeholders only (e.g. `5511999999999`).
- Run `npm run lint && npm test` after each task; report failures before moving on.

---

### Task 1: Extract shared inbound content parsing into `inboundContent.js`

**Files:**
- Create: `src/lib/inboundContent.js`
- Modify: `src/lib/imobiliariaBot.js:1-330` (remove `extractContent`, `isDmJid`, `normalizeSize`; import from new module)

**Interfaces:**
- Produces: `extractContent(message)` → `{ kind: 'text', text }` or `{ kind: 'media', type, ptt, mimetype, fileName, caption, declaredSize }` or `null`.
- Produces: `isDmJid(jid)` → `boolean`.

- [ ] **Step 1: Create `src/lib/inboundContent.js`**

```js
'use strict'

// EXPERIMENTAL — local/imobiliaria-dm-bot branch only, never merged to main.
//
// Protocol-level parsing shared by every DM handler on this branch (imobiliariaBot,
// salesLeadBot). No business logic, no auth, no webhook knowledge — just turning a
// Baileys message into a plain { kind, ... } shape.

const { isUserJid, isLidJid } = require('./utils')

function isDmJid(jid) {
  return isUserJid(jid) || isLidJid(jid)
}

function normalizeSize(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return raw
  if (typeof raw.toNumber === 'function') return raw.toNumber()
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function extractContent(message) {
  const content = message?.message
  if (!content) return null

  const text = content.conversation || content.extendedTextMessage?.text
  if (text) return { kind: 'text', text }

  const audio = content.audioMessage
  if (audio) {
    const ext = (audio.mimetype || 'audio/ogg').split('/')[1]?.split(';')[0] || 'ogg'
    return {
      kind: 'media',
      type: 'audio',
      ptt: Boolean(audio.ptt),
      mimetype: audio.mimetype || 'audio/ogg',
      fileName: `audio.${ext}`,
      caption: null,
      declaredSize: normalizeSize(audio.fileLength)
    }
  }

  const image = content.imageMessage
  if (image) {
    const ext = (image.mimetype || 'image/jpeg').split('/')[1] || 'jpg'
    return {
      kind: 'media',
      type: 'image',
      ptt: false,
      mimetype: image.mimetype || 'image/jpeg',
      fileName: `image.${ext}`,
      caption: image.caption || null,
      declaredSize: normalizeSize(image.fileLength)
    }
  }

  const doc = content.documentMessage || content.documentWithCaptionMessage?.message?.documentMessage
  if (doc) {
    return {
      kind: 'media',
      type: 'document',
      ptt: false,
      mimetype: doc.mimetype || 'application/octet-stream',
      fileName: doc.fileName || 'document',
      caption: doc.caption || null,
      declaredSize: normalizeSize(doc.fileLength)
    }
  }

  return null
}

module.exports = { extractContent, isDmJid }
```

- [ ] **Step 2: Remove the moved code from `src/lib/imobiliariaBot.js`**

Delete lines 46-48 (`isDmJid`), the `extractContent` function (lines 142-191), and the `normalizeSize` function (lines 193-199). Delete the now-unused `isUserJid, isLidJid` entries from the `./utils` require on line 17 (keep `normalizePnJid, mediaMaxBytes`).

- [ ] **Step 3: Add the new import to `src/lib/imobiliariaBot.js`**

Right below the existing `require('./webhook')` line:

```js
const { extractContent, isDmJid } = require('./inboundContent')
```

- [ ] **Step 4: Run lint and test**

Run: `npm run lint && npm test`
Expected: PASS, no regressions (39 files clean per prior baseline; suite green).

- [ ] **Step 5: Smoke-check the extraction didn't change behavior**

Run: `node -e "const {extractContent, isDmJid} = require('./src/lib/inboundContent'); console.log(isDmJid('5511999999999@s.whatsapp.net')); console.log(extractContent({message:{conversation:'hi'}}))"`
Expected output: `true` then `{ kind: 'text', text: 'hi' }`

- [ ] **Step 6: Commit**

```bash
git add src/lib/inboundContent.js src/lib/imobiliariaBot.js
git commit -m "refactor: extract inbound content parsing into shared inboundContent.js"
```

---

### Task 2: `imobiliariaBot.handleIncomingDm` returns claimed boolean + denylist check

**Files:**
- Modify: `src/lib/imobiliariaBot.js` (env var block near line 19-20, `handleIncomingDm` body currently lines 250-328)

**Interfaces:**
- Consumes: `extractContent`, `isDmJid` from Task 1 (`./inboundContent`).
- Produces: `handleIncomingDm(courier, message)` → `Promise<boolean>` — `true` only when the message was authorized and a forward attempt was made; `false` on every other exit path (not enabled, not a DM, `fromMe`, unsupported content, phone unresolved, denylisted, unauthorized, unexpected internal error).

- [ ] **Step 1: Add the denylist env var and a parsed `Set`, next to the existing `webhookUrl`/`pgUrl` constants**

```js
const webhookUrl = process.env.WAC_IMOBILIARIA_WEBHOOK_URL || null
const pgUrl = process.env.WAC_IMOBILIARIA_PG_URL || null

// phones that must never be treated as broker/client here, regardless of Postgres state —
// defense in depth so a specific number always falls through to the sales-lead catchall
const denylist = new Set(
  (process.env.WAC_IMOBILIARIA_DENYLIST || '')
    .split(',')
    .map((phone) => phone.trim())
    .filter(Boolean)
)
```

- [ ] **Step 2: Rewrite `handleIncomingDm` to return `boolean` on every path**

Replace the whole function body (currently starting `async function handleIncomingDm(courier, message) {` through its closing `}` before `module.exports`) with:

```js
async function handleIncomingDm(courier, message) {
  try {
    if (!isEnabled()) return false
    const remoteJid = message?.key?.remoteJid
    if (message?.key?.fromMe) return false
    if (!isDmJid(remoteJid)) return false

    const socket = courier.socket
    if (!socket) return false

    logger.debug(
      {
        remoteJid,
        messageId: message?.key?.id || null,
        senderPn: message?.key?.senderPn || null,
        contentKeys: Object.keys(message?.message || {})
      },
      'imobiliaria: dm received'
    )

    const content = extractContent(message)
    if (!content) {
      logger.debug({ remoteJid, messageId: message?.key?.id || null }, 'imobiliaria: unsupported content; ignoring')
      return false
    }
    logger.debug(
      { remoteJid, kind: content.kind, type: content.type || null, ptt: content.ptt || false },
      'imobiliaria: content extracted'
    )

    const phone = await resolvePhone(socket, message)
    if (!phone) {
      logger.warn(
        { remoteJid, senderPn: message?.key?.senderPn || null },
        'imobiliaria: could not resolve phone for dm; ignoring'
      )
      return false
    }

    if (denylist.has(phone)) {
      logger.debug({ phone }, 'imobiliaria: phone denylisted; ignoring')
      return false
    }

    const { authorized, tipo } = await checkAuth(phone)
    if (!authorized) {
      logger.debug({ phone }, 'imobiliaria: sender not authorized; ignoring')
      return false
    }

    const messageId = message.key.id || null
    const ts = new Date().toISOString()

    if (content.kind === 'text') {
      await forwardText({ contactJid: remoteJid, phone, messageId, ts, text: content.text, tipo })
      logger.info({ phone, messageId }, 'imobiliaria: text forwarded')
      return true
    }

    if (content.declaredSize && content.declaredSize > mediaMaxBytes) {
      logger.warn({ phone, messageId, declaredSize: content.declaredSize }, 'imobiliaria: media exceeds size limit')
      return true
    }

    let buffer
    try {
      buffer = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
    } catch (error) {
      logger.error({ error, phone, messageId }, 'imobiliaria: failed to download dm media')
      return true
    }

    if (buffer.length > mediaMaxBytes) {
      logger.warn({ phone, messageId, size: buffer.length }, 'imobiliaria: downloaded media exceeds size limit')
      return true
    }

    const ok = await forwardMedia({ buffer, media: content, contactJid: remoteJid, phone, messageId, ts, tipo })
    if (ok) logger.info({ phone, messageId, type: content.type }, 'imobiliaria: media forwarded')
    else logger.warn({ phone, messageId }, 'imobiliaria: webhook responded non-2xx')
    return true
  } catch (error) {
    logger.error({ error: error?.message }, 'imobiliaria: unexpected failure handling dm')
    return false
  }
}
```

Note: once the sender is authorized, every subsequent early return (size limit, download failure, non-2xx) still returns `true` — the message *was* claimed by this route (an authorized broker), it just failed to forward. It must never fall through to the sales-lead channel, which would leak an authorized broker's message into the wrong webhook.

- [ ] **Step 3: Update the trailing `module.exports`**

`extractContent` and `isDmJid` are no longer defined in this file (Task 1 moved them) — drop them from the export list here:

```js
module.exports = { isEnabled, handleIncomingDm }
```

- [ ] **Step 4: Run lint and test**

Run: `npm run lint && npm test`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/lib/imobiliariaBot.js
git commit -m "feat: imobiliariaBot.handleIncomingDm returns claimed boolean, add phone denylist"
```

---

### Task 3: New `salesLeadBot.js` catchall channel

**Files:**
- Create: `src/lib/salesLeadBot.js`

**Interfaces:**
- Consumes: `extractContent` from `./inboundContent` (Task 1); `signPayload`, `postJsonWithRetry` from `./webhook`; `mediaMaxBytes` from `./utils`; `downloadMediaMessage` from `baileys`.
- Produces: `isEnabled()` → `boolean`. `handleIncomingDm(courier, message)` → `Promise<void>` — never throws, always attempts a forward when content is supported (no auth gate).

- [ ] **Step 1: Create `src/lib/salesLeadBot.js`**

```js
'use strict'

// EXPERIMENTAL — local/imobiliaria-dm-bot branch only, never merged to main.
//
// Catchall sales-lead intake for the wa-courier SaaS itself: any DM not claimed by
// imobiliariaBot (unauthorized, unresolved phone, or that feature disabled) lands here
// and is forwarded unconditionally to a separate webhook — no Postgres, no auth, no
// relation to the real-estate CRM's broker/client data.

const { downloadMediaMessage } = require('baileys')

const logger = require('./logger')
const { signPayload, postJsonWithRetry } = require('./webhook')
const { mediaMaxBytes } = require('./utils')
const { extractContent } = require('./inboundContent')

const webhookUrl = process.env.WAC_SALES_LEAD_WEBHOOK_URL || null

function isEnabled() {
  return Boolean(webhookUrl)
}

async function forwardText({ from, messageId, ts, text }) {
  return postJsonWithRetry(
    webhookUrl,
    { event: 'sales_lead.message', kind: 'text', from, messageId, ts, text },
    { secret: process.env.WAC_WEBHOOK_SECRET || undefined }
  )
}

async function forwardMedia({ buffer, media, from, messageId, ts }) {
  const headers = {}
  const secret = process.env.WAC_WEBHOOK_SECRET
  if (secret) {
    const signature = signPayload(secret, `${messageId || ''}.${ts}.${from}.${media.fileName}.${media.mimetype}`)
    headers['X-Webhook-Signature'] = `sha256=${signature}`
  }

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: media.mimetype }), media.fileName)
  form.append('event', 'sales_lead.message')
  form.append('kind', 'media')
  form.append('from', from)
  form.append('type', media.type)
  form.append('ptt', String(media.ptt))
  form.append('fileName', media.fileName)
  form.append('mimetype', media.mimetype)
  form.append('caption', media.caption || '')
  form.append('messageId', messageId || '')
  form.append('ts', ts)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers, body: form, signal: controller.signal })
    return res.ok
  } finally {
    clearTimeout(timeout)
  }
}

// Entry point, called from courier.handleIncomingMessages as the fallback for DMs
// imobiliariaBot didn't claim. Never throws: this experimental path must not be able
// to break message processing.
async function handleIncomingDm(courier, message) {
  try {
    if (!isEnabled()) return
    const remoteJid = message?.key?.remoteJid
    if (message?.key?.fromMe) return

    const socket = courier.socket
    if (!socket) return

    const content = extractContent(message)
    if (!content) {
      logger.debug({ remoteJid, messageId: message?.key?.id || null }, 'sales-lead: unsupported content; ignoring')
      return
    }

    const messageId = message.key.id || null
    const ts = new Date().toISOString()

    if (content.kind === 'text') {
      await forwardText({ from: remoteJid, messageId, ts, text: content.text })
      logger.info({ remoteJid, messageId }, 'sales-lead: text forwarded')
      return
    }

    if (content.declaredSize && content.declaredSize > mediaMaxBytes) {
      logger.warn({ remoteJid, messageId, declaredSize: content.declaredSize }, 'sales-lead: media exceeds size limit')
      return
    }

    let buffer
    try {
      buffer = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
    } catch (error) {
      logger.error({ error, remoteJid, messageId }, 'sales-lead: failed to download dm media')
      return
    }

    if (buffer.length > mediaMaxBytes) {
      logger.warn({ remoteJid, messageId, size: buffer.length }, 'sales-lead: downloaded media exceeds size limit')
      return
    }

    const ok = await forwardMedia({ buffer, media: content, from: remoteJid, messageId, ts })
    if (ok) logger.info({ remoteJid, messageId, type: content.type }, 'sales-lead: media forwarded')
    else logger.warn({ remoteJid, messageId }, 'sales-lead: webhook responded non-2xx')
  } catch (error) {
    logger.error({ error: error?.message }, 'sales-lead: unexpected failure handling dm')
  }
}

module.exports = { isEnabled, handleIncomingDm }
```

- [ ] **Step 2: Run lint and test**

Run: `npm run lint && npm test`
Expected: PASS, no regressions.

- [ ] **Step 3: Smoke-check `isEnabled()` is false with the env var unset**

Run: `node -e "delete process.env.WAC_SALES_LEAD_WEBHOOK_URL; console.log(require('./src/lib/salesLeadBot').isEnabled())"`
Expected output: `false`

- [ ] **Step 4: Commit**

```bash
git add src/lib/salesLeadBot.js
git commit -m "feat: add salesLeadBot catchall DM channel for wa-courier sales leads"
```

---

### Task 4: Wire the claim chain into `courier.js`

**Files:**
- Modify: `src/lib/courier.js:22-23` (requires), `src/lib/courier.js:298-316` (`handleIncomingMessages`)

**Interfaces:**
- Consumes: `imobiliariaBot.isEnabled()`, `imobiliariaBot.handleIncomingDm(courier, message)` → `Promise<boolean>` (Task 2); `salesLeadBot.isEnabled()`, `salesLeadBot.handleIncomingDm(courier, message)` → `Promise<void>` (Task 3); `isDmJid` from `./inboundContent` (Task 1).

- [ ] **Step 1: Add the new requires next to the existing `imobiliariaBot` require (courier.js line 22-23)**

```js
// EXPERIMENTAL (local branch only) — see src/lib/imobiliariaBot.js header
const imobiliariaBot = require('./imobiliariaBot')
const salesLeadBot = require('./salesLeadBot')
const { isDmJid } = require('./inboundContent')
```

- [ ] **Step 2: Replace `handleIncomingMessages` (courier.js lines 298-316)**

```js
  async handleIncomingMessages({ messages, type }) {
    if (type !== 'notify') return
    const allowedGroups = new Set(this.getInboundMediaGroups())
    // EXPERIMENTAL (local branch only): DM bot chain — inert unless either bot's env vars are set
    const dmBotEnabled = imobiliariaBot.isEnabled()
    const salesBotEnabled = salesLeadBot.isEnabled()
    if (allowedGroups.size === 0 && !dmBotEnabled && !salesBotEnabled) return

    for (const message of messages || []) {
      try {
        if (isDmJid(message?.key?.remoteJid)) {
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
  }
```

- [ ] **Step 3: Run lint and test**

Run: `npm run lint && npm test`
Expected: PASS, no regressions (this is the integration point — pay special attention to the existing PIX-flow tests still passing unchanged).

- [ ] **Step 4: Manual reasoning check (no automated test, per project decision for this module)**

Confirm by reading the diff: with both `WAC_IMOBILIARIA_WEBHOOK_URL`/`WAC_IMOBILIARIA_PG_URL` and `WAC_SALES_LEAD_WEBHOOK_URL` unset (default/PIX-only deployment), `dmBotEnabled` and `salesBotEnabled` are both `false`, so the `if (allowedGroups.size === 0 && !dmBotEnabled && !salesBotEnabled) return` guard behaves exactly as the old `if (allowedGroups.size === 0 && !dmBotEnabled) return` did — zero behavior change for a plain PIX deployment.

- [ ] **Step 5: Commit**

```bash
git add src/lib/courier.js
git commit -m "feat: chain imobiliariaBot -> salesLeadBot fallback for unclaimed DMs"
```

---

## Post-implementation manual verification (per user's original acceptance checklist)

Not automatable (no test framework for this module) — run manually against a live gateway before considering the feature done, per the user's own "Ao terminar" checklist:

1. PIX group media still triggers the PIX webhook with zero regression (send an image to an allowed PIX group, confirm the existing webhook fires as before).
2. An authorized broker's DM still routes to `imobiliariaBot`'s CRM webhook, not the sales-lead one (test number must already be authorized in Postgres, and must NOT be in `WAC_IMOBILIARIA_DENYLIST`).
3. An unregistered/denylisted number's text DM triggers the new `sales_lead.message` webhook call — with `WAC_SALES_LEAD_WEBHOOK_URL` unset during this testing round, confirm via logs that `salesLeadBot.isEnabled()` is `false` and it's skipped gracefully (no throw), matching the existing `webhook_not_configured`-equivalent pattern; end-to-end delivery can only be confirmed once that env var is actually set to a real endpoint.
