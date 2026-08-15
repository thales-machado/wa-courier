'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const messaging = require('../src/lib/messaging')
const { SendQueue } = require('../src/lib/sendQueue')

const GROUP_JID = '120363000000000000@g.us'
const USER_JID = '5511999999999@s.whatsapp.net'

// messaging.js takes `courier` as an explicit argument rather than being Courier methods,
// which is what lets these run against a stub with no Baileys socket anywhere
function createCourierStub({ sendMessage, ensureConnected, onWhatsApp } = {}) {
  const sent = []
  const socket = {
    sendMessage: sendMessage || (async () => ({ key: { id: 'MSG1' } })),
    groupMetadata: async () => ({ subject: 'Group', participants: [] }),
    assertSessions: async () => {},
    onWhatsApp: onWhatsApp || (async () => [{ exists: true, jid: USER_JID }])
  }

  // mirrors the real two-step logging: an entry appears as queued, then the same record is
  // mutated with the outcome
  return {
    sent,
    socket,
    sendQueue: new SendQueue({ minIntervalMs: 0 }),
    groupCache: new Map(),
    groupCacheExpiresAt: 0,
    warmedGroups: new Map(),
    ensureConnected: ensureConnected || (async () => socket),
    recordQueued(entry) {
      const record = { ts: new Date().toISOString(), ...entry, queued: true }
      sent.unshift(record)
      return record
    },
    dropQueued(record) {
      const index = sent.indexOf(record)
      if (index !== -1) sent.splice(index, 1)
    },
    resolveQueued(record, outcome) {
      Object.assign(record, outcome, { queued: false })
    }
  }
}

// the send entry points return as soon as the work is queued, so tests have to wait for the
// queue itself rather than the returned promise
async function settle(courier) {
  await courier.sendQueue.drain(2000)
}

test('sendGroupText answers queued and only sends once the queue runs it', async () => {
  let sends = 0
  const courier = createCourierStub({
    sendMessage: async () => {
      sends += 1
      return { key: { id: 'MSG1' } }
    }
  })

  const result = await messaging.sendGroupText(courier, GROUP_JID, 'hello')

  assert.equal(result.queued, true)
  assert.ok(result.queuedAt)
  assert.equal(result.messageId, undefined, 'no messageId is known yet at 202 time')

  await settle(courier)
  assert.equal(sends, 1)
  assert.equal(courier.sent.length, 1, 'one message stays one row in the log')
  assert.equal(courier.sent[0].to, GROUP_JID)
  assert.equal(courier.sent[0].kind, 'group')
  assert.equal(courier.sent[0].type, 'text')
  assert.equal(courier.sent[0].messageId, 'MSG1')
  assert.equal(courier.sent[0].ok, true)
  assert.equal(courier.sent[0].queued, false)
})

test('an accepted message is logged as queued before it is actually sent', async () => {
  // without this the message is invisible between the 202 and the send, which with a backlog
  // can be minutes
  let releaseBlocker
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve
  })
  const courier = createCourierStub()
  void courier.sendQueue.enqueue(() => blocker)

  await messaging.sendGroupText(courier, GROUP_JID, 'hello')

  assert.equal(courier.sent.length, 1)
  assert.equal(courier.sent[0].queued, true, 'visible while it waits')
  assert.equal(courier.sent[0].ok, undefined, 'no outcome yet')

  releaseBlocker()
  await settle(courier)

  assert.equal(courier.sent[0].queued, false)
  assert.equal(courier.sent[0].ok, true)
})

test('a message refused by a full queue leaves no entry behind', async () => {
  const courier = createCourierStub()
  courier.sendQueue = new SendQueue({ minIntervalMs: 0, maxPending: 1 })

  let releaseBlocker
  void courier.sendQueue.enqueue(
    () =>
      new Promise((resolve) => {
        releaseBlocker = resolve
      })
  )

  await assert.rejects(() => messaging.sendGroupText(courier, GROUP_JID, 'hello'), /queue_full/)
  assert.equal(courier.sent.length, 0, 'the queued entry must be rolled back')

  releaseBlocker()
})

test('sendGroupText records a failed send instead of throwing at the caller', async () => {
  const courier = createCourierStub({
    sendMessage: async () => {
      throw new Error('rate-overlimit')
    }
  })

  await messaging.sendGroupText(courier, GROUP_JID, 'hello')
  await settle(courier)

  assert.equal(courier.sent[0].ok, false)
  assert.equal(courier.sent[0].error, 'rate-overlimit')
})

