'use strict'

const logger = require('./logger')

const badRequestCodes = new Set([
  'invalid_group_jid',
  'empty_text',
  'invalid_number',
  'invalid_target',
  'number_not_on_whatsapp',
  'missing_media',
  'invalid_media_type',
  'missing_file_name',
  'invalid_mimetype',
  'invalid_media_base64',
  'invalid_media_url',
  'media_url_blocked',
  'media_url_unresolvable',
  'media_url_unreachable',
  'media_url_too_many_redirects'
])

// maps a thrown Error's message to an HTTP response. The full detail always goes to the
// server log; for unmapped (likely internal/library) errors the client only gets a generic
// message so internal error text never leaks over the API — see fallback branch below
function sendErrorReply(reply, error, fallback) {
  const message = error instanceof Error ? error.message : fallback
  logger.error({ error: message }, `Request failed: ${fallback}`)

  if (message === 'session_not_paired' || message === 'session_not_connected') {
    return reply.code(409).send({
      error: message,
      message: 'Session is not connected. Pair or reconnect first.'
    })
  }

  if (message === 'queue_full') {
    return reply.code(503).send({
      error: message,
      message: 'Send queue is at capacity. Retry shortly.'
    })
  }

  if (message === 'media_too_large') {
    return reply.code(413).send({ error: message })
  }

  if (badRequestCodes.has(message)) {
    return reply.code(400).send({ error: message })
  }

  return reply.code(500).send({ error: fallback, message: 'Internal error. Check server logs for details.' })
}

module.exports = { sendErrorReply }
