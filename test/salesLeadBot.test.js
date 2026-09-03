'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { signPayload } = require('../src/lib/webhook')

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, resolve))
  const { port } = server.address()
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function loadSalesLeadBot(webhookUrl, secret) {
  process.env.WAC_SALES_LEAD_WEBHOOK_URL = webhookUrl
  if (secret) process.env.WAC_WEBHOOK_SECRET = secret
  else delete process.env.WAC_WEBHOOK_SECRET
  delete require.cache[require.resolve('../src/lib/salesLeadBot')]
  return require('../src/lib/salesLeadBot')
}

function resetEnv() {
  delete process.env.WAC_SALES_LEAD_WEBHOOK_URL
  delete process.env.WAC_WEBHOOK_SECRET
  delete require.cache[require.resolve('../src/lib/salesLeadBot')]
}

test('handleIncomingDm forwards inbound text with fromPn resolved via key.senderPn, signature over the original 6-field shape', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = { headers: req.headers, body: JSON.parse(raw) }
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url, 'top-secret')
      const message = {
        key: {
          remoteJid: '156332632072321@lid',
          senderPn: '5511931507004@s.whatsapp.net',
          id: 'MSG1'
        },
        message: { conversation: 'oi, quero saber mais' }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(received.body.from, '156332632072321@lid')
  assert.equal(received.body.fromPn, '5511931507004')
  assert.equal(received.body.direction, 'inbound')

  const signedPayload = JSON.stringify({
    event: received.body.event,
    kind: received.body.kind,
    from: received.body.from,
    messageId: received.body.messageId,
    ts: received.body.ts,
    text: received.body.text
  })
  const expected = `sha256=${signPayload('top-secret', signedPayload)}`
  assert.equal(received.headers['x-webhook-signature'], expected)

  resetEnv()
})

test('handleIncomingDm forwards inbound text with fromPn null when resolution fails, never dropping the message', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = JSON.parse(raw)
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url)
      const message = {
        key: { remoteJid: '156332632072321@lid', id: 'MSG2' },
        message: { conversation: 'oi' }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(received.from, '156332632072321@lid')
  assert.equal(received.fromPn, null)
  assert.equal(received.direction, 'inbound')

  resetEnv()
})

test('handleIncomingDm forwards a fromMe reply as outbound text', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = JSON.parse(raw)
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url)
      const message = {
        key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'MSG3', fromMe: true },
        message: { conversation: 'ja te respondo' }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(received.direction, 'outbound')
  assert.equal(received.text, 'ja te respondo')
  assert.equal(received.from, '5511999998888@s.whatsapp.net')

  resetEnv()
})

test('handleIncomingDm logs and drops fromMe media without forwarding', async () => {
  let requestCount = 0
  await withServer(
    (_req, res) => {
      requestCount += 1
      res.writeHead(200)
      res.end()
    },
    async (url) => {
      const salesLeadBot = loadSalesLeadBot(url)
      const message = {
        key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'MSG4', fromMe: true },
        message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 100 } }
      }
      const courier = { socket: {} }
      await salesLeadBot.handleIncomingDm(courier, message)
    }
  )

  assert.equal(requestCount, 0)
  resetEnv()
})

test('handleIncomingDm never throws when disabled', async () => {
  resetEnv()
  const salesLeadBot = require('../src/lib/salesLeadBot')
  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'MSG5' } }
  await assert.doesNotReject(salesLeadBot.handleIncomingDm({ socket: {} }, message))
})