test('sendGroupText rejects an invalid JID and empty text before queueing', async () => {
  const courier = createCourierStub()

  await assert.rejects(() => messaging.sendGroupText(courier, 'nope', 'hi'), /invalid_group_jid/)
  await assert.rejects(() => messaging.sendGroupText(courier, GROUP_JID, '   '), /empty_text/)
  assert.equal(courier.sendQueue.pending, 0)
})

test('send entry points fail fast when the session is down', async () => {
  const courier = createCourierStub({
    ensureConnected: async () => {
      throw new Error('session_not_paired')
    }
  })

  await assert.rejects(() => messaging.sendGroupText(courier, GROUP_JID, 'hi'), /session_not_paired/)
  // a target given as a JID short-circuits resolution, so this one only fails if the
  // pre-flight check is actually there
  await assert.rejects(() => messaging.sendDirectText(courier, USER_JID, 'hi'), /session_not_paired/)
  assert.equal(courier.sendQueue.pending, 0, 'nothing should be accepted for a dead session')
})

test('queued sends resolve the socket when they run, not when they are queued', async () => {
  // regression guard: capturing the socket upfront meant a reconnect while the message waited
  // in the queue left it sending against a dead one
  const dead = {
    sendMessage: async () => {
      throw new Error('Connection Closed')
    },
    groupMetadata: async () => ({ subject: 'G', participants: [] }),
    assertSessions: async () => {}
  }
  const live = {
    sendMessage: async () => ({ key: { id: 'AFTER_RECONNECT' } }),
    groupMetadata: async () => ({ subject: 'G', participants: [] }),
    assertSessions: async () => {}
  }

  let current = dead
  const courier = createCourierStub()
  courier.ensureConnected = async () => current

  // hold the queue so the message genuinely waits, which is the only situation where a
  // captured socket could go stale — an idle queue would run it before anything changed
  let releaseBlocker
  const blocker = new Promise((resolve) => {
    releaseBlocker = resolve
  })
  void courier.sendQueue.enqueue(() => blocker)

  await messaging.sendGroupText(courier, GROUP_JID, 'hi')
  // the reconnect lands while the message is still sitting in the queue
  current = live
  releaseBlocker()
  await settle(courier)

  assert.equal(courier.sent[0].ok, true)
  assert.equal(courier.sent[0].messageId, 'AFTER_RECONNECT')
})

test('sendDirectText routes a group JID through the group path', async () => {
  const courier = createCourierStub()

  const result = await messaging.sendDirectText(courier, GROUP_JID, 'hi')
  await settle(courier)

  assert.equal(result.queued, true)
  assert.equal(courier.sent[0].kind, 'group')
})

test('sendDirectText resolves a bare phone number to a JID', async () => {
  const courier = createCourierStub()

  const result = await messaging.sendDirectText(courier, '5511999999999', 'hi')
  await settle(courier)

  assert.equal(result.jid, USER_JID)
  assert.equal(courier.sent[0].to, USER_JID)
  assert.equal(courier.sent[0].kind, 'user')
})

test('sendDirectText rejects a number that is not on WhatsApp', async () => {
  const courier = createCourierStub({ onWhatsApp: async () => [] })

  await assert.rejects(() => messaging.sendDirectText(courier, '5511999999999', 'hi'), /number_not_on_whatsapp/)
})

test('sendMedia validates type, payload and mimetype before queueing', async () => {
  const courier = createCourierStub()
  const base64 = Buffer.from('image-bytes').toString('base64')

  await assert.rejects(
    () => messaging.sendMedia(courier, USER_JID, { type: 'hologram', mediaBase64: base64 }),
    /invalid_media_type/
  )
  await assert.rejects(() => messaging.sendMedia(courier, USER_JID, { type: 'image' }), /missing_media/)
  await assert.rejects(
    () => messaging.sendMedia(courier, USER_JID, { type: 'document', mediaBase64: base64 }),
    /missing_file_name/
  )
  await assert.rejects(
    () => messaging.sendMedia(courier, USER_JID, { type: 'image', mediaBase64: base64, mimetype: 'application/zip' }),
    /invalid_mimetype/
  )
  await assert.rejects(
    () => messaging.sendMedia(courier, USER_JID, { type: 'image', mediaBase64: 'not base64!!' }),
    /invalid_media_base64/
  )
  assert.equal(courier.sendQueue.pending, 0)
})

