'use strict'

const { sendErrorReply } = require('../lib/errors')

async function directoryRoutes(app, { courier, accessControl }) {
  app.get('/contacts/resolve', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return

    try {
      return await courier.resolveNumber(request.query?.number)
    } catch (error) {
      return sendErrorReply(reply, error, 'resolve_failed')
    }
  })

  app.get('/groups', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return

    try {
      const name = request.query?.name
      const includeParticipants = String(request.query?.participants || 'false') === 'true'
      const includeRaw = String(request.query?.raw || 'false') === 'true'

      const groups = await courier.listGroups(name, includeParticipants, includeRaw)
      return { groups }
    } catch (error) {
      return sendErrorReply(reply, error, 'groups_failed')
    }
  })

  app.get('/group/:jid', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return

    try {
      const groupJid = request.params?.jid
      const meta = await courier.getGroupMetadata(groupJid)
      return meta
    } catch (error) {
      return sendErrorReply(reply, error, 'group_failed')
    }
  })
}

module.exports = directoryRoutes
