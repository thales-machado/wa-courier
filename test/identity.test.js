'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { resolveIdentityForGroup, disconnectReasonToText, resolvePhone } = require('../src/lib/identity')

test('resolveIdentityForGroup returns identity untouched without mePn', () => {
  const identity = { meRaw: null, meLid: null, mePn: null }
  const result = resolveIdentityForGroup(identity, { participants: [] })
  assert.deepEqual(result, identity)
})

test('resolveIdentityForGroup returns identity untouched without a matching participant', () => {
  const identity = { meRaw: 'x', meLid: null, mePn: '5511999998888@s.whatsapp.net' }
  const meta = { participants: [{ jid: '5511888887777@s.whatsapp.net' }] }
  const result = resolveIdentityForGroup(identity, meta)
  assert.deepEqual(result, identity)
})

test('resolveIdentityForGroup resolves meLid via the participant lid field', () => {
  const identity = { meRaw: 'x', meLid: null, mePn: '5511999998888@s.whatsapp.net' }
  const meta = {
    participants: [{ jid: '5511999998888@s.whatsapp.net', lid: '123456@lid' }]
  }
  const result = resolveIdentityForGroup(identity, meta)
  assert.equal(result.meLid, '123456@lid')
  assert.equal(result.meLidSource, 'groupMetadata.participants')
})

test('resolveIdentityForGroup resolves meLid via the id field when it is @lid', () => {
  const identity = { meRaw: 'x', meLid: null, mePn: '5511999998888@s.whatsapp.net' }
  const meta = {
    participants: [{ jid: '5511999998888@s.whatsapp.net', id: '123456@lid' }]
  }
  const result = resolveIdentityForGroup(identity, meta)
  assert.equal(result.meLid, '123456@lid')
})

test('resolveIdentityForGroup does not overwrite an already resolved meLid', () => {
  const identity = { meRaw: 'x', meLid: 'existing@lid', mePn: '5511999998888@s.whatsapp.net' }
  const meta = {
    participants: [{ jid: '5511999998888@s.whatsapp.net', lid: 'other@lid' }]
  }
  const result = resolveIdentityForGroup(identity, meta)
  assert.equal(result.meLid, 'existing@lid')
})

test('disconnectReasonToText uses a known Baileys statusCode', () => {
  const error = { output: { statusCode: 401 } }
  assert.equal(disconnectReasonToText(error), 'loggedOut')
})

test('disconnectReasonToText uses a generic Error message', () => {
  assert.equal(disconnectReasonToText(new Error('boom')), 'boom')
})

test('disconnectReasonToText falls back to unknown', () => {
  assert.equal(disconnectReasonToText(undefined), 'unknown')
})

test('resolvePhone resolves from a plain remoteJid', async () => {
  const message = { key: { remoteJid: '5511999998888@s.whatsapp.net' } }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, '5511999998888')
})

test('resolvePhone falls back to key.senderPn when remoteJid is a @lid', async () => {
  const message = {
    key: {
      remoteJid: '156332632072321@lid',
      senderPn: '5511931507004@s.whatsapp.net'
    }
  }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, '5511931507004')
})

test('resolvePhone falls back to key.participantPn when senderPn is absent', async () => {
  const message = {
    key: {
      remoteJid: '156332632072321@lid',
      participantPn: '5511922223333@s.whatsapp.net'
    }
  }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, '5511922223333')
})

test('resolvePhone falls back to socket.signalRepository.lidMapping.getPNForLID for an unresolved @lid', async () => {
  const message = { key: { remoteJid: '156332632072321@lid' } }
  const socket = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async (lid) => {
          assert.equal(lid, '156332632072321@lid')
          return '5511977776666@s.whatsapp.net'
        }
      }
    }
  }
  const phone = await resolvePhone(socket, message)
  assert.equal(phone, '5511977776666')
})

test('resolvePhone returns null when nothing resolves', async () => {
  const message = { key: { remoteJid: '156332632072321@lid' } }
  const phone = await resolvePhone({}, message)
  assert.equal(phone, null)
})

test('resolvePhone returns null and does not throw when lidMapping.getPNForLID rejects', async () => {
  const message = { key: { remoteJid: '156332632072321@lid' } }
  const socket = {
    signalRepository: {
      lidMapping: {
        getPNForLID: async () => {
          throw new Error('boom')
        }
      }
    }
  }
  const phone = await resolvePhone(socket, message)
  assert.equal(phone, null)
})
