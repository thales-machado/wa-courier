'use strict'

const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  downloadMediaMessage
} = require('baileys')

const pino = require('pino')
const { randomBytes, timingSafeEqual } = require('node:crypto')
const { appendFile, writeFile, rm } = require('node:fs/promises')

const logger = require('./logger')
const config = require('../config')
const { isValidGroupJid, mediaMaxBytes } = require('./utils')
const { disconnectReasonToText, getDisconnectStatusCode } = require('./identity')
const metrics = require('./metrics')
const { extractInboundMedia, forwardInboundMedia } = require('./inboundMedia')
const { postJsonWithRetry } = require('./webhook')
const { ensureDirectory, readConfigFile, writeConfigFile, readRecentLog } = require('./configStore')
const { SendQueue } = require('./sendQueue')
const messaging = require('./messaging')

// libsignal (a Baileys dependency) calls console.info/console.warn directly on every Signal
// session rotation/close, dumping the full SessionEntry — including private key material
// (privKey, rootKey, chainKey, remoteIdentityKey) — as plain buffers. This bypasses our pino
// logger entirely (fires regardless of LOG_LEVEL) and leaks key material into stdout/container
// logs. Filtering by the exact strings libsignal uses (session_record.js) rather than
// silencing console.info/warn wholesale, so any other library's legitimate use is unaffected.
const originalConsoleInfo = console.info.bind(console)
const originalConsoleWarn = console.warn.bind(console)
console.info = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Closing session:')) return
  originalConsoleInfo(...args)
}
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Session already closed')) return
  originalConsoleWarn(...args)
}

// numeric values of Baileys' WAMessageStatus
const messageStatusNames = {
  0: 'error',
  1: 'pending',
  2: 'server_ack',
  3: 'delivery_ack',
  4: 'read',
  5: 'played'
}

// Owns the session lifecycle end to end — pairing, auto-reconnect, inbound media forwarding —
// plus the on-disk state (auth, config, send/receive logs) backing it. Outbound sending,
// JID resolution and group listing live in ./messaging.js; the methods at the bottom of this
// class are thin delegators to it, so callers still see one Courier surface.
class Courier {
  constructor() {
    this.socket = null
    this.state = 'idle'
    this.connected = false
    this.lastDisconnectReason = null

    this.connectPromise = null
    this.reconnectTimeout = null
    this.reconnectAttempts = 0

    this.config = {}
    this.groupCache = new Map()
    this.groupCacheExpiresAt = 0
    // groupJid -> timestamp until which the participants' sessions are considered warmed up,
    // so a burst to one group doesn't redo that setup for every single message
    this.warmedGroups = new Map()
    // same idea, for direct sends (userJid -> warmed-until timestamp) — see prepareDirectSend
    this.warmedUsers = new Map()
    this.sendQueue = new SendQueue({
      minIntervalMs: config.sendQueueIntervalMs,
      maxPending: config.sendQueueMaxPending
    })
    metrics.trackSendQueueDepth(() => this.sendQueue.pending + (this.sendQueue.processing ? 1 : 0))

    this.latestQr = null
    this.sentLog = []
    this.sentLogAppends = 0
    this.sentByMessageId = new Map()
    this.receivedLog = []
    this.receivedLogAppends = 0
    this.loggingOut = false
    this.openWaiters = []

    // appends and the periodic compaction rewrite target the same file; chaining serializes
    // them so a rewrite can't interleave with an in-flight append and lose lines
    this.sentPersistChain = Promise.resolve()
    this.receivedPersistChain = Promise.resolve()
  }

