'use strict'

const test = require('node:test')
const assert = require('node:assert')

// config reads the env at require time, so this has to be set before the module graph loads
process.env.WAC_API_KEY = 'wac_0123456789abcdef'

const { Courier } = require('../src/lib/courier')

test('isApiKeyValid accepts the configured key', () => {
  const courier = new Courier()
  assert.strictEqual(courier.isApiKeyValid('wac_0123456789abcdef'), true)
})

test('isApiKeyValid rejects wrong, empty and differently-sized keys', () => {
  const courier = new Courier()
  assert.strictEqual(courier.isApiKeyValid('wac_0123456789abcdee'), false)
  assert.strictEqual(courier.isApiKeyValid('wac_0123456789abcde'), false)
  assert.strictEqual(courier.isApiKeyValid('wac_0123456789abcdefg'), false)
  assert.strictEqual(courier.isApiKeyValid(''), false)
  assert.strictEqual(courier.isApiKeyValid(undefined), false)
  assert.strictEqual(courier.isApiKeyValid(null), false)
})

test('isApiKeyValid does not throw on a length mismatch', () => {
  // timingSafeEqual throws on differing buffer sizes — the length guard has to come first
  const courier = new Courier()
  assert.doesNotThrow(() => courier.isApiKeyValid('x'))
})

test('hasApiKey reflects the environment', () => {
  const courier = new Courier()
  assert.strictEqual(courier.hasApiKey(), true)
})
