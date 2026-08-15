'use strict'

const { isRateLimited, rateLimitMax } = require('../lib/utils')
const { sendErrorReply } = require('../lib/errors')

const groupTextSchema = {
  body: {
    type: 'object',
    required: ['groupJid', 'text'],
    properties: {
      groupJid: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 }
    }
  }
}

const directTextSchema = {
  body: {
    type: 'object',
    required: ['to', 'text'],
    properties: {
      to: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 }
    }
  }
}

const imageSchema = {
  body: {
    type: 'object',
    required: ['to'],
    properties: {
      to: { type: 'string', minLength: 1 },
      imageUrl: { type: 'string', minLength: 1 },
      imageBase64: { type: 'string', minLength: 1 },
      caption: { type: 'string' },
      mimetype: { type: 'string' }
    }
  }
}

const mediaSchema = {
  body: {
    type: 'object',
    required: ['to', 'type'],
    properties: {
      to: { type: 'string', minLength: 1 },
      type: { type: 'string', enum: ['image', 'video', 'audio', 'document'] },
      mediaUrl: { type: 'string', minLength: 1 },
      mediaBase64: { type: 'string', minLength: 1 },
      caption: { type: 'string' },
      mimetype: { type: 'string' },
      fileName: { type: 'string' },
      ptt: { type: 'boolean' }
    }
  }
}

async function messagesRoutes(app, { courier, accessControl }) {
  async function requireSendAllowed(request, reply) {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    if (isRateLimited(request.ip)) {
      reply.code(429).send({ error: 'rate_limited', message: `Max ${rateLimitMax} sends per minute` })
    }
  }

  app.post('/messages/group/text', { schema: groupTextSchema }, async (request, reply) => {
    await requireSendAllowed(request, reply)
    if (reply.sent) return

    const { groupJid, text } = request.body

    try {
      const result = await courier.sendGroupText(groupJid, text)
      return reply.code(202).send(result)
    } catch (error) {
      return sendErrorReply(reply, error, 'send_failed')
    }
  })

  app.post('/messages/text', { schema: directTextSchema }, async (request, reply) => {
    await requireSendAllowed(request, reply)
    if (reply.sent) return

    const { to, text } = request.body

    try {
      const result = await courier.sendDirectText(to, text)
      return reply.code(202).send(result)
    } catch (error) {
      return sendErrorReply(reply, error, 'send_failed')
    }
  })

  app.post('/messages/image', { schema: imageSchema }, async (request, reply) => {
    await requireSendAllowed(request, reply)
    if (reply.sent) return

    const { to, imageUrl, imageBase64, caption, mimetype } = request.body
    if (!imageUrl && !imageBase64) {
      return reply.code(400).send({
        error: 'invalid_payload',
        message: 'imageUrl or imageBase64 is required'
      })
    }

    try {
      const result = await courier.sendMedia(to, {
        type: 'image',
        mediaUrl: imageUrl,
        mediaBase64: imageBase64,
        caption,
        mimetype
      })
      return reply.code(202).send(result)
    } catch (error) {
      return sendErrorReply(reply, error, 'send_failed')
    }
  })

  // generic endpoint: image, video, audio or document
  app.post('/messages/media', { schema: mediaSchema }, async (request, reply) => {
    await requireSendAllowed(request, reply)
    if (reply.sent) return

    const { to, type, mediaUrl, mediaBase64, caption, mimetype, fileName, ptt } = request.body
    if (!mediaUrl && !mediaBase64) {
      return reply.code(400).send({
        error: 'invalid_payload',
        message: 'mediaUrl or mediaBase64 is required'
      })
    }

    try {
      const result = await courier.sendMedia(to, { type, mediaUrl, mediaBase64, caption, mimetype, fileName, ptt })
      return reply.code(202).send(result)
    } catch (error) {
      return sendErrorReply(reply, error, 'send_failed')
    }
  })

  app.get('/messages/recent', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    return { messages: courier.sentLog }
  })
}

module.exports = messagesRoutes
