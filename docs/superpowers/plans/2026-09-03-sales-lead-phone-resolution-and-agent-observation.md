# Sales-lead phone resolution and human-agent observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the sales lead's real phone number (instead of a possibly-opaque `@lid`) and forward human-agent replies to the sales-lead webhook, both scoped to `src/lib/salesLeadBot.js` on branch `local/imobiliaria-dm-bot`.

**Architecture:** Extract the existing phone-resolution cascade from `imobiliariaBot.js` into the shared `identity.js` module so both DM handlers use it. Add a `fromPn` field and a `direction` field to the sales-lead webhook payload, both additive and kept outside the HMAC-signed string via a new optional `signedPayload` override on `postJsonWithRetry`. Replace `salesLeadBot`'s silent `fromMe` early-return with outbound forwarding, made safe by a confirmed absence of self-send echo in `baileys@6.7.24`.

**Tech Stack:** Node.js, `node --test`, Biome (lint/format), Baileys 6.7.24, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-03-sales-lead-phone-resolution-and-agent-observation-design.md`

## Global Constraints

- `salesLeadBot.handleIncomingDm` must never throw — the top-level try/catch stays.
- Zero behavior change in `imobiliariaBot.js`'s claim/authorization logic (Postgres auth, denylist, cache) — only the phone-resolution call site moves.
- Zero change to `src/lib/courier.js:325` (`processIncomingMessage`'s `fromMe` check) or `src/lib/inboundMedia.js` — PIX group flow is untouched.
- The HMAC-signed string for `salesLeadBot`'s text forwards must remain byte-identical to today: `JSON.stringify({ event, kind, from, messageId, ts, text })` — verified by an explicit test asserting the signed string, not just "request accepted."
- No secret or webhook URL hardcoded — `WAC_WEBHOOK_SECRET` and `WAC_SALES_LEAD_WEBHOOK_URL` come from `process.env` only (already the case; don't introduce a literal anywhere, including tests).
- No new dependency. No config.json. Env vars only, per existing module conventions.
- Comments and identifiers in English (repo convention, even on this branch).
- `npm run lint && npm test` must pass after every task that touches source.

---

### Task 1: `postJsonWithRetry` — optional `signedPayload` override

**Files:**
- Modify: `src/lib/webhook.js:15-18`
- Test: `test/webhook.test.js`

**Interfaces:**
- Produces: `postJsonWithRetry(url, body, { secret, signedPayload, timeoutMs, retryDelaysMs })` — when `signedPayload` (a string) is provided, the HMAC is computed over that string instead of `JSON.stringify(body)`; the request body sent over the wire is always `JSON.stringify(body)`, unaffected by `signedPayload`. When `signedPayload` is omitted, behavior is identical to today.

- [ ] **Step 1: Write the failing test**

Add to `test/webhook.test.js` (append after the existing `postJsonWithRetry omits the signature header without a secret` test):

```js
test('postJsonWithRetry signs an explicit signedPayload instead of the body', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = { headers: req.headers, body: raw }
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      await postJsonWithRetry(
        url,
        { a: 1, extra: 'not signed' },
        { secret: 'top-secret', retryDelaysMs: [], signedPayload: JSON.stringify({ a: 1 }) }
      )
    }
  )

  assert.equal(received.body, JSON.stringify({ a: 1, extra: 'not signed' }))
  const expected = `sha256=${signPayload('top-secret', JSON.stringify({ a: 1 }))}`
  assert.equal(received.headers['x-webhook-signature'], expected)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --test test/webhook.test.js`
Expected: FAIL — the sent signature is computed from the full body (`{a:1,extra:'not signed'}`), not from `signedPayload`, so `received.headers['x-webhook-signature']` won't equal `expected`.

- [ ] **Step 3: Implement `signedPayload`**

In `src/lib/webhook.js`, change the function signature and signing line:

```js
async function postJsonWithRetry(url, body, { secret, signedPayload, timeoutMs = 5000, retryDelaysMs = defaultRetryDelaysMs } = {}) {
  const payload = JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers['X-Webhook-Signature'] = `sha256=${signPayload(secret, signedPayload ?? payload)}`

  let lastError = null
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal })
      return
    } catch (error) {
      lastError = error
      if (attempt < retryDelaysMs.length) await sleep(retryDelaysMs[attempt])
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}
```

The wire body (`fetch`'s `body: payload`) always stays `JSON.stringify(body)` — only the signature source changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/webhook.test.js`
Expected: PASS, all tests in the file including the new one and the three pre-existing ones (regression check — omitting `signedPayload` must still sign the full body, exactly as today).

