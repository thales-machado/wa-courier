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
