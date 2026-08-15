'use strict'

const path = require('node:path')

// WAC_ is the prefix for every setting this helper reads (PORT, DATA_DIR and LOG_LEVEL are
// read straight from the environment and carry no prefix)
function envVar(name) {
  return process.env[`WAC_${name}`] ?? null
}

const port = Number(process.env.PORT || '3000')
const dataDir = process.env.DATA_DIR || '/app/data'
const authDir = path.join(dataDir, 'auth')
const configPath = path.join(dataDir, 'config.json')
const sentLogPath = path.join(dataDir, 'sent.ndjson')
const receivedLogPath = path.join(dataDir, 'received.ndjson')
const publicDir = path.join(__dirname, 'public')

const webUser = envVar('WEB_USER') || 'admin'
const webPassEnv = envVar('WEB_PASS')
// sole source of truth for API access: the gateway never generates or persists a key of its
// own. Unset means the HTTP API stays closed (503) — the web UI still works, it authenticates
// with WEB_USER/WEB_PASS instead
const apiKey = envVar('API_KEY')
const statusWebhookUrl = envVar('STATUS_WEBHOOK_URL')
const inboundMediaWebhookUrl = envVar('INBOUND_MEDIA_WEBHOOK_URL')
const webhookSecret = envVar('WEBHOOK_SECRET')
const allowedCidrs = (envVar('ALLOWED_CIDRS') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const sessionCookieName = 'wac_session'
const sessionTtlMs = 12 * 60 * 60 * 1000 // 12h

const groupCacheTtlMs = 5 * 60 * 1000
const reconnectBaseDelayMs = 2_000
// 5min cap — 30s was too aggressive during a prolonged outage (network down, upstream
// maintenance etc.): it hammered every 30s indefinitely instead of spacing out attempts
const reconnectMaxDelayMs = 5 * 60 * 1000
const reconnectLoopAlertInterval = 5
const sentLogLimit = 50
const receivedLogLimit = 50
// minimum gap between outbound sends — WhatsApp throttles bursts server-side
// ("rate-overlimit"), this keeps us under that instead of reacting to it after the fact
const sendQueueIntervalMs = Number(envVar('SEND_QUEUE_INTERVAL_MS') || 1500)
const sendQueueMaxPending = Number(envVar('SEND_QUEUE_MAX_PENDING') || 100)
// must stay below the container's stop grace period, or SIGKILL cuts the drain short and the
// queued messages are lost anyway. Docker defaults that grace to 10s, so docker-compose.yml
// raises it to 30s — adjust both together.
const shutdownDrainTimeoutMs = Number(envVar('SHUTDOWN_DRAIN_TIMEOUT_MS') || 20_000)

module.exports = {
  envVar,
  port,
  dataDir,
  authDir,
  configPath,
  sentLogPath,
  receivedLogPath,
  publicDir,
  webUser,
  webPassEnv,
  apiKey,
  statusWebhookUrl,
  inboundMediaWebhookUrl,
  webhookSecret,
  allowedCidrs,
  // one ceiling for media in both directions: inbound downloads before forwarding to the
  // webhook, and outbound mediaUrl fetches.
  // Parsed by lib/courier.js and lib/messaging.js via parseByteSize — kept as the raw env
  // string/default here so config.js has no dependency on lib/utils.js
  mediaMaxBytesRaw: envVar('MEDIA_MAX_BYTES') || 20 * 1024 * 1024,
  sessionCookieName,
  sessionTtlMs,
  groupCacheTtlMs,
  reconnectBaseDelayMs,
  reconnectMaxDelayMs,
  reconnectLoopAlertInterval,
  sentLogLimit,
  receivedLogLimit,
  sendQueueIntervalMs,
  sendQueueMaxPending,
  shutdownDrainTimeoutMs
}