- [ ] **Step 5: Commit**

```bash
git add src/lib/webhook.js test/webhook.test.js
git commit -m "feat(webhook): support signing a payload subset distinct from the request body"
```

---

### Task 2: Extract `resolvePhone` into `identity.js`

**Files:**
- Modify: `src/lib/identity.js`
- Test: `test/identity.test.js`

**Interfaces:**
- Consumes: nothing new — `identity.js` already imports `isLidJid`, `normalizePnJid` from `./utils` and has its own `logger` require.
- Produces: `resolvePhone(socket, message)` — async, returns a plain-digit phone string or `null`. Exported from `src/lib/identity.js`.

- [ ] **Step 1: Write the failing tests**

Add to `test/identity.test.js` (new `require` at the top of the file, alongside the existing one — the file already imports named exports from `../src/lib/identity`, add `resolvePhone` to that destructure):

```js
const { resolveIdentityForGroup, disconnectReasonToText, resolvePhone } = require('../src/lib/identity')
```

Append these tests at the end of the file:

```js
test('resolvePhone resolves from a plain remoteJid', async () => {
  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net' } }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, '5511999998888')
})

test('resolvePhone falls back to key.senderPn when remoteJid is a @lid', async () => {
  const message = {
    key: {
      remoteJid: '156332632072321@lid',
      senderPn: '5511931507004@s.whatsapp.net'
    }
  }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, '5511931507004')
})

test('resolvePhone falls back to key.participantPn when senderPn is absent', async () => {
  const message = {
    key: {
      remoteJid: '156332632072321@lid',
      participantPn: '5511922223333@s.whatsapp.net'
    }
  }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, '5511922223333')
})

test('resolvePhone falls back to socket.signalRepository.lidMapping.getPNForLID for an unresolved @lid', async () => {
  const message = { key: { remoteJid: '156332632072321@lid' } }
  const socket = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => {
          assert.equal(lid, '156332632072321@lid')
          return '5511977776666@s.whatsapp.net'
        }
      }
    }
  }
  const phone = await resolvePhone(socket, message)
  assert.equal(phone, '5511977776666')
})

test('resolvePhone returns null when nothing resolves', async () => {
  const message = { key: { remoteJid: '156332632072321@lid' } }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, null)
})

test('resolvePhone returns null and does not throw when lidMapping.getPNForLID rejects', async () => {
  const message = { key: { remoteJid: '156332632072321@lid' } }
  const socket = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async () => {
          throw new Error('boom')
        }
      }
    }
  }
  const phone = await resolvePhone(socket, message)
  assert.equal(phone, null)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/identity.test.js`
Expected: FAIL — `resolvePhone` is not exported yet (`TypeError: resolvePhone is not a function`).

- [ ] **Step 3: Implement `resolvePhone` in `identity.js`**

Add this function to `src/lib/identity.js`, placed after `resolveLidForPn` (it uses the same `isLidJid`/`normalizePnJid`/`logger` already imported at the top of the file — no new imports needed):

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

Add `resolvePhone` to the `module.exports` object at the bottom of `src/lib/identity.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/identity.test.js`
Expected: PASS, all tests including the pre-existing ones (regression check).

- [ ] **Step 5: Commit**

```bash
git add src/lib/identity.js test/identity.test.js
git commit -m "feat(identity): add resolvePhone, extracted from imobiliariaBot"
```

---

### Task 3: `imobiliariaBot.js` — consume `identity.resolvePhone`

**Files:**
- Modify: `src/lib/imobiliariaBot.js:1-96` (imports and `resolvePhone` removal), `src/lib/imobiliariaBot.js:225` (call site)
- Test: `test/imobiliariaBot.test.js` (new file)

**Interfaces:**
- Consumes: `identity.resolvePhone(socket, message)` from Task 2, same signature and return type as the function being removed.

- [ ] **Step 1: Write the failing test**

Create `test/imobiliariaBot.test.js`:

