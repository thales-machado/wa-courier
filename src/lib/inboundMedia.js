'use strict'

const { signPayload, defaultRetryDelaysMs } = require('./webhook')
const { sleep } = require('./utils')

// size declared by the sender in the message metadata (protobuf Long or number) — lets the
// caller skip the download for something too large before spending bandwidth on it
function normalizeDeclaredSize(raw) {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'number') return raw
  if (typeof raw.toNumber === 'function') return raw.toNumber()
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

// only images and documents are supported — video/audio make no sense for document indexing
function extractInboundMedia(message) {
  const content = message?.message
  if (!content) return null

  const documentMessage = content.documentMessage || content.documentWithCaptionMessage?.message?.documentMessage
  if (documentMessage) {
    return {
      type: 'document',
      mimetype: documentMessage.mimetype || 'application/octet-stream',
      fileName: documentMessage.fileName || 'document',
      caption: documentMessage.caption || null,
      declaredSize: normalizeDeclaredSize(documentMessage.fileLength)
    }
  }

  const imageMessage = content.imageMessage
  if (imageMessage) {
    const ext = (imageMessage.mimetype || 'image/jpeg').split('/')[1] || 'jpg'
    return {
      type: 'image',
      mimetype: imageMessage.mimetype || 'image/jpeg',
      fileName: `image.${ext}`,
      caption: imageMessage.caption || null,
      declaredSize: normalizeDeclaredSize(imageMessage.fileLength)
    }
  }

  return null
}

function buildInboundMediaForm({ buffer, media, groupJid, sender, messageId, ts }) {
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: media.mimetype }), media.fileName)
  form.append('groupJid', groupJid)
  form.append('sender', sender || '')
  form.append('type', media.type)
  form.append('fileName', media.fileName)
  form.append('mimetype', media.mimetype)
  form.append('caption', media.caption || '')
  form.append('messageId', messageId || '')
  form.append('ts', ts)
  return form
}

// forwards the downloaded file to the configured webhook via multipart/form-data, with optional
// HMAC signature and a short retry on network failure. The signature travels in the
// X-Webhook-Signature header (same name/format as the status webhook in ./webhook.js), not in
// the multipart body: a header lets the receiver verify and reject *before* parsing the body —
// which for this endpoint means before buffering the file — matching how GitHub/Stripe-style
// webhook signing works. The whole multipart body still can't be signed deterministically
// because of the random boundary, so the signed payload is the metadata identifying the file.
async function forwardInboundMedia(
  webhookUrl,
  params,
  { secret, timeoutMs = 15_000, retryDelaysMs = defaultRetryDelaysMs } = {}
) {
  const { media, groupJid, sender, messageId, ts } = params
  const headers = {}
  if (secret) {
    const signature = signPayload(
      secret,
      `${messageId || ''}.${ts}.${groupJid}.${sender || ''}.${media.fileName}.${media.mimetype}`
    )
    headers['X-Webhook-Signature'] = `sha256=${signature}`
  }

  let lastError = null
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const form = buildInboundMediaForm(params)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(webhookUrl, { method: 'POST', headers, body: form, signal: controller.signal })
      return res.ok // response received (2xx or not): don't insist, the server already answered
    } catch (error) {
      lastError = error
      if (attempt < retryDelaysMs.length) await sleep(retryDelaysMs[attempt])
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}

module.exports = { extractInboundMedia, forwardInboundMedia }
