'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

// config snapshots the environment at require time, so this has to come first
process.env.WAC_API_KEY = 'wac_test_key'
process.env.WAC_WEB_PASS = 'test-pass'

const Fastify = require('fastify')
const config = require('../src/config')
const { createAccessControl } = require('../src/lib/accessControl')
const { SendQueue } = require('../src/lib/sendQueue')
const { signSessionToken } = require('../src/lib/utils')

const messagesRoutes = require('../src/routes/messages')
const sessionRoutes = require('../src/routes/session')
const authRoutes = require('../src/routes/auth')
const monitoringRoutes = require('../src/routes/monitoring')
const uiRoutes = require('../src/routes/ui')

const API_KEY = 'wac_test_key'
const GROUP_JID = '120363000000000000@g.us'
const USER_JID = '5511999999999@s.whatsapp.net'

// Fastify's inject() drives a route end to end without opening a port, so these cover the
// wiring (auth guards, status codes, error mapping) that unit tests on lib/ can't reach
function buildApp({ courierOverrides = {} } = {}) {
  const courier = {
    hasApiKey: () => Boolean(config.apiKey),
    isApiKeyValid: (value) => value === config.apiKey,
    isWebLoginConfigured: () => true,
    isWebLoginValid: (u, p) => u === config.webUser && p === 'test-pass',
    getSessionState: () => ({ connected: true, state: 'open', lastDisconnectReason: null, paired: true, me: USER_JID }),
    sendQueue: new SendQueue({ minIntervalMs: 0 }),
    sentLog: [{ to: USER_JID, ok: true, messageId: 'M1' }],
    sendGroupText: async () => ({ queued: true, queuedAt: 'now' }),
    sendDirectText: async () => ({ queued: true, queuedAt: 'now', jid: USER_JID }),
    sendMedia: async () => ({ queued: true, queuedAt: 'now', jid: USER_JID }),
    ...courierOverrides
  }

  const app = Fastify({ logger: false })
  const accessControl = createAccessControl(courier)
  accessControl.setWebSecret('test-web-secret')

  const opts = { courier, accessControl }
  app.register(messagesRoutes, opts)
  app.register(sessionRoutes, opts)
  app.register(authRoutes, opts)
  app.register(monitoringRoutes, opts)
  app.register(uiRoutes, opts)

  return { app, courier, accessControl }
}

function webSessionCookie() {
  const token = signSessionToken('test-web-secret', Date.now() + 60_000)
  return `${config.sessionCookieName}=${encodeURIComponent(token)}`
}

test('protected routes reject a missing or wrong API key', async () => {
  const { app } = buildApp()

  const noKey = await app.inject({ method: 'GET', url: '/session' })
  assert.equal(noKey.statusCode, 401)

  const wrongKey = await app.inject({ method: 'GET', url: '/session', headers: { 'x-api-key': 'nope' } })
  assert.equal(wrongKey.statusCode, 401)
})

test('protected routes accept the configured API key', async () => {
  const { app } = buildApp()
  const res = await app.inject({ method: 'GET', url: '/session', headers: { 'x-api-key': API_KEY } })

  assert.equal(res.statusCode, 200)
  assert.equal(res.json().connected, true)
})

test('a valid web session cookie authenticates without an API key', async () => {
  const { app } = buildApp()
  const res = await app.inject({ method: 'GET', url: '/session', headers: { cookie: webSessionCookie() } })

  assert.equal(res.statusCode, 200)
})

test('with no API key configured the API answers 503 but the web session still works', async () => {
  // this is the regression that would lock the UI out of its own setup screen
  const { app } = buildApp({ courierOverrides: { hasApiKey: () => false } })

  const apiCall = await app.inject({ method: 'GET', url: '/session', headers: { 'x-api-key': 'anything' } })
  assert.equal(apiCall.statusCode, 503)
  assert.equal(apiCall.json().error, 'api_key_not_configured')

  const uiCall = await app.inject({ method: 'GET', url: '/session', headers: { cookie: webSessionCookie() } })
  assert.equal(uiCall.statusCode, 200)
})

test('health and metrics need no authentication', async () => {
  const { app } = buildApp()

  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 200)
})