test('sendMedia queues a base64 image with its caption', async () => {
  let content = null
  const courier = createCourierStub({
    sendMessage: async (_jid, payload) => {
      content = payload
      return { key: { id: 'IMG1' } }
    }
  })

  const result = await messaging.sendMedia(courier, USER_JID, {
    type: 'image',
    mediaBase64: Buffer.from('image-bytes').toString('base64'),
    mimetype: 'image/png',
    caption: 'look'
  })
  await settle(courier)

  assert.equal(result.queued, true)
  assert.equal(content.caption, 'look')
  assert.ok(Buffer.isBuffer(content.image))
  assert.equal(courier.sent[0].type, 'image')
})

test('sendMedia marks audio as a voice note when ptt is set', async () => {
  let content = null
  const courier = createCourierStub({
    sendMessage: async (_jid, payload) => {
      content = payload
      return { key: { id: 'AUD1' } }
    }
  })

  await messaging.sendMedia(courier, USER_JID, {
    type: 'audio',
    mediaBase64: Buffer.from('audio-bytes').toString('base64'),
    mimetype: 'audio/mpeg',
    ptt: true
  })
  await settle(courier)

  assert.equal(content.ptt, true)
})

test('sends are serialized: a burst reaches WhatsApp one at a time', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const courier = createCourierStub({
    sendMessage: async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return { key: { id: 'X' } }
    }
  })

  await Promise.all([
    messaging.sendGroupText(courier, GROUP_JID, 'a'),
    messaging.sendGroupText(courier, GROUP_JID, 'b'),
    messaging.sendGroupText(courier, GROUP_JID, 'c')
  ])
  await settle(courier)

  assert.equal(maxInFlight, 1)
  assert.equal(courier.sent.length, 3)
})

test('group setup runs once per group, not once per message', async () => {
  // it used to fetch metadata twice and re-assert every participant session on every single
  // send, which is most of the wall time in a burst
  let metadataCalls = 0
  let warmupCalls = 0
  const courier = createCourierStub()
  courier.socket.groupMetadata = async () => {
    metadataCalls += 1
    return { subject: 'G', participants: [{ id: USER_JID }] }
  }
  courier.socket.assertSessions = async () => {
    warmupCalls += 1
  }

  for (let i = 0; i < 5; i++) await messaging.sendGroupText(courier, GROUP_JID, `#${i}`)
  await settle(courier)

  assert.equal(courier.sent.length, 5, 'all five still sent')
  assert.equal(metadataCalls, 1, 'one metadata fetch for the whole burst')
  assert.equal(warmupCalls, 1, 'participants asserted once')
})

test('a second group is warmed up on its own', async () => {
  let metadataCalls = 0
  const courier = createCourierStub()
  courier.socket.groupMetadata = async () => {
    metadataCalls += 1
    return { subject: 'G', participants: [] }
  }

  await messaging.sendGroupText(courier, GROUP_JID, 'a')
  await messaging.sendGroupText(courier, '120363000000000001@g.us', 'b')
  await settle(courier)

  assert.equal(metadataCalls, 2, 'the cache is per group, not global')
})

test('a failed warmup is retried on the next message', async () => {
  let attempts = 0
  const courier = createCourierStub()
  courier.socket.assertSessions = async () => {
    attempts += 1
    throw new Error('warmup boom')
  }

  await messaging.sendGroupText(courier, GROUP_JID, 'a')
  await settle(courier)
  await messaging.sendGroupText(courier, GROUP_JID, 'b')
  await settle(courier)

  assert.equal(attempts, 2, 'a group is only marked warm once the warmup actually succeeds')
  assert.equal(courier.sent.filter((m) => m.ok).length, 2, 'and the sends still go through')
})

test('listGroups filters by name and caches the fetch', async () => {
  let fetches = 0
  const courier = createCourierStub()
  courier.socket.groupFetchAllParticipating = async () => {
    fetches += 1
    return {
      a: { id: 'a@g.us', subject: 'Alerts', size: 3 },
      b: { id: 'b@g.us', subject: 'Family', size: 8 }
    }
  }

  const all = await messaging.listGroups(courier)
  assert.equal(all.length, 2)
  assert.deepEqual(
    all.map((g) => g.subject),
    ['Alerts', 'Family'],
    'sorted by subject'
  )

  const filtered = await messaging.listGroups(courier, 'ale')
  assert.deepEqual(
    filtered.map((g) => g.jid),
    ['a@g.us']
  )
  assert.equal(fetches, 1, 'second call is served from the cache')
})