```js
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

test('imobiliariaBot.handleIncomingDm returns false without throwing when the feature is disabled', async () => {
  delete process.env.WAC_IMOBILIARIA_WEBHOOK_URL
  delete process.env.WAC_IMOBILIARIA_PG_URL
  const imobiliariaBot = require('../src/lib/imobiliariaBot')

  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'ABC123' } }
  const claimed = await imobiliariaBot.handleIncomingDm({ socket: {} }, message)
  assert.equal(claimed, false)
})

test('imobiliariaBot.handleIncomingDm returns false for a fromMe message without touching resolvePhone', async () => {
  process.env.WAC_IMOBILIARIA_WEBHOOK_URL = 'http://example.invalid/webhook'
  process.env.WAC_IMOBILIARIA_PG_URL = 'postgres://example.invalid/db'
  delete require.cache[require.resolve('../src/lib/imobiliariaBot')]
  const imobiliariaBot = require('../src/lib/imobiliariaBot')

  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'ABC123', fromMe: true } }
  const claimed = await imobiliariaBot.handleIncomingDm({ socket: {} }, message)
  assert.equal(claimed, false)

  delete process.env.WAC_IMOBILIARIA_WEBHOOK_URL
  delete process.env.WAC_IMOBILIARIA_PG_URL
  delete require.cache[require.resolve('../src/lib/imobiliariaBot')]
})
```

This is a deliberately narrow regression test: it exercises the two early-return paths (`isEnabled()` false, then `fromMe` true) that sit before `resolvePhone` is ever called, confirming the refactor didn't disturb the module's control flow or its ability to load. Deeper Postgres-auth behavior stays untested, per the module's pre-existing (and unchanged) test posture — this task only moves a phone-resolution call site, it doesn't newly cover Postgres integration.

- [ ] **Step 2: Run test to verify it passes against the current code first**

Run: `npx node --test test/imobiliariaBot.test.js`
Expected: PASS already (this test doesn't touch the code being changed in this task — it's here to catch a regression from the edit in Step 3, run it now to confirm the baseline is green before editing).

- [ ] **Step 3: Update `imobiliariaBot.js` to use `identity.resolvePhone`**

In `src/lib/imobiliariaBot.js`:

Change the import line (was `const { isLidJid, normalizePnJid, mediaMaxBytes } = require('./utils')`):

```js
const identity = require('./identity')
const { mediaMaxBytes } = require('./utils')
```

Delete the entire `resolvePhone` function (current lines 63-96, including its doc comment block on lines 56-62).

Change the call site (current line 225) from:

```js
const phone = await resolvePhone(socket, message)
```

to:

```js
const phone = await identity.resolvePhone(socket, message)
```

No other line in the file changes.

- [ ] **Step 4: Run tests to verify nothing broke**

Run: `npx node --test test/imobiliariaBot.test.js test/identity.test.js`
Expected: PASS, all tests.

Run: `npm run lint`
Expected: clean — confirms the removed `isLidJid`/`normalizePnJid` imports don't leave an unused-import warning and there's no leftover reference to the deleted local `resolvePhone`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/imobiliariaBot.js test/imobiliariaBot.test.js
git commit -m "refactor(imobiliaria-dm-bot): consume identity.resolvePhone instead of a local copy"
```

---

### Task 4: `salesLeadBot.js` — `fromPn`, outbound forwarding

**Files:**
- Modify: `src/lib/salesLeadBot.js` (whole file restructure of `forwardText`, `forwardMedia`, `handleIncomingDm`)
- Test: `test/salesLeadBot.test.js` (new file)

**Interfaces:**
- Consumes: `identity.resolvePhone(socket, message)` (Task 2), `postJsonWithRetry(url, body, { secret, signedPayload, ... })` (Task 1).
- Produces: no new exports beyond the existing `{ isEnabled, handleIncomingDm }` — this task only changes `handleIncomingDm`'s internal behavior and the two forward helpers' payload shape.

- [ ] **Step 1: Write the failing tests**

Create `test/salesLeadBot.test.js`:

```js
'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { signPayload } = require('../src/lib/webhook')

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function loadSalesLeadBot(webhookUrl, secret) {
  process.env.WAC_SALES_LEAD_WEBHOOK_URL = webhookUrl
  if (secret) process.env.WAC_WEBHOOK_SECRET = secret
  else delete process.env.WAC_WEBHOOK_SECRET
  delete require.cache[require.resolve('../src/lib/salesLeadBot')]
  return require('../src/lib/salesLeadBot')
}

function resetEnv() {
  delete process.env.WAC_SALES_LEAD_WEBHOOK_URL
  delete process.env.WAC_WEBHOOK_SECRET
  delete require.cache[require.resolve('../src/lib/salesLeadBot')]
}

