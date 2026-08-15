'use strict'

const { parseCookies, verifySessionToken } = require('./utils')
const config = require('../config')

// Wires authentication for the HTTP API: the WAC_API_KEY value in an X-API-Key header for
// programmatic access, or a signed session cookie for the web UI — both accepted on
// authenticated routes, and the two credentials are entirely independent of each other.
function createAccessControl(courier) {
  let webSecret = null

  function setWebSecret(secret) {
    webSecret = secret
  }

  function hasValidWebSession(request) {
    const cookies = parseCookies(request.headers.cookie)
    return Boolean(webSecret) && verifySessionToken(webSecret, cookies[config.sessionCookieName])
  }

  function hasValidApiKey(request) {
    const header = request.headers['x-api-key']
    const apiKey = Array.isArray(header) ? header[0] : header
    return courier.isApiKeyValid(apiKey)
  }

  // the web session is checked first on purpose: the UI is gated by WEB_USER/WEB_PASS and must
  // stay reachable even when no API key is configured — that's the very screen telling you to
  // set one. Only API-key callers get the 503.
  async function requireAuth(request, reply) {
    if (hasValidWebSession(request)) return

    if (!courier.hasApiKey()) {
      reply.code(503).send({
        error: 'api_key_not_configured',
        message: 'Set WAC_API_KEY in the environment to enable API access'
      })
      return
    }

    if (hasValidApiKey(request)) return
    reply.code(401).send({ error: 'unauthorized' })
  }

  return {
    setWebSecret,
    getWebSecret: () => webSecret,
    hasValidWebSession,
    hasValidApiKey,
    requireAuth
  }
}

module.exports = { createAccessControl }
