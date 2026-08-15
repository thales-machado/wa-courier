'use strict'

const { readFile } = require('node:fs/promises')
const path = require('node:path')
const config = require('../config')

const staticCache = new Map()
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml'
}

async function serveStatic(reply, fileName) {
  let content = staticCache.get(fileName)
  if (!content) {
    content = await readFile(path.join(config.publicDir, fileName))
    staticCache.set(fileName, content)
  }
  const ext = path.extname(fileName)
  return reply.type(mimeTypes[ext] || 'application/octet-stream').send(content)
}

module.exports = { serveStatic }