test('handleIncomingDm forwards inbound text with fromPn resolved via key.senderPn, signature over the original 6-field shape', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = { headers: req.headers, body: JSON.parse(raw) }
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url, 'top-secret')
      const message = {
        key: {
          remoteJid: '156332632072321@lid',
          senderPn: '5511931507004@s.whatsapp.net',
          id: 'MSG1'
        },
        message: { conversation: 'oi, quero saber mais' }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(received.body.from, '156332632072321@lid')
  assert.equal(received.body.fromPn, '5511931507004')
  assert.equal(received.body.direction, 'inbound')

  const signedPayload = JSON.stringify({
    event: received.body.event,
    kind: received.body.kind,
    from: received.body.from,
    messageId: received.body.messageId,
    ts: received.body.ts,
    text: received.body.text
  })
  const expected = `sha256=${signPayload('top-secret', signedPayload)}`
  assert.equal(received.headers['x-webhook-signature'], expected)

  resetEnv()
})

test('handleIncomingDm forwards inbound text with fromPn null when resolution fails, never dropping the message', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = JSON.parse(raw)
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url)
      const message = {
        key: { remoteJid: '156332632072321@lid', id: 'MSG2' },
        message: { conversation: 'oi' }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(received.from, '156332632072321@lid')
  assert.equal(received.fromPn, null)
  assert.equal(received.direction, 'inbound')

  resetEnv()
})

test('handleIncomingDm forwards a fromMe reply as outbound text', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = JSON.parse(raw)
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url)
      const message = {
        key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'MSG3', fromMe: true },
        message: { conversation: 'ja te respondo' }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(received.direction, 'outbound')
  assert.equal(received.text, 'ja te respondo')
  assert.equal(received.from, '5511999998888@s.whatsapp.net')

  resetEnv()
})

test('handleIncomingDm logs and drops fromMe media without forwarding', async (t) => {
  let requestCount = 0
  await withServer(
    (req, res) => {
      requestCount += 1
      res.writeHead(200)
      res.end()
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url)
      const message = {
        key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'MSG4', fromMe: true },
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 100 } }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(requestCount, 0)
  resetEnv()
})

test('handleIncomingDm never throws when disabled', async () => {
  resetEnv()
  const salesLeadBot = require('../src/lib/salesLeadBot')
  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'MSG5' } }
  await assert.doesNotReject(salesLeadBot.handleIncomingDm({ socket: {} }, message))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test test/salesLeadBot.test.js`
Expected: FAIL — `received.body.fromPn`/`received.direction` are `undefined` (field doesn't exist yet), and the `fromMe` tests fail because `handleIncomingDm` currently returns immediately on `fromMe: true` without forwarding anything (`received` stays `null`, `requestCount` stays `0` for the media test only by coincidence — the text outbound test will fail with `received` still `null`, i.e. a `TypeError` reading `.direction` off `null`).

- [ ] **Step 3: Rewrite `salesLeadBot.js`**

Replace the full contents of `src/lib/salesLeadBot.js` with:

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
const identity = require('./identity')
const { signPayload, postJsonWithRetry } = require('./webhook')
const { mediaMaxBytes } = require('./utils')
const { extractContent } = require('./inboundContent')

const webhookUrl = process.env.WAC_SALES_LEAD_WEBHOOK_URL || null

function isEnabled() {
  return Boolean(webhookUrl)
}

// fromPn and direction are additive fields the n8n side doesn't need to validate the
// signature: the signed string stays the original 6-field shape so the existing
// "Montar Payload Canonico" n8n node keeps working unmodified.
async function forwardText({ from, fromPn, direction, messageId, ts, text }) {
  const body = { event: 'sales_lead.message', kind: 'text', from, fromPn, direction, messageId, ts, text }
  const signedPayload = JSON.stringify({ event: body.event, kind: body.kind, from, messageId, ts, text })
  return postJsonWithRetry(webhookUrl, body, {
    secret: process.env.WAC_WEBHOOK_SECRET || undefined,
    signedPayload
  })
}

async function forwardMedia({ buffer, media, from, fromPn, messageId, ts }) {
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
  form.append('fromPn', fromPn || '')
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
    const outbound = Boolean(message?.key?.fromMe)
    const direction = outbound ? 'outbound' : 'inbound'

    const socket = courier.socket
    if (!socket) return

    const content = extractContent(message)
    if (!content) {
      logger.debug({ remoteJid, messageId: message?.key?.id || null }, 'sales-lead: unsupported content; ignoring')
      return
    }

    const messageId = message.key.id || null
    const ts = new Date().toISOString()

    if (content.kind !== 'text') {
      if (outbound) {
        logger.info({ remoteJid, messageId, type: content.type }, 'sales-lead: outbound media from agent; not forwarded')
        return
      }
    } else {
      const fromPn = await identity.resolvePhone(socket, message)
      await forwardText({ from: remoteJid, fromPn, direction, messageId, ts, text: content.text })
      logger.info({ remoteJid, messageId, direction }, 'sales-lead: text forwarded')
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

    const fromPn = await identity.resolvePhone(socket, message)
    const ok = await forwardMedia({ buffer, media: content, from: remoteJid, fromPn, messageId, ts })
    if (ok) logger.info({ remoteJid, messageId, type: content.type }, 'sales-lead: media forwarded')
    else logger.warn({ remoteJid, messageId }, 'sales-lead: webhook responded non-2xx')
  } catch (error) {
    logger.error({ error: error?.message }, 'sales-lead: unexpected failure handling dm')
  }
}

module.exports = { isEnabled, handleIncomingDm }
```

