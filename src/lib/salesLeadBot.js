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
        logger.info(
          { remoteJid, messageId, type: content.type },
          'sales-lead: outbound media from agent; not forwarded'
        )
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
