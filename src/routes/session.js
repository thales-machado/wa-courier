'use strict'

const QRCode = require('qrcode')
const logger = require('../lib/logger')
const { sendErrorReply } = require('../lib/errors')

async function sessionRoutes(app, { courier, accessControl }) {
  app.get('/session', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    return courier.getSessionState()
  })

  // session state + rendered QR (consumed by the UI)
  app.get('/session/qr-data', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return

    try {
      await courier.connect()
      const state = courier.getSessionState()
      const qr = courier.getLatestQr()
      const qrImage = qr ? await QRCode.toDataURL(qr) : null
      return { ...state, qrImage }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'qr_failed'
      return reply.code(500).send({ error: 'qr_failed', message })
    }
  })

  app.post('/session/logout', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    logger.warn('Session logout requested via API')
    return courier.logout()
  })

  app.get('/me', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return

    try {
      return await courier.getMe()
    } catch (error) {
      return sendErrorReply(reply, error, 'me_failed')
    }
  })
}

module.exports = sessionRoutes
