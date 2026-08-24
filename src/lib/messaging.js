'use strict'

const {
  isValidGroupJid,
  isUserJid,
  isLidJid,
  allowedImageMimeTypes,
  allowedVideoMimeTypes,
  allowedAudioMimeTypes,
  isValidBase64,
  isValidMimetype,
  assertSafeMediaUrl,
  mapWithConcurrency,
  mediaMaxBytes
} = require('./utils')
const { resolveIdentityForGroupMessage, getResolvedMeIdentity } = require('./identity')
const logger = require('./logger')
const metrics = require('./metrics')
const config = require('../config')

const allowedMediaTypes = new Set(['image', 'video', 'audio', 'document'])
const mediaMimeAllowlists = {
  image: allowedImageMimeTypes,
  video: allowedVideoMimeTypes,
  audio: allowedAudioMimeTypes
}

// Everything here takes `courier` explicitly instead of being a Courier method — it's the
// part of the class that dealt with resolving/sending/listing, split out because courier.js
// was getting crowded with unrelated concerns (session lifecycle, inbound media, logs...).
// courier.js keeps thin delegator methods so the public API (courier.sendGroupText(...) etc.)
// is unchanged for routes.

async function warmupGroupSessions(socket, groupJid, meta) {
  const groupMeta = meta || (await socket.groupMetadata(groupJid))
  const participantJids = (groupMeta.participants || []).map((p) => p.id).filter(Boolean)

  if (typeof socket.assertSessions === 'function') {
    await socket.assertSessions(participantJids, true)
  }

  return participantJids.length
}

// Asserting the participants' Signal sessions, and the identity diagnostic that goes with it,
// are per-group setup rather than per-message work: none of it changes between two messages to
// the same group. Doing it on every send cost two groupMetadata round trips plus an
// assertSessions over the whole participant list, which in a burst is most of the wall time.
// Cached for the same TTL as the group list, so membership changes still get picked up.
async function prepareGroupSend(courier, socket, groupJid) {
  if ((courier.warmedGroups.get(groupJid) || 0) > Date.now()) return

  let meta = null
  try {
    meta = await socket.groupMetadata(groupJid)
    const identity = await resolveIdentityForGroupMessage(socket, meta)

    if (
      (identity.participantsAreLid && !identity.iAmParticipantByLid) ||
      (!identity.participantsAreLid && !identity.iAmParticipantByS)
    ) {
      logger.warn({ groupJid, subject: meta.subject }, 'Participant validation mismatch; proceeding with send attempt')
    }
  } catch (e) {
    logger.warn({ err: e?.message || e }, 'group metadata diagnostics failed')
  }

  try {
    await warmupGroupSessions(socket, groupJid, meta)
    // only marked warm on success, so a failed warmup is retried on the next message
    courier.warmedGroups.set(groupJid, Date.now() + config.groupCacheTtlMs)
  } catch (e) {
    logger.warn({ err: e }, 'Warmup group sessions failed (will still try send)')
  }
}

// Follows redirects manually so every hop is re-checked against the SSRF rules, and caps the
// download so a hostile URL can't stream us out of memory. Note this still can't fully close
// the DNS-rebinding window (the name is resolved once for the check, again by fetch); that
// would need connection-level IP pinning, which fetch doesn't expose.
// assertUrl is injectable purely so tests can exercise the redirect/size handling against a
// loopback server, which the real check blocks by design. Production always uses the default.
async function fetchMediaUrl(
  mediaUrl,
  { maxRedirects = 3, timeoutMs = 20_000, assertUrl = assertSafeMediaUrl, maxBytes = mediaMaxBytes } = {}
) {
  let current = mediaUrl

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertUrl(current)

    const controller = new AbortController()
    // the timer covers the whole hop, headers and body — a server that answers fast but
    // drips the body forever still gets cut off
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      let res
      try {
        res = await fetch(current, { redirect: 'manual', signal: controller.signal })
      } catch (error) {
        logger.warn({ error: error?.message, url: current }, 'media_url fetch failed')
        throw new Error('media_url_unreachable')
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location')
        if (!location) throw new Error('media_url_unreachable')
        current = new URL(location, current).toString()
        continue
      }

      if (!res.ok) throw new Error('media_url_unreachable')

      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error('media_too_large')
      }

      // read incrementally instead of res.arrayBuffer(): with chunked encoding there is no
      // content-length to check upfront, and buffering the whole response first would let a
      // hostile server stream far past the cap before the post-hoc check ever ran
      if (!res.body) return Buffer.alloc(0)
      const chunks = []
      let received = 0
      try {
        for await (const chunk of res.body) {
          received += chunk.length
          if (received > maxBytes) {
            controller.abort()
            throw new Error('media_too_large')
          }
          chunks.push(Buffer.from(chunk))
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'media_too_large') throw error
        throw new Error('media_url_unreachable')
      }
      return Buffer.concat(chunks)
    } finally {
      clearTimeout(timeout)
    }
  }

  throw new Error('media_url_too_many_redirects')
}

// ---- actual sends, run one at a time through courier.sendQueue ----

