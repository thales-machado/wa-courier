'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { extractInboundMedia, forwardInboundMedia } = require('../src/lib/inboundMedia')
const { signPayload } = require('../src/lib/webhook')

test('extractInboundMedia returns null without message content', () => {
  assert.equal(extractInboundMedia({}), null)
  assert.equal(extractInboundMedia({ message: null }), null)
})

test('extractInboundMedia returns null for text-only messages', () => {
  const message = { message: { conversation: 'hello' } }
  assert.equal(extractInboundMedia(message), null)
})

test('extractInboundMedia extracts a plain documentMessage', () => {
  const message = {
    message: {
      documentMessage: { mimetype: 'application/pdf', fileName: 'invoice.pdf', caption: 'here' }
    }
  }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'document',
    mimetype: 'application/pdf',
    fileName: 'invoice.pdf',
    caption: 'here',
    declaredSize: null
  })
})

test('extractInboundMedia extracts a documentWithCaptionMessage', () => {
  const message = {
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' }
        }
      }
    }
  }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'document',
    mimetype: 'application/pdf',
    fileName: 'report.pdf',
    caption: null,
    declaredSize: null
  })
})

test('extractInboundMedia extracts an imageMessage and derives a file name', () => {
  const message = { message: { imageMessage: { mimetype: 'image/png' } } }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'image',
    mimetype: 'image/png',
    fileName: 'image.png',
    caption: null,
    declaredSize: null
  })
})

test('extractInboundMedia falls back to defaults for missing document fields', () => {
  const message = { message: { documentMessage: {} } }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'document',
    mimetype: 'application/octet-stream',
    fileName: 'document',
    caption: null,
    declaredSize: null
  })
})

test('extractInboundMedia reads a plain number fileLength as declaredSize', () => {
  const message = { message: { documentMessage: { fileLength: 12345 } } }
  assert.equal(extractInboundMedia(message).declaredSize, 12345)
})

test('extractInboundMedia reads a Long-like fileLength via toNumber', () => {
  const message = { message: { imageMessage: { fileLength: { toNumber: () => 99999 } } } }
  assert.equal(extractInboundMedia(message).declaredSize, 99999)
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

const baseParams = {
  buffer: Buffer.from('file-bytes'),
  media: { type: 'image', mimetype: 'image/png', fileName: 'photo.png' },
  groupJid: '120363000000000000@g.us',
  sender: '5511999999999@s.whatsapp.net',
  messageId: 'MSG1',
  ts: '2024-01-01T00:00:00.000Z'
}

test('forwardInboundMedia signs via the X-Webhook-Signature header, not a form field', async () => {
  let received = null
  await withServer(
    (req, res) => {
      let raw = Buffer.alloc(0)
      req.on('data', (chunk) => {
        raw = Buffer.concat([raw, chunk])
      })
      req.on('end', () => {
        received = { headers: req.headers, body: raw.toString('utf8') }
        res.writeHead(200)
        res.end()
      })
    },
    async (url) => {
      const ok = await forwardInboundMedia(url, baseParams, { secret: 'top-secret', retryDelaysMs: [] })
      assert.equal(ok, true)
    }
  )

  const expected = signPayload(
    'top-secret',
    `${baseParams.messageId}.${baseParams.ts}.${baseParams.groupJid}.${baseParams.sender}.${baseParams.media.fileName}.${baseParams.media.mimetype}`
  )
  assert.equal(received.headers['x-webhook-signature'], `sha256=${expected}`)
  // regression: the signature used to travel as a multipart field, forcing receivers to parse
  // (and buffer) the whole body before they could verify and reject
  assert.ok(!received.body.includes('name="signature"'), 'signature must not be a form field anymore')
})

test('forwardInboundMedia omits the signature header without a secret', async () => {
  let received = null
  await withServer(
    (req, res) => {
      received = req.headers
      res.writeHead(200)
      res.end()
    },
    async (url) => {
      await forwardInboundMedia(url, baseParams, { retryDelaysMs: [] })
    }
  )

  assert.equal(received['x-webhook-signature'], undefined)
})
