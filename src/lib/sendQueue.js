'use strict'

// Serializes every outbound WhatsApp send through one queue with a minimum interval
// between them. This protects against WhatsApp's own burst/rate-limit detection
// (server-side "rate-overlimit" errors) — it's unrelated to the per-IP API rate
// limiter in utils.js, which only protects our own HTTP endpoint.
class SendQueue {
  constructor({ minIntervalMs = 1500, maxPending = 100 } = {}) {
    this.minIntervalMs = minIntervalMs
    this.maxPending = maxPending
    this.queue = []
    this.processing = false
  }

  get pending() {
    return this.queue.length
  }

  // resolves/rejects when the task itself finishes running (not when it's merely
  // accepted into the queue) — callers that want a fire-and-forget 202 response
  // should not await this.
  // Throws queue_full synchronously when the backlog is at capacity: accepting without
  // bound would let a caller in a retry loop grow it forever and push real sends
  // minutes into the future.
  enqueue(task) {
    // counts the in-flight task too, so the cap bounds all accepted-but-unfinished work
    // (each of which may be holding a media buffer), not just what's waiting
    if (this.queue.length + (this.processing ? 1 : 0) >= this.maxPending) throw new Error('queue_full')
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject })
      void this.process()
    })
  }

  async process() {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const { task, resolve, reject } = this.queue.shift()
        try {
          resolve(await task())
        } catch (error) {
          reject(error)
        }
        if (this.queue.length > 0) await sleep(this.minIntervalMs)
      }
    } finally {
      this.processing = false
    }
  }

  // lets shutdown wait for in-flight/queued sends instead of dropping them silently —
  // resolves false if the deadline passes with work still pending
  async drain(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    while ((this.processing || this.queue.length > 0) && Date.now() < deadline) {
      await sleep(50)
    }
    return !this.processing && this.queue.length === 0
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { SendQueue }