// puts the entry in the log before queueing so the message is visible during the wait, and
// removes it again if the queue turns out to be full
function queueSend(courier, entry, run) {
  const record = courier.recordQueued(entry)
  try {
    // the perform* handlers resolve their own outcome and never reject in normal operation;
    // anything escaping them would otherwise be an unhandledRejection, which kills the process
    courier.sendQueue
      .enqueue(() => run(record))
      .catch((error) => {
        logger.error({ error }, 'Queued send task failed unexpectedly')
      })
  } catch (error) {
    courier.dropQueued(record)
    if (error?.message === 'queue_full') metrics.recordSendQueueRejected()
    throw error
  }
  return record
}

// one skeleton for every queued send, whatever the content: resolve the socket when the task
// actually runs (never captured upfront — see the entry-point comment below), warm the group
// if the target is one, send, and settle the log record either way
async function performQueuedSend(courier, record, { jid, kind, type }, content) {
  let socket
  try {
    socket = await courier.ensureConnected()
  } catch (error) {
    logger.error({ error, to: jid, type }, 'Not connected when the queued send came up')
    courier.resolveQueued(record, { ok: false, error: String(error?.message || error) })
    return { sent: false, error: String(error?.message || error), jid }
  }

  if (kind === 'group') await prepareGroupSend(courier, socket, jid)

  try {
    const result = await socket.sendMessage(jid, content)
    const messageId = result?.key?.id || 'unknown'
    logger.info({ to: jid, messageId, type }, 'Message sent')
    courier.resolveQueued(record, { messageId, ok: true })
    return { sent: true, messageId, jid }
  } catch (error) {
    logger.error({ error, to: jid, type }, 'Failed to send message via Baileys')
    courier.resolveQueued(record, { ok: false, error: String(error?.message || error) })
    return { sent: false, error: String(error?.message || error), jid }
  }
}

// ---- public entry points, called from courier.js delegators ----

// The three send entry points validate, resolve, then hand the network call to the queue —
// callers get a `queued` ack rather than waiting for WhatsApp to confirm, and the real outcome
// lands in courier.sentLog / GET /messages/recent once the queue gets to it.
//
// Each one awaits ensureConnected() and throws away the socket. That looks redundant but isn't:
// the call is a pre-flight check so a dead session fails the request outright (409) instead of
// being accepted as a 202 that can never be delivered. The socket itself must NOT be captured,
// because by the time the queue reaches the task the session may have reconnected and this
// reference would be dead — so each task resolves its own when it runs.
async function sendGroupText(courier, groupJid, text) {
  if (!isValidGroupJid(groupJid)) throw new Error('invalid_group_jid')
  if (!text?.trim()) throw new Error('empty_text')

  await courier.ensureConnected()
  logger.info({ groupJid, textLength: text.trim().length }, 'Queuing group text')

  const record = queueSend(courier, { to: groupJid, kind: 'group', type: 'text' }, (r) =>
    performQueuedSend(courier, r, { jid: groupJid, kind: 'group', type: 'text' }, { text })
  )

  return { queued: true, queuedAt: record.ts }
}

async function sendDirectText(courier, to, text) {
  if (!text?.trim()) throw new Error('empty_text')

  const target = await resolveTargetJid(courier, to)
  if (target.kind === 'group') return sendGroupText(courier, target.jid, text)

  // resolveTargetJid only touches the network when it has to look a phone number up; a target
  // passed as a JID short-circuits, so without this the pre-flight check would be skipped
  await courier.ensureConnected()

  const record = queueSend(courier, { to: target.jid, kind: 'user', type: 'text' }, (r) =>
    performQueuedSend(courier, r, { jid: target.jid, kind: 'user', type: 'text' }, { text })
  )

  return { queued: true, queuedAt: record.ts, jid: target.jid }
}

async function sendMedia(courier, to, { type = 'image', mediaUrl, mediaBase64, caption, mimetype, fileName, ptt }) {
  if (!allowedMediaTypes.has(type)) throw new Error('invalid_media_type')
  if (!mediaUrl && !mediaBase64) throw new Error('missing_media')
  if (type === 'document' && !fileName) throw new Error('missing_file_name')

  const allowlist = mediaMimeAllowlists[type]
  if (mimetype && allowlist && !allowlist.has(mimetype)) {
    throw new Error('invalid_mimetype')
  } else if (mimetype && !allowlist && !isValidMimetype(mimetype)) {
    throw new Error('invalid_mimetype')
  }

  if (mediaBase64 && !isValidBase64(mediaBase64)) throw new Error('invalid_media_base64')
  // bodyLimit already caps the request, but with ~1MB of JSON-overhead slack — this makes
  // WAC_MEDIA_MAX_BYTES exact for the base64 path too, and answers 413 instead of relying
  // on the transport-level cutoff
  if (mediaBase64 && (mediaBase64.length * 3) / 4 > mediaMaxBytes) throw new Error('media_too_large')
  if (mediaUrl) await assertSafeMediaUrl(mediaUrl)

  const target = await resolveTargetJid(courier, to)
  await courier.ensureConnected()

  // fetched here rather than handed to Baileys as { url }: Baileys would follow redirects
  // itself, and only the first URL ever passed assertSafeMediaUrl — a 302 to an internal
  // address would sail straight through the SSRF check
  const mediaPayload = mediaUrl ? await fetchMediaUrl(mediaUrl) : Buffer.from(mediaBase64, 'base64')
  const content = { mimetype: mimetype || undefined }

  if (type === 'image') {
    content.image = mediaPayload
    content.caption = caption || undefined
  } else if (type === 'video') {
    content.video = mediaPayload
    content.caption = caption || undefined
  } else if (type === 'audio') {
    content.audio = mediaPayload
    content.ptt = Boolean(ptt)
  } else {
    content.document = mediaPayload
    content.fileName = fileName
    content.caption = caption || undefined
  }

  const record = queueSend(courier, { to: target.jid, kind: target.kind, type }, (r) =>
    performQueuedSend(courier, r, { jid: target.jid, kind: target.kind, type }, content)
  )

  return { queued: true, queuedAt: record.ts, jid: target.jid }
}