  waitForOpen(timeoutMs) {
    if (this.connected) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null }
      const timer = setTimeout(() => {
        const idx = this.openWaiters.indexOf(waiter)
        if (idx !== -1) this.openWaiters.splice(idx, 1)
        reject(new Error('session_not_connected'))
      }, timeoutMs)
      waiter.resolve = () => {
        clearTimeout(timer)
        resolve()
      }
      waiter.reject = (error) => {
        clearTimeout(timer)
        reject(error)
      }
      this.openWaiters.push(waiter)
    })
  }

  flushOpenWaiters(error) {
    const waiters = this.openWaiters
    this.openWaiters = []
    for (const waiter of waiters) {
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  async initialize() {
    await ensureDirectory(config.authDir)
    this.config = await readConfigFile()
    this.sentLog = await readRecentLog(config.sentLogPath, config.sentLogLimit)
    this.receivedLog = await readRecentLog(config.receivedLogPath, config.receivedLogLimit)

    if (this.getInboundMediaGroups().length > 0 && !config.inboundMediaWebhookUrl) {
      logger.warn('Inbound media groups configured but WAC_INBOUND_MEDIA_WEBHOOK_URL is not set')
    }
  }

  getSessionState() {
    return {
      connected: this.connected,
      state: this.state,
      lastDisconnectReason: this.lastDisconnectReason,
      paired: Boolean(this.socket?.user?.id),
      me: this.socket?.user?.id || null
    }
  }

  handleMessageStatusUpdates(updates) {
    for (const update of updates || []) {
      const messageId = update?.key?.id
      const statusCode = update?.update?.status
      if (!messageId || statusCode === undefined) continue

      const status = messageStatusNames[statusCode] || `status_${statusCode}`
      const entry = this.sentByMessageId.get(messageId)
      if (entry) {
        entry.status = status
        entry.statusUpdatedAt = new Date().toISOString()
      }

      metrics.recordMessageAck(status)
      void this.notifyStatusWebhook({ messageId, status, entry })
    }
  }

  async notifyStatusWebhook({ messageId, status, entry }) {
    if (!config.statusWebhookUrl) return
    try {
      await postJsonWithRetry(
        config.statusWebhookUrl,
        {
          event: 'message.status',
          messageId,
          status,
          to: entry?.to || null,
          kind: entry?.kind || null,
          type: entry?.type || null,
          ts: new Date().toISOString()
        },
        { secret: config.webhookSecret }
      )
    } catch (error) {
      logger.warn({ error: error?.message || error, messageId }, 'Failed to deliver status webhook')
    }
  }

  // A send is logged in two steps, because the HTTP response (202) happens long before the
  // message reaches WhatsApp: recordQueued puts it in the log immediately so it isn't
  // invisible while it waits, and resolveQueued fills in the outcome on the same record.
  recordQueued(entry) {
    const record = { ts: new Date().toISOString(), ...entry, queued: true }
    this.sentLog.unshift(record)
    if (this.sentLog.length > config.sentLogLimit) {
      const removed = this.sentLog.pop()
      if (removed?.messageId) this.sentByMessageId.delete(removed.messageId)
    }
    return record
  }

  // the queue refused the message, so the entry never becomes a real send
  dropQueued(record) {
    const index = this.sentLog.indexOf(record)
    if (index !== -1) this.sentLog.splice(index, 1)
  }

  // mutated in place rather than appended, so one message stays one row in the log
  resolveQueued(record, outcome) {
    Object.assign(record, outcome, { queued: false, sentAt: new Date().toISOString() })
    // a record can be evicted from sentLog while it still waits in the queue (the log is
    // smaller than the queue cap); indexing it after eviction would leak the map entry forever
    if (record.messageId && this.sentLog.includes(record)) this.sentByMessageId.set(record.messageId, record)
    // only failed sends are persisted — successful ones stay in memory for the session,
    // so the file doesn't grow with entries that have no audit value
    if (!record.ok) void this.persistSentEntry(record)
    metrics.recordMessageSent(record)
  }

  persistSentEntry(record) {
    this.sentPersistChain = this.sentPersistChain.then(() => this.writeSentEntry(record))
    return this.sentPersistChain
  }

  async writeSentEntry(record) {
    try {
      await ensureDirectory(config.dataDir)
      await appendFile(config.sentLogPath, `${JSON.stringify(record)}\n`, 'utf8')
      this.sentLogAppends += 1
      // compact the file periodically so it doesn't grow unbounded — errors only, same as what gets written
      if (this.sentLogAppends % 500 === 0) {
        const compact = `${this.sentLog
          .filter((r) => !r.ok)
          .reverse()
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`
        await writeFile(config.sentLogPath, compact, 'utf8')
      }
    } catch (error) {
      logger.error({ error }, 'Failed to persist sent log entry')
    }
  }

  // ---- inbound media (group -> webhook, e.g. n8n) ----

  getInboundMediaGroups() {
    return this.config.inboundMediaGroups || []
  }

  async addInboundMediaGroup(groupJid) {
    if (!isValidGroupJid(groupJid)) throw new Error('invalid_group_jid')
    const groups = new Set(this.getInboundMediaGroups())
    groups.add(groupJid)
    this.config.inboundMediaGroups = [...groups]
    await writeConfigFile(this.config)
    return this.config.inboundMediaGroups
  }

  async removeInboundMediaGroup(groupJid) {
    this.config.inboundMediaGroups = this.getInboundMediaGroups().filter((g) => g !== groupJid)
    await writeConfigFile(this.config)
    return this.config.inboundMediaGroups
  }

  recordReceived(entry) {
    const record = { ts: new Date().toISOString(), ...entry }
    this.receivedLog.unshift(record)
    if (this.receivedLog.length > config.receivedLogLimit) this.receivedLog.pop()
    void this.persistReceivedEntry(record)
    metrics.recordInboundMedia(record)
  }

  persistReceivedEntry(record) {
    this.receivedPersistChain = this.receivedPersistChain.then(() => this.writeReceivedEntry(record))
    return this.receivedPersistChain
  }

  async writeReceivedEntry(record) {
    try {
      await ensureDirectory(config.dataDir)
      await appendFile(config.receivedLogPath, `${JSON.stringify(record)}\n`, 'utf8')
      this.receivedLogAppends += 1
      // compact the file periodically so it doesn't grow unbounded
      if (this.receivedLogAppends % 500 === 0) {
        const compact = `${this.receivedLog
          .slice()
          .reverse()
          .map((r) => JSON.stringify(r))
          .join('\n')}\n`
        await writeFile(config.receivedLogPath, compact, 'utf8')
      }
    } catch (error) {
      logger.error({ error }, 'Failed to persist received log entry')
    }
  }

  async handleIncomingMessages({ messages, type }) {
    if (type !== 'notify') return
    const allowedGroups = new Set(this.getInboundMediaGroups())
    if (allowedGroups.size === 0) return

    for (const message of messages || []) {
      try {
        await this.processIncomingMessage(message, allowedGroups)
      } catch (error) {
        logger.error({ error }, 'Failed to process incoming message')
      }
    }
  }

  async processIncomingMessage(message, allowedGroups) {
    const remoteJid = message?.key?.remoteJid
    if (message?.key?.fromMe) return
    if (!remoteJid || !allowedGroups.has(remoteJid)) return

    const media = extractInboundMedia(message)
    if (!media) return

    const socket = this.socket
    if (!socket) return

    const sender = message.key.participant || remoteJid
    const messageId = message.key.id || null
    const recordBase = { groupJid: remoteJid, sender, type: media.type, fileName: media.fileName, messageId }

    const declaredSize = media.declaredSize
    if (declaredSize && declaredSize > mediaMaxBytes) {
      logger.warn({ remoteJid, messageId, declaredSize }, 'Inbound media exceeds size limit, skipping')
      this.recordReceived({ ...recordBase, ok: false, error: 'media_too_large' })
      return
    }

    let buffer
    try {
      buffer = await downloadMediaMessage(message, 'buffer', {}, { logger, reuploadRequest: socket.updateMediaMessage })
    } catch (error) {
      logger.error({ error, remoteJid, messageId }, 'Failed to download inbound media')
      this.recordReceived({ ...recordBase, ok: false, error: 'download_failed' })
      return
    }

    // second layer of protection, in case the metadata didn't report the size correctly
    if (buffer.length > mediaMaxBytes) {
      logger.warn(
        { remoteJid, messageId, size: buffer.length },
        'Downloaded inbound media exceeds size limit, discarding'
      )
      this.recordReceived({ ...recordBase, ok: false, error: 'media_too_large' })
      return
    }

    if (!config.inboundMediaWebhookUrl) {
      this.recordReceived({ ...recordBase, ok: false, error: 'webhook_not_configured' })
      return
    }

    try {
      const ok = await forwardInboundMedia(
        config.inboundMediaWebhookUrl,
        {
          buffer,
          media,
          groupJid: remoteJid,
          sender,
          messageId,
          ts: new Date().toISOString()
        },
        { secret: config.webhookSecret }
      )
      this.recordReceived({ ...recordBase, ok })
      if (!ok) logger.warn({ remoteJid, messageId }, 'Inbound media webhook responded with a non-2xx status')
    } catch (error) {
      logger.error({ error, remoteJid, messageId }, 'Failed to forward inbound media to webhook')
      this.recordReceived({ ...recordBase, ok: false, error: 'webhook_failed' })
    }
  }

  hasApiKey() {
    return Boolean(config.apiKey)
  }

  // constant-time so a wrong key can't be recovered byte by byte from response timing —
  // same treatment isWebLoginValid gives the web password
  isApiKeyValid(value) {
    if (!value || !config.apiKey) return false
    const a = Buffer.from(String(value))
    const b = Buffer.from(config.apiKey)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  async ensureWebSecret() {
    if (this.config.webSecret) return this.config.webSecret
    return this.rotateWebSecret()
  }

  // every outstanding session token is signed with this secret, so rotating it logs every
  // browser out at once — the web logout uses it, since clearing one cookie would leave the
  // token itself valid until its TTL expired
  async rotateWebSecret() {
    const secret = randomBytes(32).toString('hex')
    this.config.webSecret = secret
    await writeConfigFile(this.config)
    return secret
  }

  isWebLoginValid(username, password) {
    if (username !== config.webUser) return false
    if (!config.webPassEnv || !password) return false
    const a = Buffer.from(String(password))
    const b = Buffer.from(String(config.webPassEnv))
    return a.length === b.length && timingSafeEqual(a, b)
  }

  isWebLoginConfigured() {
    return Boolean(config.webPassEnv)
  }

  clearReconnectTimer() {
    if (!this.reconnectTimeout) return
    clearTimeout(this.reconnectTimeout)
    this.reconnectTimeout = null
  }

  scheduleReconnect() {
    if (this.reconnectTimeout || this.connectPromise) return

    // jitter prevents multiple instances (or the process restarting in a loop) from all
    // reconnecting at the exact same instant
    const jitter = Math.random() * 1000
    const delay = Math.min(
      config.reconnectBaseDelayMs * Math.max(1, 2 ** this.reconnectAttempts) + jitter,
      config.reconnectMaxDelayMs
    )
    this.reconnectAttempts += 1

    // no retry cap by design (auto-recovery is the point of the gateway), but log at error
    // level every N consecutive attempts so a reconnect loop doesn't go unnoticed
    if (this.reconnectAttempts % config.reconnectLoopAlertInterval === 0) {
      logger.error({ attempts: this.reconnectAttempts, delay }, 'Still reconnecting after multiple attempts')
    } else {
      logger.warn({ delay, attempt: this.reconnectAttempts }, 'Scheduling reconnect')
    }

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      void this.connect().catch((error) => {
        logger.error({ error }, 'Reconnect attempt failed')
      })
    }, delay)
  }

  async clearAuthState() {
    await rm(config.authDir, { recursive: true, force: true })
    await ensureDirectory(config.authDir)
    this.latestQr = null
    this.groupCache.clear()
    this.groupCacheExpiresAt = 0
    // the Signal sessions those entries vouched for are gone with the credentials
    this.warmedGroups.clear()
    this.warmedUsers.clear()
    logger.warn('Auth state cleared')
  }

  async logout() {
    this.loggingOut = true
    try {
      if (this.socket) {
        try {
          await this.socket.logout()
        } catch (_e) {
          /* session may already be dead */
        }
        try {
          this.socket.end?.()
        } catch (_e) {
          /* ignore */
        }
      }
    } finally {
      this.socket = null
      this.connectPromise = null
      this.connected = false
      this.state = 'idle'
      this.lastDisconnectReason = 'logout_requested'
      this.clearReconnectTimer()
      this.flushOpenWaiters(new Error('logout_requested'))
      await this.clearAuthState()
      this.loggingOut = false
    }
    // reconnect from scratch to generate a fresh QR
    void this.connect().catch((error) => {
      logger.error({ error }, 'Reconnect after logout failed')
    })
    return { loggedOut: true }
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise

    this.clearReconnectTimer()
    this.state = 'connecting'

    this.connectPromise = (async () => {
      const { state, saveCreds } = await useMultiFileAuthState(config.authDir)
      const { version } = await fetchLatestBaileysVersion()
      logger.info({ version: version.join('.') }, 'Using protocol version')

      const socket = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        getMessage: async () => undefined
      })

      this.socket = socket
      socket.ev.on('creds.update', saveCreds)
      socket.ev.on('messages.update', (updates) => this.handleMessageStatusUpdates(updates))
      socket.ev.on('messages.upsert', (payload) => {
        void this.handleIncomingMessages(payload)
      })

      socket.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          this.latestQr = qr
          logger.info('Pairing QR updated')
        }

        if (connection === 'connecting') {
          this.state = 'connecting'
          this.connected = false
          logger.info('Session connecting')
        }

        if (connection === 'open') {
          this.state = 'open'
          this.connected = true
          this.lastDisconnectReason = null
          this.reconnectAttempts = 0
          this.latestQr = null
          logger.info('Session open')
          this.flushOpenWaiters(null)
          metrics.setConnected(true)
        }

        if (connection === 'close') {
          this.state = 'close'
          this.connected = false
          metrics.setConnected(false)
          this.lastDisconnectReason = disconnectReasonToText(lastDisconnect?.error)
          logger.warn({ reason: this.lastDisconnectReason }, 'Session closed')

          const statusCode = getDisconnectStatusCode(lastDisconnect?.error)

          this.socket = null
          this.connectPromise = null
          this.flushOpenWaiters(new Error(this.lastDisconnectReason || 'session_not_connected'))

          if (this.loggingOut) return

          if (statusCode === DisconnectReason.loggedOut) {
            // auto-recovery: clear dead credentials and go back to the QR state
            logger.warn('Session logged out remotely; clearing stale credentials for re-pairing')
            void this.clearAuthState()
              .then(() => this.scheduleReconnect())
              .catch((error) => logger.error({ error }, 'Failed to clear auth state'))
          } else {
            this.scheduleReconnect()
          }
        }
      })

      return socket
    })()

    try {
      return await this.connectPromise
    } catch (error) {
      this.connectPromise = null
      this.state = 'close'
      this.connected = false
      this.lastDisconnectReason = error instanceof Error ? error.message : 'connect_failed'
      throw error
    }
  }

  getLatestQr() {
    return this.latestQr
  }

  async ensureConnected() {
    const socket = await this.connect()

    if (!socket.authState?.creds?.registered && !socket.user?.id) {
      throw new Error('session_not_paired')
    }

    if (!this.connected) {
      // the connection may still be handshaking right after a reconnect; wait for 'open' before giving up
      await this.waitForOpen(10_000)
    }

    return this.socket || socket
  }

  // ---- delegates to ./messaging.js — see that file for the actual implementation ----

  async getGroupMetadata(groupJid, includeRaw = false) {
    return messaging.getGroupMetadata(this, groupJid, includeRaw)
  }

  async getMe() {
    return messaging.getMe(this)
  }

  async resolveNumber(number) {
    return messaging.resolveNumber(this, number)
  }

  async sendGroupText(groupJid, text) {
    return messaging.sendGroupText(this, groupJid, text)
  }

  async sendDirectText(to, text) {
    return messaging.sendDirectText(this, to, text)
  }

  async sendMedia(to, options) {
    return messaging.sendMedia(this, to, options)
  }

  async listGroups(filterName, includeParticipants = false, includeRaw = false) {
    return messaging.listGroups(this, filterName, includeParticipants, includeRaw)
  }
}

module.exports = { Courier }
