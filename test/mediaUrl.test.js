'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')

const { assertSafeMediaUrl } = require('../src/lib/utils')
const { fetchMediaUrl, sendMedia } = require('../src/lib/messaging')
const { SendQueue } = require('../src/lib/sendQueue')

const USER_JID = '5511999999999@s.whatsapp.net'

async function withServer(handler, fn) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await fn(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// the real check blocks loopback, so these pass a permissive one to reach the redirect and
// size handling. What the real check does is asserted separately below.
const allowAll = async () => {}

// mimics the real check closely enough to prove the chain is re-validated on every hop
const blockMetadataService = async (url) => {
  if (new URL(url).hostname === '169.254.169.254') throw new Error('media_url_blocked')
}

test('assertSafeMediaUrl rejects non-http protocols and private addresses', async () => {
  await assert.rejects(() => assertSafeMediaUrl('file:///etc/passwd'), /invalid_media_url/)
  await assert.rejects(() => assertSafeMediaUrl('not a url'), /invalid_media_url/)
  await assert.rejects(() => assertSafeMediaUrl('http://127.0.0.1/x'), /media_url_blocked/)
  await assert.rejects(() => assertSafeMediaUrl('http://169.254.169.254/latest/meta-data'), /media_url_blocked/)
  await assert.rejects(() => assertSafeMediaUrl('http://10.1.2.3/x'), /media_url_blocked/)
})

test('sendMedia refuses a mediaUrl pointing at a private address', async () => {
  const courier = {
    sendQueue: new SendQueue({ minIntervalMs: 0 }),
    warmedGroups: new Map(),
    ensureConnected: async () => ({}),
    recordQueued: (entry) => entry,
    dropQueued() {},
    resolveQueued() {}
  }
  await assert.rejects(
    () => sendMedia(courier, USER_JID, { type: 'image', mediaUrl: 'http://127.0.0.1:9/x.png' }),
    /media_url_blocked/
  )
  assert.equal(courier.sendQueue.pending, 0)
})

test('fetchMediaUrl downloads the body of a plain 200', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end('image-bytes')
    },
    async (base) => {
      const buffer = await fetchMediaUrl(`${base}/img.png`, { assertUrl: allowAll })
      assert.ok(Buffer.isBuffer(buffer))
      assert.equal(buffer.toString(), 'image-bytes')
    }
  )
})

test('fetchMediaUrl follows a redirect chain to the final body', async () => {
  const seen = []
  await withServer(
    (req, res) => {
      seen.push(req.url)
      if (req.url === '/a') {
        res.writeHead(302, { location: '/b' })
        return res.end()
      }
      if (req.url === '/b') {
        res.writeHead(302, { location: '/c' })
        return res.end()
      }
      res.writeHead(200)
      res.end('final-bytes')
    },
    async (base) => {
      const buffer = await fetchMediaUrl(`${base}/a`, { assertUrl: allowAll })
      assert.equal(buffer.toString(), 'final-bytes')
      assert.deepEqual(seen, ['/a', '/b', '/c'])
    }
  )
})

test('fetchMediaUrl re-checks every hop, so a redirect cannot smuggle in a blocked host', async () => {
  // regression guard: Baileys followed redirects itself, so only the first URL was ever checked
  let reachedFinal = false
  await withServer(
    (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' })
        return res.end()
      }
      reachedFinal = true
      res.writeHead(200)
      res.end('secrets')
    },
    async (base) => {
      await assert.rejects(
        () => fetchMediaUrl(`${base}/start`, { assertUrl: blockMetadataService }),
        /media_url_blocked/
      )
    }
  )
  assert.equal(reachedFinal, false)
})

test('fetchMediaUrl gives up on an endless redirect loop', async () => {
  let hops = 0
  await withServer(
    (_req, res) => {
      hops += 1
      res.writeHead(302, { location: '/again' })
      res.end()
    },
    async (base) => {
      await assert.rejects(
        () => fetchMediaUrl(`${base}/loop`, { assertUrl: allowAll, maxRedirects: 3 }),
        /media_url_too_many_redirects/
      )
    }
  )
  assert.equal(hops, 4, 'the initial request plus maxRedirects hops')
})

test('fetchMediaUrl rejects a body over the size cap', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200)
      res.end(Buffer.alloc(2048))
    },
    async (base) => {
      // no content-length shortcut: this has to be caught after reading the body
      await assert.rejects(
        () => fetchMediaUrl(`${base}/big.bin`, { assertUrl: allowAll, maxBytes: 512 }),
        /media_too_large/
      )
    }
  )
})

test('fetchMediaUrl rejects an oversized content-length without downloading it', async () => {
  let bodySent = false
  await withServer(
    (_req, res) => {
      res.writeHead(200, { 'content-length': '999999999' })
      bodySent = true
      res.end(Buffer.alloc(16))
    },
    async (base) => {
      await assert.rejects(
        () => fetchMediaUrl(`${base}/huge.bin`, { assertUrl: allowAll, maxBytes: 1024 }),
        /media_too_large/
      )
    }
  )
  assert.ok(bodySent, 'server responded; the point is the client refused on the header')
})

test('fetchMediaUrl treats a non-2xx as unreachable', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404)
      res.end()
    },
    async (base) => {
      await assert.rejects(() => fetchMediaUrl(`${base}/missing.png`, { assertUrl: allowAll }), /media_url_unreachable/)
    }
  )
})

test('fetchMediaUrl treats a dead host as unreachable', async () => {
  await assert.rejects(() => fetchMediaUrl('http://127.0.0.1:1/x', { assertUrl: allowAll }), /media_url_unreachable/)
})

test('fetchMediaUrl fails a redirect with no Location header', async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(302)
      res.end()
    },
    async (base) => {
      await assert.rejects(() => fetchMediaUrl(`${base}/x`, { assertUrl: allowAll }), /media_url_unreachable/)
    }
  )
})
