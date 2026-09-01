'use strict'

// EXPERIMENTAL — local/imobiliaria-dm-bot branch only, never merged to main.
//
// DM intake channel for the real-estate CRM bot: authorized brokers send text, audio,
// images and documents to this gateway's number via direct message, and everything is
// forwarded to a single CRM webhook. Authorization lives in an external Postgres
// (fn_checar_autorizacao / corretor.status = 'ativo') — a deliberate, isolated break
// from the project's "zero external services" rule, which is why this module must stay
// out of main. The PIX group flow (inboundMedia.js / courier.processIncomingMessage)
// is untouched: DMs were always ignored there, so routing them here changes nothing.

const { downloadMediaMessage } = require('baileys')

const logger = require('./logger')
const { signPayload, postJsonWithRetry } = require('./webhook')
const { extractContent, isDmJid } = require('./inboundContent')
const { isLidJid, normalizePnJid, mediaMaxBytes } = require('./utils')

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

const AUTH_TTL_MS = 24 * 60 * 60 * 1000 // daily re-check, per spec

// phone -> { authorized, tipo, checkedAt } — survives for the process lifetime only
const authCache = new Map()

let pool = null

// the feature only exists when both ends are configured; a plain PIX deployment that
// doesn't set these env vars must boot and run exactly as before
function isEnabled() {
  return Boolean(webhookUrl && pgUrl)
}

// lazy: no connection attempt at boot, only on the first DM that needs an auth check
function getPool() {
  if (!pool) {
    // required lazily too, so the dependency is never touched when the feature is off
    const { Pool } = require('pg')
    pool = new Pool({ connectionString: pgUrl, max: 2, idleTimeoutMillis: 30_000 })
    pool.on('error', (error) => logger.error({ error: error?.message }, 'imobiliaria pg pool error'))
  }
  return pool
}

// The auth table stores plain phone numbers, and the cache must not split one broker
// into two entries depending on which addressing form (PN or LID) WhatsApp used for a
// given message — so everything is keyed by the PN-derived phone number.
// When the DM arrives addressed by LID (contact has number-privacy enabled), Baileys
// already ships the phone-number JID alongside it in key.senderPn (decoded straight from
// the stanza's sender_pn attribute) — read that first instead of relying on the local
// signal store mapping, which is empty for contacts we've never stored a session for.
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
      logger.debug({ error: error?.message, remoteJid }, 'imobiliaria lid->pn resolution failed')
    }
  }

  logger.debug(
    { remoteJid, senderPn: key.senderPn || null, participantPn: key.participantPn || null, resolved: pnJid, source },
    'imobiliaria: phone resolution'
  )

  if (!pnJid) return null
  const phone = pnJid.split('@')[0]
  return /^\d+$/.test(phone) ? phone : null
}

// fn_checar_autorizacao now also distinguishes 'corretor' from 'cliente' via row.tipo —
// wa-courier only carries it along, never branches on it (authorization/business logic is
// n8n/CRM's job; this stays plain transport). Doesn't touch row.role (corretor.role, a
// separate corretor-only field) or row.cliente_id — the n8n side re-derives whatever it
// needs by calling the same function with the phone, never trusting what the gateway forwarded.
function readAuthResult(rows) {
  if (!rows || rows.length === 0) return { authorized: false, tipo: null }
  const row = rows[0]
  const authorized = typeof row.autorizado === 'boolean' ? row.autorizado : true
  const tipo = row.tipo || null
  return { authorized, tipo }
}