test('readiness reports 503 while the session is down', async () => {
  const { app } = buildApp({
    courierOverrides: {
      getSessionState: () => ({ connected: false, state: 'close', paired: true })
    }
  })

  const res = await app.inject({ method: 'GET', url: '/health/ready' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().status, 'not_ready')
})

test('send endpoints answer 202 with a queued ack', async () => {
  const { app } = buildApp()

  const group = await app.inject({
    method: 'POST',
    url: '/messages/group/text',
    headers: { 'x-api-key': API_KEY },
    payload: { groupJid: GROUP_JID, text: 'hello' }
  })
  assert.equal(group.statusCode, 202)
  assert.equal(group.json().queued, true)

  const direct = await app.inject({
    method: 'POST',
    url: '/messages/text',
    headers: { 'x-api-key': API_KEY },
    payload: { to: USER_JID, text: 'hello' }
  })
  assert.equal(direct.statusCode, 202)

  const media = await app.inject({
    method: 'POST',
    url: '/messages/media',
    headers: { 'x-api-key': API_KEY },
    payload: { to: USER_JID, type: 'image', mediaUrl: 'https://example.com/a.png' }
  })
  assert.equal(media.statusCode, 202)
})

test('a full queue answers 503 queue_full', async () => {
  const { app } = buildApp({
    courierOverrides: {
      sendGroupText: async () => {
        throw new Error('queue_full')
      }
    }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/messages/group/text',
    headers: { 'x-api-key': API_KEY },
    payload: { groupJid: GROUP_JID, text: 'hello' }
  })

  assert.equal(res.statusCode, 503)
  assert.equal(res.json().error, 'queue_full')
})

test('a disconnected session answers 409, not an accepted 202', async () => {
  const { app } = buildApp({
    courierOverrides: {
      sendDirectText: async () => {
        throw new Error('session_not_paired')
      }
    }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/messages/text',
    headers: { 'x-api-key': API_KEY },
    payload: { to: USER_JID, text: 'hello' }
  })

  assert.equal(res.statusCode, 409)
})

test('oversized media answers 413', async () => {
  const { app } = buildApp({
    courierOverrides: {
      sendMedia: async () => {
        throw new Error('media_too_large')
      }
    }
  })

  const res = await app.inject({
    method: 'POST',
    url: '/messages/media',
    headers: { 'x-api-key': API_KEY },
    payload: { to: USER_JID, type: 'image', mediaUrl: 'https://example.com/big.png' }
  })

  assert.equal(res.statusCode, 413)
})

test('a validation error maps to 400 and an unmapped one to a generic 500', async () => {
  const { app } = buildApp({
    courierOverrides: {
      sendGroupText: async () => {
        throw new Error('invalid_group_jid')
      },
      sendDirectText: async () => {
        throw new Error('ECONNREFUSED 10.0.0.1:5432 internal detail')
      }
    }
  })

  const bad = await app.inject({
    method: 'POST',
    url: '/messages/group/text',
    headers: { 'x-api-key': API_KEY },
    payload: { groupJid: GROUP_JID, text: 'hi' }
  })
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().error, 'invalid_group_jid')

  const boom = await app.inject({
    method: 'POST',
    url: '/messages/text',
    headers: { 'x-api-key': API_KEY },
    payload: { to: USER_JID, text: 'hi' }
  })
  assert.equal(boom.statusCode, 500)
  assert.ok(!JSON.stringify(boom.json()).includes('10.0.0.1'), 'internal details must not leak to the client')
})

test('the schema rejects a payload missing required fields', async () => {
  const { app } = buildApp()

  const res = await app.inject({
    method: 'POST',
    url: '/messages/group/text',
    headers: { 'x-api-key': API_KEY },
    payload: { text: 'no group jid' }
  })

  assert.equal(res.statusCode, 400)
})

test('login issues a session cookie and rejects a wrong password', async () => {
  const { app } = buildApp()

  const ok = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: config.webUser, password: 'test-pass' }
  })
  assert.equal(ok.statusCode, 200)
  assert.match(ok.headers['set-cookie'], new RegExp(`${config.sessionCookieName}=`))
  assert.match(ok.headers['set-cookie'], /HttpOnly/)

  const bad = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: config.webUser, password: 'wrong' }
  })
  assert.equal(bad.statusCode, 401)
})

test('api-key-status is web-session only and never returns the key', async () => {
  const { app } = buildApp()

  const withKey = await app.inject({
    method: 'GET',
    url: '/auth/api-key-status',
    headers: { 'x-api-key': API_KEY }
  })
  assert.equal(withKey.statusCode, 401, 'an API key must not be enough to inspect key state')

  const withSession = await app.inject({
    method: 'GET',
    url: '/auth/api-key-status',
    headers: { cookie: webSessionCookie() }
  })
  assert.equal(withSession.statusCode, 200)
  assert.deepEqual(withSession.json(), { configured: true })
  assert.ok(!JSON.stringify(withSession.json()).includes(API_KEY))
})

test('web logout rotates the secret only for callers holding a valid session', async () => {
  let rotations = 0
  const { app, accessControl } = buildApp({
    courierOverrides: {
      rotateWebSecret: async () => {
        rotations += 1
        return 'rotated-secret'
      }
    }
  })

  const anonymous = await app.inject({ method: 'POST', url: '/auth/web-logout' })
  assert.equal(anonymous.statusCode, 200)
  assert.equal(rotations, 0, 'an anonymous POST must not be able to invalidate other sessions')

  const cookie = webSessionCookie()
  const authed = await app.inject({ method: 'POST', url: '/auth/web-logout', headers: { cookie } })
  assert.equal(authed.statusCode, 200)
  assert.equal(rotations, 1)
  assert.match(authed.headers['set-cookie'], /Max-Age=0/)
  assert.equal(accessControl.getWebSecret(), 'rotated-secret')

  // the old token was signed with the previous secret, so it must no longer authenticate
  const reuse = await app.inject({ method: 'GET', url: '/session', headers: { cookie } })
  assert.equal(reuse.statusCode, 401)
})

test('ui-config requires auth and reports the effective media cap', async () => {
  const { app } = buildApp()

  const anonymous = await app.inject({ method: 'GET', url: '/ui-config' })
  assert.equal(anonymous.statusCode, 401)

  const authed = await app.inject({ method: 'GET', url: '/ui-config', headers: { 'x-api-key': API_KEY } })
  assert.equal(authed.statusCode, 200)
  const { mediaMaxBytes } = authed.json()
  assert.ok(Number.isFinite(mediaMaxBytes) && mediaMaxBytes > 0)
})

test('the removed reveal and rotate endpoints are gone', async () => {
  const { app } = buildApp()

  const reveal = await app.inject({ method: 'GET', url: '/auth/api-key', headers: { cookie: webSessionCookie() } })
  assert.equal(reveal.statusCode, 404)

  const rotate = await app.inject({
    method: 'POST',
    url: '/auth/rotate-api-key',
    headers: { 'x-api-key': API_KEY }
  })
  assert.equal(rotate.statusCode, 404)
})
