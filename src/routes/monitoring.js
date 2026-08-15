'use strict'

const metrics = require('../lib/metrics')

async function monitoringRoutes(app, { courier, accessControl }) {
  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metrics.register.contentType)
    return metrics.register.metrics()
  })

  // liveness: process is up, regardless of the session state
  app.get('/health', async () => {
    const state = courier.getSessionState()
    return {
      status: 'ok',
      session: {
        connected: state.connected,
        state: state.state,
        paired: state.paired
      }
    }
  })

  // readiness: only ready once the session is connected
  app.get('/health/ready', async (_request, reply) => {
    const state = courier.getSessionState()
    if (!state.connected) {
      return reply.code(503).send({ status: 'not_ready', session: state })
    }
    return { status: 'ready', session: state }
  })

  // compact summary meant for external widgets (e.g. Homepage/Homarr) — avoids building a
  // dashboard into this UI just to duplicate what Grafana already shows
  app.get('/widget', async (request, reply) => {
    await accessControl.requireAuth(request, reply)
    if (reply.sent) return
    const state = courier.getSessionState()
    const summary = await metrics.getWidgetSummary()
    return {
      status: state.connected ? 'connected' : 'disconnected',
      state: state.state,
      ...summary
    }
  })
}

module.exports = monitoringRoutes