// TTL cache with stale fallback: a broker the gateway has already seen keeps working
// through a Postgres outage (stale entry reused, warn logged); a number never seen
// before is denied while the database is unreachable (fail-closed) — never authorize
// an unknown sender just because the auth backend is down.
async function checkAuth(phone) {
  const cached = authCache.get(phone)
  const now = Date.now()

  if (cached && now - cached.checkedAt < AUTH_TTL_MS) {
    logger.debug(
      { phone, authorized: cached.authorized, tipo: cached.tipo, cacheAgeMs: now - cached.checkedAt },
      'imobiliaria: auth served from cache'
    )
    return { authorized: cached.authorized, tipo: cached.tipo }
  }

  try {
    const { rows } = await getPool().query('select * from fn_checar_autorizacao($1)', [phone])
    const { authorized, tipo } = readAuthResult(rows)
    logger.debug(
      { phone, authorized, tipo, rowCount: rows.length, firstRow: rows[0] || null },
      'imobiliaria: auth from pg'
    )
    authCache.set(phone, { authorized, tipo, checkedAt: now })
    return { authorized, tipo }
  } catch (error) {
    if (cached) {
      logger.warn({ error: error?.message, phone }, 'imobiliaria auth check failed; serving stale cache')
      return { authorized: cached.authorized, tipo: cached.tipo }
    }
    logger.warn({ error: error?.message, phone }, 'imobiliaria auth check failed for unknown sender; denying')
    return { authorized: false, tipo: null }
  }
}

async function forwardText({ contactJid, phone, messageId, ts, text, tipo }) {
  // postJsonWithRetry signs the JSON body with X-Webhook-Signature on its own. tipo stays the
  // last field on purpose — the n8n side reconstructs this exact object shape/order to validate
  // the signature, so field order here is a real contract, not cosmetic.
  return postJsonWithRetry(
    webhookUrl,
    { event: 'imobiliaria.message', kind: 'text', contactJid, phone, messageId, ts, text, tipo },
    { secret: process.env.WAC_WEBHOOK_SECRET || undefined }
  )
}

async function forwardMedia({ buffer, media, contactJid, phone, messageId, ts, tipo }) {
  const headers = {}
  const secret = process.env.WAC_WEBHOOK_SECRET
  if (secret) {
    const signature = signPayload(
      secret,
      `${messageId || ''}.${ts}.${contactJid}.${phone}.${media.fileName}.${media.mimetype}`
    )
    headers['X-Webhook-Signature'] = `sha256=${signature}`
  }

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: media.mimetype }), media.fileName)
  form.append('event', 'imobiliaria.message')
  form.append('kind', 'media')
  form.append('contactJid', contactJid)
  form.append('phone', phone)
  form.append('type', media.type)
  form.append('ptt', String(media.ptt))
  form.append('fileName', media.fileName)
  form.append('mimetype', media.mimetype)
  form.append('caption', media.caption || '')
  form.append('messageId', messageId || '')
  form.append('ts', ts)
  form.append('tipo', tipo || '')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const res = await fetch(webhookUrl, { method: 'POST', headers, body: form, signal: controller.signal })
    return res.ok
  } finally {
    clearTimeout(timeout)
  }
}

// Entry point, called from courier.handleIncomingMessages for every non-group message.
// Never throws: this experimental path must not be able to break message processing.
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
      try {
        await forwardText({ contactJid: remoteJid, phone, messageId, ts, text: content.text, tipo })
        logger.info({ phone, messageId }, 'imobiliaria: text forwarded')
      } catch (error) {
        logger.error({ error: error?.message, phone, messageId }, 'imobiliaria: text forward failed')
      }
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

    try {
      const ok = await forwardMedia({ buffer, media: content, contactJid: remoteJid, phone, messageId, ts, tipo })
      if (ok) logger.info({ phone, messageId, type: content.type }, 'imobiliaria: media forwarded')
      else logger.warn({ phone, messageId }, 'imobiliaria: webhook responded non-2xx')
    } catch (error) {
      logger.error({ error: error?.message, phone, messageId }, 'imobiliaria: media forward failed')
    }
    return true
  } catch (error) {
    logger.error({ error: error?.message }, 'imobiliaria: unexpected failure handling dm')
    return false
  }
}

module.exports = { isEnabled, handleIncomingDm }
