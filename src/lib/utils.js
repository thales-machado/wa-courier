'use strict'

const { createHmac, timingSafeEqual } = require('node:crypto')
const { isIP, BlockList } = require('node:net')
const dns = require('node:dns').promises

// sliding window per IP — used both for send endpoints and (with a stricter budget) for login
// attempts, so a guessed/leaked web password can't be brute-forced with unlimited attempts
function createRateLimiter(max, windowMs) {
  const buckets = new Map()
  let lastSweep = Date.now()

  // without this the map keeps one entry per IP that ever called, forever — a slow leak that
  // only shows up after the gateway has been reachable by many addresses for a long while
  function sweepExpired(now) {
    if (now - lastSweep < windowMs) return
    lastSweep = now
    for (const [ip, timestamps] of buckets) {
      if (timestamps.every((t) => now - t >= windowMs)) buckets.delete(ip)
    }
  }

  return function isRateLimited(ip) {
    const now = Date.now()
    sweepExpired(now)
    const bucket = buckets.get(ip) || []
    const fresh = bucket.filter((t) => now - t < windowMs)
    if (fresh.length >= max) {
      buckets.set(ip, fresh)
      return true
    }
    fresh.push(now)
    buckets.set(ip, fresh)
    return false
  }
}

const rateLimitMax = 30
const rateLimitWindowMs = 60_000
const isRateLimited = createRateLimiter(rateLimitMax, rateLimitWindowMs)

const loginRateLimitMax = 10
const loginRateLimitWindowMs = 5 * 60_000
const isLoginRateLimited = createRateLimiter(loginRateLimitMax, loginRateLimitWindowMs)

function isDigitsOnly(value) {
  return /^\d+$/.test(value)
}

function isValidGroupJid(value) {
  return /^[0-9-]+@g\.us$/.test(value)
}

function isUserJid(value) {
  return typeof value === 'string' && value.endsWith('@s.whatsapp.net')
}

function isLidJid(value) {
  return typeof value === 'string' && value.endsWith('@lid')
}

function normalizePnJid(value) {
  if (typeof value !== 'string' || !value) return null
  const base = value.replace(/:\d+(?=@s\.whatsapp\.net$)/, '')
  if (base.endsWith('@s.whatsapp.net')) return base
  return null
}

const allowedImageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const allowedVideoMimeTypes = new Set(['video/mp4', 'video/3gpp', 'video/quicktime'])
const allowedAudioMimeTypes = new Set(['audio/mpeg', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/amr', 'audio/webm'])

function isValidBase64(value) {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

function isValidMimetype(value) {
  return typeof value === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value)
}

function isPrivateIPv4(ip) {
  const [a, b] = ip.split('.').map(Number)
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  return false
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase()
  if (value === '::1') return true
  if (value.startsWith('fe80')) return true // link-local
  if (value.startsWith('fc') || value.startsWith('fd')) return true // unique local fc00::/7
  if (value.startsWith('::ffff:')) {
    const v4 = value.slice('::ffff:'.length)
    if (isIP(v4) === 4) return isPrivateIPv4(v4)
  }
  return false
}

function isPrivateIp(ip) {
  const version = isIP(ip)
  if (version === 4) return isPrivateIPv4(ip)
  if (version === 6) return isPrivateIPv6(ip)
  return true // unrecognized: block as a precaution
}

// parses human-friendly byte sizes ('20MB', '1.5 GB', '512kb', plain bytes) using binary
// multipliers (1KB = 1024B) — throws on anything unparseable so a typo fails the boot instead
// of silently disabling the size limit
const byteSizeMultipliers = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }

function parseByteSize(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(String(value))
  if (!match) throw new Error(`invalid_byte_size: ${value}`)
  return Math.floor(Number(match[1]) * byteSizeMultipliers[(match[2] || 'b').toLowerCase()])
}

// blocks SSRF: prevents the server from fetching media from internal/private addresses
async function assertSafeMediaUrl(mediaUrl) {
  let url
  try {
    url = new URL(mediaUrl)
  } catch (_error) {
    throw new Error('invalid_media_url')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('invalid_media_url')
  }

  const hostname = url.hostname
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('media_url_blocked')
    return
  }

  let addresses
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch (_error) {
    throw new Error('media_url_unresolvable')
  }

  if (!addresses.length || addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error('media_url_blocked')
  }
}

// builds an IP/CIDR allowlist (e.g. '10.0.0.0/8, 192.168.1.5') using Node's native BlockList,
// which already handles bit matching for IPv4 and IPv6 — avoids reimplementing mask arithmetic
function buildIpAllowList(cidrs) {
  const entries = (cidrs || []).map((entry) => entry.trim()).filter(Boolean)
  if (!entries.length) return null

  const list = new BlockList()
  for (const entry of entries) {
    const [address, prefixRaw] = entry.split('/')
    const version = isIP(address)
    if (!version) throw new Error(`invalid_cidr: ${entry}`)
    const prefix = prefixRaw === undefined ? (version === 4 ? 32 : 128) : Number(prefixRaw)
    list.addSubnet(address, prefix, version === 4 ? 'ipv4' : 'ipv6')
  }
  return list
}

// loopback is always allowed, regardless of the configured allowlist: the Docker HEALTHCHECK
// (and any other same-host caller) hits the app via localhost, and anyone with loopback access
// already has an equal or higher trust level than the network boundary this allowlist enforces
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isIpAllowed(allowList, ip) {
  if (!allowList) return true
  if (loopbackAddresses.has(ip)) return true
  const version = isIP(ip)
  if (!version) return false
  return allowList.check(ip, version === 4 ? 'ipv4' : 'ipv6')
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++
      results[current] = await mapper(items[current], current)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function signSessionToken(secret, expiresAt) {
  const payload = String(expiresAt)
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  return `${payload}.${sig}`
}

function verifySessionToken(secret, token) {
  if (typeof token !== 'string') return false
  const idx = token.indexOf('.')
  if (idx <= 0) return false
  const payload = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  const expiresAt = Number(payload)
  return Number.isFinite(expiresAt) && Date.now() < expiresAt
}

module.exports = {
  rateLimitMax,
  rateLimitWindowMs,
  isRateLimited,
  loginRateLimitMax,
  isLoginRateLimited,
  isDigitsOnly,
  isValidGroupJid,
  isUserJid,
  isLidJid,
  normalizePnJid,
  allowedImageMimeTypes,
  allowedVideoMimeTypes,
  allowedAudioMimeTypes,
  isValidBase64,
  isValidMimetype,
  isPrivateIp,
  parseByteSize,
  assertSafeMediaUrl,
  buildIpAllowList,
  isIpAllowed,
  mapWithConcurrency,
  parseCookies,
  signSessionToken,
  verifySessionToken
}
