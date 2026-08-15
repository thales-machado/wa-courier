'use strict'

const { signSessionToken, isLoginRateLimited, loginRateLimitMax } = require('../lib/utils')
const config = require('../config')

const loginSchema = {
  body: {
    type: 'object',
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 1 },
      password: { type: 'string', minLength: 1 }
    }
  }
}

async function authRoutes(app, { courier, accessControl }) {
  app.post('/auth/login', { schema: loginSchema }, async (request, reply) => {
    if (!courier.isWebLoginConfigured()) {
      return reply.code(503).send({
        error: 'web_login_not_configured',
        message: 'Set WAC_WEB_USER and WAC_WEB_PASS environment variables to enable web login'
      })
    }

    // separate, stricter budget from the send-endpoint limiter — this guards against
    // brute-forcing WAC_WEB_PASS, not against message volume
    if (isLoginRateLimited(request.ip)) {
      return reply.code(429).send({
        error: 'rate_limited',
        message: `Too many login attempts. Max ${loginRateLimitMax} per 5 minutes.`
      })
    }

    const { username, password } = request.body || {}

    if (!courier.isWebLoginValid(username, password)) {
      return reply.code(401).send({ error: 'invalid_credentials' })
    }

    const expiresAt = Date.now() + config.sessionTtlMs
    const token = signSessionToken(accessControl.getWebSecret(), expiresAt)
    reply.header(
      'set-cookie',
      `${config.sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`
    )
    return { ok: true }
  })

  app.post('/auth/web-logout', async (_request, reply) => {
    reply.header('set-cookie', `${config.sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    return { ok: true }
  })

  // the key lives in WAC_API_KEY and the gateway never stores it — there is nothing to reveal
  // and nothing to rotate server-side. Both used to be endpoints here; rotating now means
  // editing the environment and restarting.
  app.get('/auth/api-key-status', async (request, reply) => {
    if (!accessControl.hasValidWebSession(request)) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    return { configured: courier.hasApiKey() }
  })
}

module.exports = authRoutes
