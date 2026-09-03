'use strict'

const { createHmac } = require('node:crypto')
const { sleep } = require('./utils')

// short backoff between attempts — only covers transient network/timeout failures, never waits minutes
const defaultRetryDelaysMs = [500, 1500]

function signPayload(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

// JSON POST with timeout, optional HMAC signature and short retry — only reacts to network/timeout
// errors; an HTTP response (even non-2xx) ends the attempts, since insisting won't change the outcome
async function postJsonWithRetry(url, body, { secret, signedPayload, timeoutMs = 5000, retryDelaysMs = defaultRetryDelaysMs } = {}) {
  const payload = JSON.stringify(body)
  const headers = { 'Content-Type': 'application/json' }
  if (secret) headers['X-Webhook-Signature'] = `sha256=${signPayload(secret, signedPayload ?? payload)}`

  let lastError = null
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal })
      return
    } catch (error) {
      lastError = error
      if (attempt < retryDelaysMs.length) await sleep(retryDelaysMs[attempt])
    } finally {
      clearTimeout(timeout)
    }
  }
  throw lastError
}

module.exports = { signPayload, postJsonWithRetry, defaultRetryDelaysMs }
