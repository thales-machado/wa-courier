'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  isDigitsOnly,
  isValidGroupJid,
  isUserJid,
  isLidJid,
  normalizePnJid,
  isValidBase64,
  isPrivateIp,
  parseByteSize,
  buildIpAllowList,
  isIpAllowed,
  parseCookies,
  signSessionToken,
  verifySessionToken,
  isRateLimited,
  isLoginRateLimited,
  loginRateLimitMax
} = require('../src/lib/utils')

test('isDigitsOnly', () => {
  assert.equal(isDigitsOnly('5511999998888'), true)
  assert.equal(isDigitsOnly('55119a9998888'), false)
  assert.equal(isDigitsOnly(''), false)
})

test('isValidGroupJid', () => {
  assert.equal(isValidGroupJid('123456-789@g.us'), true)
  assert.equal(isValidGroupJid('123456@s.whatsapp.net'), false)
})

test('isUserJid / isLidJid', () => {
  assert.equal(isUserJid('5511999998888@s.whatsapp.net'), true)
  assert.equal(isUserJid('123@lid'), false)
  assert.equal(isLidJid('123@lid'), true)
  assert.equal(isLidJid('123@s.whatsapp.net'), false)
})

test('normalizePnJid remove device suffix', () => {
  assert.equal(normalizePnJid('5511999998888:12@s.whatsapp.net'), '5511999998888@s.whatsapp.net')
  assert.equal(normalizePnJid('5511999998888@s.whatsapp.net'), '5511999998888@s.whatsapp.net')
  assert.equal(normalizePnJid('123@lid'), null)
  assert.equal(normalizePnJid(null), null)
})

test('isValidBase64', () => {
  assert.equal(isValidBase64(Buffer.from('hello').toString('base64')), true)
  assert.equal(isValidBase64('not-base64!!'), false)
  assert.equal(isValidBase64(''), false)
  assert.equal(isValidBase64('abc'), false) // length not a multiple of 4
})

test('parseByteSize accepts plain bytes and human-friendly units', () => {
  assert.equal(parseByteSize(20971520), 20971520)
  assert.equal(parseByteSize('20971520'), 20971520)
  assert.equal(parseByteSize('512B'), 512)
  assert.equal(parseByteSize('512kb'), 512 * 1024)
  assert.equal(parseByteSize('20MB'), 20 * 1024 * 1024)
  assert.equal(parseByteSize('1.5 GB'), Math.floor(1.5 * 1024 ** 3))
  assert.equal(parseByteSize(' 10 mb '), 10 * 1024 * 1024)
})

test('parseByteSize throws on unparseable values', () => {
  assert.throws(() => parseByteSize('20 megabytes'), /invalid_byte_size/)
  assert.throws(() => parseByteSize('MB'), /invalid_byte_size/)
  assert.throws(() => parseByteSize('-1MB'), /invalid_byte_size/)
  assert.throws(() => parseByteSize(''), /invalid_byte_size/)
  assert.throws(() => parseByteSize('1TB'), /invalid_byte_size/)
})

test('isPrivateIp blocks private/loopback/link-local ranges', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true)
  assert.equal(isPrivateIp('10.0.0.5'), true)
  assert.equal(isPrivateIp('172.16.0.1'), true)
  assert.equal(isPrivateIp('192.168.1.1'), true)
  assert.equal(isPrivateIp('169.254.169.254'), true) // cloud metadata
  assert.equal(isPrivateIp('::1'), true)
  assert.equal(isPrivateIp('fe80::1'), true)
  assert.equal(isPrivateIp('8.8.8.8'), false)
  assert.equal(isPrivateIp('not-an-ip'), true) // unknown: block as a precaution
})

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' })
  assert.deepEqual(parseCookies(undefined), {})
  assert.deepEqual(parseCookies('novalue'), {})
  // regression: malformed percent-encoding used to throw out of decodeURIComponent, turning
  // every request carrying such a cookie into a 500
  assert.deepEqual(parseCookies('bad=%zz; ok=1'), { ok: '1' })
})

test('signSessionToken / verifySessionToken', () => {
  const secret = 'test-secret'
  const expiresAt = Date.now() + 60_000
  const token = signSessionToken(secret, expiresAt)

  assert.equal(verifySessionToken(secret, token), true)
  assert.equal(verifySessionToken('wrong-secret', token), false)
  assert.equal(verifySessionToken(secret, 'garbage'), false)
  assert.equal(verifySessionToken(secret, signSessionToken(secret, Date.now() - 1000)), false)
})

test('isRateLimited blocks after the window limit is reached', () => {
  const ip = `test-ip-${Date.now()}-${Math.random()}`
  for (let i = 0; i < 30; i++) {
    assert.equal(isRateLimited(ip), false)
  }
  assert.equal(isRateLimited(ip), true)
})

test('isLoginRateLimited has its own budget, independent from the send limiter', () => {
  const ip = `test-login-ip-${Date.now()}-${Math.random()}`
  for (let i = 0; i < loginRateLimitMax; i++) {
    assert.equal(isLoginRateLimited(ip), false)
  }
  assert.equal(isLoginRateLimited(ip), true)
  // exhausting the login limiter must not affect the send-endpoint limiter for the same IP
  assert.equal(isRateLimited(ip), false)
})

test('buildIpAllowList returns null without entries', () => {
  assert.equal(buildIpAllowList([]), null)
  assert.equal(buildIpAllowList(undefined), null)
})

test('buildIpAllowList rejects an invalid CIDR', () => {
  assert.throws(() => buildIpAllowList(['not-an-ip/24']))
})

test('isIpAllowed matches IPv4 CIDR ranges', () => {
  const list = buildIpAllowList(['10.0.0.0/8', '203.0.113.5'])
  assert.equal(isIpAllowed(list, '10.1.2.3'), true)
  assert.equal(isIpAllowed(list, '203.0.113.5'), true)
  assert.equal(isIpAllowed(list, '203.0.113.6'), false)
  assert.equal(isIpAllowed(list, '8.8.8.8'), false)
})

test('isIpAllowed matches IPv6 CIDR ranges', () => {
  const list = buildIpAllowList(['fd00::/8'])
  assert.equal(isIpAllowed(list, 'fd00::1'), true)
  assert.equal(isIpAllowed(list, '2001:db8::1'), false)
})

test('isIpAllowed always allows loopback, even outside the configured range', () => {
  const list = buildIpAllowList(['203.0.113.0/24'])
  assert.equal(isIpAllowed(list, '127.0.0.1'), true)
  assert.equal(isIpAllowed(list, '::1'), true)
  assert.equal(isIpAllowed(list, '203.0.113.5'), true)
  assert.equal(isIpAllowed(list, '8.8.8.8'), false)
})

test('isIpAllowed allows everything when no list is configured', () => {
  assert.equal(isIpAllowed(null, '1.2.3.4'), true)
})
