'use strict'

const client = require('prom-client')

const register = new client.Registry()
client.collectDefaultMetrics({ register })

const messagesSentTotal = new client.Counter({
  name: 'wa_courier_messages_sent_total',
  help: 'Total messages sent by the gateway, by type and status',
  labelNames: ['kind', 'type', 'status'],
  registers: [register]
})

const connectionStateGauge = new client.Gauge({
  name: 'wa_courier_connected',
  help: '1 if the WhatsApp session is connected, 0 otherwise',
  registers: [register]
})

const messageAckTotal = new client.Counter({
  name: 'wa_courier_message_ack_total',
  help: 'Total delivery status updates received for sent messages, by status',
  labelNames: ['status'],
  registers: [register]
})

const inboundMediaTotal = new client.Counter({
  name: 'wa_courier_inbound_media_total',
  help: 'Total inbound media messages processed from allowed groups, by type and status',
  labelNames: ['type', 'status'],
  registers: [register]
})

const sendQueueDepth = new client.Gauge({
  name: 'wa_courier_send_queue_depth',
  help: 'Messages accepted but not yet handed to WhatsApp (queued plus the one in flight)',
  registers: [register]
})

const sendQueueRejectedTotal = new client.Counter({
  name: 'wa_courier_send_queue_rejected_total',
  help: 'Sends refused because the queue was at capacity',
  registers: [register]
})

// read at scrape time instead of pushed on every change: the depth is only interesting when
// someone asks, and this can't drift out of sync with the queue
function trackSendQueueDepth(getDepth) {
  sendQueueDepth.collect = function collect() {
    this.set(getDepth())
  }
}

function recordSendQueueRejected() {
  sendQueueRejectedTotal.inc()
}

function recordMessageSent({ kind, type, ok }) {
  messagesSentTotal.inc({ kind: kind || 'unknown', type: type || 'unknown', status: ok ? 'ok' : 'error' })
}

function recordMessageAck(status) {
  messageAckTotal.inc({ status: status || 'unknown' })
}

function recordInboundMedia({ type, ok }) {
  inboundMediaTotal.inc({ type: type || 'unknown', status: ok ? 'ok' : 'error' })
}

function setConnected(connected) {
  connectionStateGauge.set(connected ? 1 : 0)
}

async function sumCounterValues(counter, predicate) {
  const data = await counter.get()
  return data.values.reduce((sum, v) => (!predicate || predicate(v.labels) ? sum + v.value : sum), 0)
}

// compact summary for external consumption (e.g. a Homepage-style dashboard widget) — numbers are
// cumulative since the last process restart, not "today": there is no date bucketing, that's Grafana's job
async function getWidgetSummary() {
  const [messagesSent, messagesFailed, inboundMediaForwarded] = await Promise.all([
    sumCounterValues(messagesSentTotal, (l) => l.status === 'ok'),
    sumCounterValues(messagesSentTotal, (l) => l.status === 'error'),
    sumCounterValues(inboundMediaTotal, (l) => l.status === 'ok')
  ])
  return { messagesSent, messagesFailed, inboundMediaForwarded }
}

module.exports = {
  register,
  recordMessageSent,
  recordMessageAck,
  recordInboundMedia,
  setConnected,
  getWidgetSummary,
  trackSendQueueDepth,
  recordSendQueueRejected
}