// includeRaw is opt-in (like listGroups): the raw Baileys payload doubles the response and
// exposes the library's internal shape as API surface, so it's for debugging only
async function getGroupMetadata(courier, groupJid, includeRaw = false) {
  if (!isValidGroupJid(groupJid)) throw new Error('invalid_group_jid')

  const socket = await courier.ensureConnected()
  const meta = await socket.groupMetadata(groupJid)
  const identity = await resolveIdentityForGroupMessage(socket, meta)

  return {
    jid: groupJid,
    subject: meta.subject,
    announce: meta.announce,
    restrict: meta.restrict,
    size: meta.size,
    description: meta.desc || null,
    owner: meta.owner || null,
    creation: meta.creation || null,
    me: {
      meRaw: identity.meRaw || null,
      mePn: identity.mePn || null,
      meLid: identity.meLid || null,
      meLidSource: identity.meLidSource || null,
      iAmParticipantByS: identity.iAmParticipantByS,
      iAmParticipantByLid: identity.iAmParticipantByLid,
      myRole: identity.myRole,
      participantsAreLid: identity.participantsAreLid,
      addressingMode: meta.addressingMode || null
    },
    participants: (meta.participants || []).map((p) => ({
      id: p.id,
      admin: p.admin || null
    })),
    ...(includeRaw ? { raw: meta } : {})
  }
}

async function getMe(courier) {
  const socket = await courier.ensureConnected()
  const identity = await getResolvedMeIdentity(socket)

  return {
    user: socket.user || null,
    identity
  }
}

async function resolveNumber(courier, number) {
  const digits = String(number || '').replace(/\D/g, '')
  if (!digits || digits.length < 8) throw new Error('invalid_number')

  const socket = await courier.ensureConnected()
  const results = await socket.onWhatsApp(digits)
  const found = (results || []).find((r) => r.exists)

  return {
    number: digits,
    exists: Boolean(found),
    jid: found?.jid || null
  }
}

async function resolveTargetJid(courier, to) {
  const value = String(to || '').trim()
  if (!value) throw new Error('invalid_target')
  if (isValidGroupJid(value)) return { jid: value, kind: 'group' }
  if (isUserJid(value) || isLidJid(value)) return { jid: value, kind: 'user' }

  const digits = value.replace(/\D/g, '')
  if (digits.length < 8) throw new Error('invalid_target')

  const resolved = await resolveNumber(courier, digits)
  if (!resolved.exists) throw new Error('number_not_on_whatsapp')

  return { jid: resolved.jid, kind: 'user' }
}

async function listGroups(courier, filterName, includeParticipants = false, includeRaw = false) {
  const socket = await courier.ensureConnected()
  const now = Date.now()

  if (now >= courier.groupCacheExpiresAt) {
    const groups = await socket.groupFetchAllParticipating()
    courier.groupCache.clear()
    for (const group of Object.values(groups)) courier.groupCache.set(group.id, group)
    courier.groupCacheExpiresAt = now + config.groupCacheTtlMs
  }

  const normalizedFilter = filterName?.trim().toLowerCase()

  const basic = [...courier.groupCache.values()]
    .map((group) => ({
      jid: group.id,
      subject: group.subject || '',
      size: group.size || 0
    }))
    .filter((group) => (normalizedFilter ? group.subject.toLowerCase().includes(normalizedFilter) : true))
    .sort((a, b) => a.subject.localeCompare(b.subject))

  if (!includeParticipants && !includeRaw) return basic

  return mapWithConcurrency(basic, 4, async (g) => {
    try {
      const meta = await socket.groupMetadata(g.jid)
      const item = { ...g }
      if (includeParticipants) {
        item.participants = (meta.participants || []).map((p) => ({
          id: p.id,
          admin: p.admin || null
        }))
      }
      if (includeRaw) {
        item.raw = meta
      }
      return item
    } catch (e) {
      return { ...g, metadataError: String(e?.message || e) }
    }
  })
}

module.exports = {
  sendGroupText,
  sendDirectText,
  sendMedia,
  getGroupMetadata,
  getMe,
  resolveNumber,
  resolveTargetJid,
  listGroups,
  fetchMediaUrl
}
