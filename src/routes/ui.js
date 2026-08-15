'use strict'

const { serveStatic } = require('../lib/staticAssets')

async function uiRoutes(app, { accessControl }) {
  app.get('/', async (request, reply) => {
    if (!accessControl.hasValidWebSession(request)) return reply.redirect('/login')
    return serveStatic(reply, 'app.html')
  })

  app.get('/login', async (_request, reply) => serveStatic(reply, 'login.html'))
  app.get('/assets/app.css', async (_request, reply) => serveStatic(reply, 'app.css'))
  app.get('/assets/app.js', async (_request, reply) => serveStatic(reply, 'app.js'))
  app.get('/assets/theme-init.js', async (_request, reply) => serveStatic(reply, 'theme-init.js'))
  app.get('/assets/login.js', async (_request, reply) => serveStatic(reply, 'login.js'))
  app.get('/favicon.svg', async (_request, reply) => serveStatic(reply, 'favicon.svg'))

  // compat: legacy QR route redirects to the UI
  app.get('/session/qr', async (_request, reply) => reply.redirect('/'))
}

module.exports = uiRoutes
