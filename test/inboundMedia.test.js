'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { extractInboundMedia, getDeclaredMediaSize } = require('../src/lib/inboundMedia')

test('extractInboundMedia returns null without message content', () => {
  assert.equal(extractInboundMedia({}), null)
  assert.equal(extractInboundMedia({ message: null }), null)
})

test('extractInboundMedia returns null for text-only messages', () => {
  const message = { message: { conversation: 'hello' } }
  assert.equal(extractInboundMedia(message), null)
})

test('extractInboundMedia extracts a plain documentMessage', () => {
  const message = {
    message: {
      documentMessage: { mimetype: 'application/pdf', fileName: 'invoice.pdf', caption: 'here' }
    }
  }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'document',
    mimetype: 'application/pdf',
    fileName: 'invoice.pdf',
    caption: 'here'
  })
})

test('extractInboundMedia extracts a documentWithCaptionMessage', () => {
  const message = {
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'report.pdf' }
        }
      }
    }
  }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'document',
    mimetype: 'application/pdf',
    fileName: 'report.pdf',
    caption: null
  })
})

test('extractInboundMedia extracts an imageMessage and derives a file name', () => {
  const message = { message: { imageMessage: { mimetype: 'image/png' } } }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'image',
    mimetype: 'image/png',
    fileName: 'image.png',
    caption: null
  })
})

test('extractInboundMedia falls back to defaults for missing document fields', () => {
  const message = { message: { documentMessage: {} } }
  assert.deepEqual(extractInboundMedia(message), {
    type: 'document',
    mimetype: 'application/octet-stream',
    fileName: 'document',
    caption: null
  })
})

test('getDeclaredMediaSize reads a plain number fileLength', () => {
  const message = { message: { documentMessage: { fileLength: 12345 } } }
  assert.equal(getDeclaredMediaSize(message), 12345)
})

test('getDeclaredMediaSize reads a Long-like fileLength via toNumber', () => {
  const message = { message: { imageMessage: { fileLength: { toNumber: () => 99999 } } } }
  assert.equal(getDeclaredMediaSize(message), 99999)
})

test('getDeclaredMediaSize returns null when absent', () => {
  assert.equal(getDeclaredMediaSize({ message: { documentMessage: {} } }), null)
  assert.equal(getDeclaredMediaSize({}), null)
})
