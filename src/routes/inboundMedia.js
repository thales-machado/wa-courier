'use strict'

const config = require('../config')
const { sendErrorReply } = require('../lib/errors')

const inboundGroupSchema = {
  body: {
    type: 'object',
    required: ['groupJid'],
    properties: {
      groupJid: { type: 'string', minLength: 1 }
    }
  }
}

// ---- inbound media (group -> webhook) ----
async function inboundMediaRoutes(app, { courier, accessControl }) {
  app.get('/inbound-media/groups', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    return { groups: courier.getInboundMediaGroups(), webhookConfigured: Boolean(config.inboundMediaWebhookUrl) }
  })

  app.post('/inbound-media/groups', { schema: inboundGroupSchema }, async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return

    try {
      const groups = await courier.addInboundMediaGroup(request.body.groupJid)
      return { groups }
    } catch (error) {
      return sendErrorReply(reply, error, 'add_group_failed')
    }
  })

  app.delete('/inbound-media/groups/:jid', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    const groups = await courier.removeInboundMediaGroup(request.params?.jid)
    return { groups }
  })

  app.get('/inbound-media/recent', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    return { messages: courier.receivedLog }
  })
}

module.exports = inboundMediaRoutes
