'use strict'

// Hand-rolled instead of a dependency (e.g. @fastify/helmet) to keep the project's
// zero-extra-framework footprint — this is four header lines, not worth a package.
// CSP has no 'unsafe-inline': the UI ships no inline <script>/style="" (see src/public),
// so a strict policy works without weakening it for the app's own markup.
function registerSecurityHeaders(app) {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'"
    )
    return payload
  })
}

module.exports = { registerSecurityHeaders }
