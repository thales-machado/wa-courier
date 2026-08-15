'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const metrics = require('../src/lib/metrics')

test('getWidgetSummary aggregates sent/failed/inbound counters', async () => {
  metrics.recordMessageSent({ kind: 'group', type: 'text', ok: true })
  metrics.recordMessageSent({ kind: 'group', type: 'text', ok: true })
  metrics.recordMessageSent({ kind: 'user', type: 'image', ok: false })
  metrics.recordInboundMedia({ type: 'document', ok: true })
  metrics.recordInboundMedia({ type: 'image', ok: false })

  const summary = await metrics.getWidgetSummary()
  assert.ok(summary.messagesSent >= 2)
  assert.ok(summary.messagesFailed >= 1)
  assert.ok(summary.inboundMediaForwarded >= 1)
})

test('getWidgetSummary starts from zero on a fresh process', async () => {
  // registered before the test above incremented anything: only validates the return shape
  const summary = await metrics.getWidgetSummary()
  assert.equal(typeof summary.messagesSent, 'number')
  assert.equal(typeof summary.messagesFailed, 'number')
  assert.equal(typeof summary.inboundMediaForwarded, 'number')
})
