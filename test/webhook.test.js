'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { signPayload, postJsonWithRetry } = require('../src/lib/webhook')

test('signPayload is deterministic and secret-dependent', () => {
  const a = signPayload('secret-a', 'payload')
  const b = signPayload('secret-a', 'payload')
  const c = signPayload('secret-b', 'payload')
  assert.equal(a, b)
  assert.notEqual(a, c)
})

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

test('postJsonWithRetry sends a signed body when a secret is set', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = { headers: req.headers, body: raw }
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      await postJsonWithRetry(url, { hello: 'world' }, { secret: 'top-secret', retryDelaysMs: [] })
    }
  )

  assert.equal(received.body, JSON.stringify({ hello: 'world' }))
  const expected = `sha256=${signPayload('top-secret', received.body)}`
  assert.equal(received.headers['x-webhook-signature'], expected)
})

test('postJsonWithRetry omits the signature header without a secret', async () => {
  let received = null
  await withServer(
    (req, res) => {
      received = req.headers
      res.writeHead(200)
      res.end()
    },
    async (url) => {
      await postJsonWithRetry(url, { a: 1 }, { retryDelaysMs: [] })
    }
  )

  assert.equal(received['x-webhook-signature'], undefined)
})

test('postJsonWithRetry signs an explicit signedPayload instead of the body', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
      })
      req.on('end', () => {
        received = { headers: req.headers, body: raw }
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      await postJsonWithRetry(
        url,
        { a: 1, extra: 'not signed' },
        { secret: 'top-secret', retryDelaysMs: [], signedPayload: JSON.stringify({ a: 1 }) }
      )
    }
  )

  assert.equal(received.body, JSON.stringify({ a: 1, extra: 'not signed' }))
  const expected = `sha256=${signPayload('top-secret', JSON.stringify({ a: 1 }))}`
  assert.equal(received.headers['x-webhook-signature'], expected)
})

test('postJsonWithRetry retries after a connection failure and eventually succeeds', async () => {
  let attempts = 0
  await withServer(
    (req, res) => {
      attempts += 1
      if (attempts < 2) {
        req.destroy()
        return
      }
      res.writeHead(200)
      res.end()
    },
    async (url) => {
      await postJsonWithRetry(url, { a: 1 }, { retryDelaysMs: [10] })
    }
  )

  assert.equal(attempts, 2)
})

test('postJsonWithRetry throws after exhausting retries', async () => {
  await assert.rejects(postJsonWithRetry('http://127.0.0.1:1', { a: 1 }, { retryDelaysMs: [5, 5] }))
})
