'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

test('imobiliariaBot.handleIncomingDm returns false without throwing when the feature is disabled', async () => {
  delete process.env.WAC_IMOBILIARIA_WEBHOOK_URL
  delete process.env.WAC_IMOBILIARIA_PG_URL
  const imobiliariaBot = require('../src/lib/imobiliariaBot')

  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'ABC123' } }
  const claimed = await imobiliariaBot.handleIncomingDm({ socket: {} }, message)
  assert.equal(claimed, false)
})

test('imobiliariaBot.handleIncomingDm returns false for a fromMe message without touching resolvePhone', async () => {
  process.env.WAC_IMOBILIARIA_WEBHOOK_URL = 'http://example.invalid/webhook'
  process.env.WAC_IMOBILIARIA_PG_URL = 'postgres://example.invalid/db'
  delete require.cache[require.resolve('../src/lib/imobiliariaBot')]
  const imobiliariaBot = require('../src/lib/imobiliariaBot')

  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net', id: 'ABC123', fromMe: true } }
  const claimed = await imobiliariaBot.handleIncomingDm({ socket: {} }, message)
  assert.equal(claimed, false)

  delete process.env.WAC_IMOBILIARIA_WEBHOOK_URL
  delete process.env.WAC_IMOBILIARIA_PG_URL
  delete require.cache[require.resolve('../src/lib/imobiliariaBot')]
})