Note the control flow: `content.kind !== 'text'` groups the two media branches (outbound-drop and inbound-forward) so the outbound early-return for media happens before any download attempt; text stays as a single branch identical in shape to before, with `fromPn`/`direction` added and an early `return` after forwarding, same as the original.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test test/salesLeadBot.test.js`
Expected: PASS, all five tests.

- [ ] **Step 5: Run the full suite and lint**

Run: `npm run lint && npm test`
Expected: PASS — zero regressions across the whole repo, including `test/webhook.test.js`, `test/identity.test.js`, `test/imobiliariaBot.test.js` from Tasks 1-3.

- [ ] **Step 6: Commit**

```bash
git add src/lib/salesLeadBot.js test/salesLeadBot.test.js
git commit -m "feat(sales-lead-dm-bot): resolve real phone number and forward human-agent replies"
```

---

### Task 5: Final verification against the spec's checklist

**Files:** none modified — this task is verification and reporting only.

- [ ] **Step 1: Run the full test suite and lint one more time**

Run: `npm run lint && npm test`
Expected: PASS, zero failures, zero lint findings.

- [ ] **Step 2: Confirm the six-item checklist from the spec, one by one**

Report each item's status explicitly, backed by what was verified in Tasks 1-4 (no new manual/live testing against a real WhatsApp account is in scope — these are code-level confirmations):

1. **PIX group image/document still triggers the PIX webhook unchanged.** Confirmed by inspection: no line in `src/lib/inboundMedia.js` or `src/lib/courier.js:processIncomingMessage` (courier.js:323 onward) was touched by any task in this plan. `git diff main -- src/lib/inboundMedia.js src/lib/courier.js` (or `git show` on each commit from this plan) must show no changes to those two areas — run it and confirm empty.
2. **Registered broker's DM still claimed by `imobiliariaBot`, not falling through to sales catchall.** Confirmed by `test/imobiliariaBot.test.js` (Task 3) exercising the module's early-return paths post-refactor, and by `identity.test.js`'s `resolvePhone` tests (Task 2) confirming the extracted function's behavior is unchanged from the original. The `courier.js:312-313` claim chain itself was not touched by any task.
3. **Unregistered `@lid`-addressed DM text arrives at the lead webhook with `fromPn` resolved via `key.senderPn`.** Confirmed by `test/salesLeadBot.test.js`'s first test (Task 4, Step 1) — asserts `received.body.fromPn === '5511931507004'` when `remoteJid` is a `@lid` and `key.senderPn` carries the phone.
4. **HMAC signature for text and media payloads unchanged from today.** Confirmed by `test/salesLeadBot.test.js`'s first test explicitly reconstructing the exact 6-field signed string and asserting it matches the sent `X-Webhook-Signature` header; media's signed string was not changed by this plan (`forwardMedia`'s manual string-building is untouched aside from adding the unsigned `fromPn` form field). No n8n-side node needs to change.
5. **Reply sent from the paired phone arrives at the webhook marked outbound.** Confirmed by `test/salesLeadBot.test.js`'s `handleIncomingDm forwards a fromMe reply as outbound text` test (Task 4).
6. **wa-courier's own send (`POST /messages/text`) never arrives at the webhook as outbound.** Confirmed structurally, not by a runtime test: `baileys@6.7.24`'s `messages.upsert` (the only entry point into `handleIncomingMessages` → `salesLeadBot.handleIncomingDm`) is emitted exclusively from `Socket/messages-recv.js`, driven by stanzas received over the WebSocket; `Socket/messages-send.js` (home of `sendMessage`) never emits it. There is no code path for a self-send to re-enter this flow, so no filtering mechanism was needed or added — this is documented in the spec's Part B and restated here for the record.

- [ ] **Step 3: Report**

Summarize, in the final message to the user: commits made (list `git log --oneline` for this branch since Task 1's first commit), confirmation that all six checklist items pass, and the explicit callout that **no n8n workflow changes are required** — the signed string for both text and media forwards is byte-identical to before this work.
