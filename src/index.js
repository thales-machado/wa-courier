'use strict'

const Fastify = require('fastify')

const config = require('./config')
const logger = require('./lib/logger')
const { Courier, mediaMaxBytes } = require('./lib/courier')
const { createAccessControl } = require('./lib/accessControl')
const { registerSecurityHeaders } = require('./lib/securityHeaders')
const { buildIpAllowList, isIpAllowed } = require('./lib/utils')

const uiRoutes = require('./routes/ui')
const authRoutes = require('./routes/auth')
const sessionRoutes = require('./routes/session')
const messagesRoutes = require('./routes/messages')
const directoryRoutes = require('./routes/directory')
const inboundMediaRoutes = require('./routes/inboundMedia')
const monitoringRoutes = require('./routes/monitoring')

const courier = new Courier()
const accessControl = createAccessControl(courier)

// derived from the media ceiling rather than fixed, so WAC_MEDIA_MAX_BYTES means the same
// thing whichever way you send: base64 inflates the file by 4/3 inside a JSON body, and a
// hardcoded limit made the base64 path cut off well below the configured size — with a
// generic Fastify 413 instead of the app's own media_too_large
const bodyLimit = Math.ceil(mediaMaxBytes * (4 / 3)) + 1024 * 1024
const app = Fastify({ logger: false, bodyLimit })

registerSecurityHeaders(app)

// optional extra layer on top of the API key: when configured, restricts every route (including
// health/metrics) to known IPs/CIDRs — a config error (invalid CIDR) crashes the boot on purpose,
// better to not start with a broken allowlist than to start with no restriction at all
if (config.allowedCidrs.length) {
  const ipAllowList = buildIpAllowList(config.allowedCidrs)
  app.addHook('onRequest', async (request, reply) => {
    if (!isIpAllowed(ipAllowList, request.ip)) {
      reply.code(403).send({ error: 'ip_not_allowed' })
    }
  })
  logger.info({ cidrs: config.allowedCidrs }, 'IP allowlist enabled')
}

const routeOpts = { courier, accessControl }
app.register(uiRoutes, routeOpts)
app.register(authRoutes, routeOpts)
app.register(sessionRoutes, routeOpts)
app.register(messagesRoutes, routeOpts)
app.register(directoryRoutes, routeOpts)
app.register(inboundMediaRoutes, routeOpts)
app.register(monitoringRoutes, routeOpts)

async function start() {
  await courier.initialize()
  accessControl.setWebSecret(await courier.ensureWebSecret())
  if (!config.apiKey) {
    logger.warn('WAC_API_KEY is not set — the HTTP API is closed until you configure it')
  }
  await app.listen({ host: '0.0.0.0', port: config.port })
  logger.info({ port: config.port }, 'wa-courier listening')
}

let shuttingDown = false
async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  logger.warn({ signal }, 'Shutting down wa-courier')

  courier.clearReconnectTimer()

  // let queued sends finish before tearing the socket down — with 202 responses the caller
  // already considers them accepted, so dropping them here would lose messages silently
  if (courier.sendQueue.pending > 0 || courier.sendQueue.processing) {
    logger.warn({ pending: courier.sendQueue.pending }, 'Draining send queue before shutdown')
    const drained = await courier.sendQueue.drain(config.shutdownDrainTimeoutMs)
    if (!drained) {
      logger.error({ pending: courier.sendQueue.pending }, 'Send queue did not drain in time; dropping remainder')
    }
  }

  try {
    courier.socket?.end?.()
  } catch (error) {
    logger.error({ error }, 'Error closing session socket')
  }

  try {
    await app.close()
  } catch (error) {
    logger.error({ error }, 'Error closing HTTP server')
  }

  process.exit(0)
}

process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))

start().catch((error) => {
  logger.error({ error }, 'Failed to start wa-courier')
  process.exit(1)
})
