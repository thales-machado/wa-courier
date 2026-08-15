'use strict'

const { DisconnectReason, areJidsSameUser } = require('baileys')
const { isLidJid, normalizePnJid } = require('./utils')

// Boom-style errors from Baileys carry the reason in output.statusCode — shared here because
// the close handler needs the code itself (to detect loggedOut) and the log needs the text
function getDisconnectStatusCode(error) {
  return typeof error === 'object' &&
    error !== null &&
    'output' in error &&
    typeof error.output?.statusCode === 'number'
    ? error.output.statusCode
    : undefined
}

function disconnectReasonToText(error) {
  const statusCode = getDisconnectStatusCode(error)

  if (statusCode !== undefined) {
    const reason = Object.entries(DisconnectReason).find(([, v]) => v === statusCode)?.[0]
    return reason || `status_${statusCode}`
  }

  if (error instanceof Error) return error.message
  return 'unknown'
}

function extractMeIdentity(socket) {
  const user = socket?.user || null
  const meRaw = user?.id || null

  const meLid =
    user && typeof user === 'object'
      ? Object.values(user).find((v) => typeof v === 'string' && isLidJid(v)) || null
      : null

  return {
    meRaw,
    meLid,
    mePn: normalizePnJid(meRaw)
  }
}

async function resolveLidForPn(socket, pnJid) {
  try {
    if (!pnJid) return null
    const mapping = socket?.signalRepository?.lidMapping
    if (!mapping || typeof mapping.getLIDForPN !== 'function') return null
    const resolved = await mapping.getLIDForPN(pnJid)
    return isLidJid(resolved) ? resolved : null
  } catch (_error) {
    return null
  }
}

async function getResolvedMeIdentity(socket) {
  const base = extractMeIdentity(socket)
  const resolvedMeLid = base.meLid || (await resolveLidForPn(socket, base.mePn))

  return {
    ...base,
    meLid: resolvedMeLid,
    meLidSource: base.meLid ? 'socket.user' : resolvedMeLid ? 'signalRepository.lidMapping' : null
  }
}

function resolveIdentityForGroup(identity, meta) {
  const participants = meta?.participants || []
  const mePn = identity.mePn
  if (!mePn) return identity

  const participantByPn = participants.find((p) => p?.jid === mePn)
  if (!participantByPn) return identity

  const participantLid =
    (typeof participantByPn.lid === 'string' && isLidJid(participantByPn.lid) && participantByPn.lid) ||
    (typeof participantByPn.id === 'string' && isLidJid(participantByPn.id) && participantByPn.id) ||
    null

  if (!participantLid) return identity

  return {
    ...identity,
    meLid: identity.meLid || participantLid,
    meLidSource: identity.meLidSource || 'groupMetadata.participants'
  }
}

async function resolveIdentityForGroupMessage(socket, meta) {
  const baseIdentity = await getResolvedMeIdentity(socket)
  const identity = resolveIdentityForGroup(baseIdentity, meta)

  const mePartByS = (meta.participants || []).find((p) => areJidsSameUser(p.id, identity.meRaw))
  const mePartByLid = identity.meLid ? (meta.participants || []).find((p) => p.id === identity.meLid) : null

  return {
    ...identity,
    participantsAreLid: (meta.participants || []).some((p) => isLidJid(p.id)),
    iAmParticipantByS: Boolean(mePartByS),
    iAmParticipantByLid: Boolean(mePartByLid),
    myRole: mePartByLid?.admin || mePartByS?.admin || null
  }
}

module.exports = {
  getDisconnectStatusCode,
  disconnectReasonToText,
  extractMeIdentity,
  resolveLidForPn,
  getResolvedMeIdentity,
  resolveIdentityForGroup,
  resolveIdentityForGroupMessage
}
