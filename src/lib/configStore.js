'use strict'

const { mkdir, readFile, writeFile } = require('node:fs/promises')
const config = require('../config')
const logger = require('./logger')

// All reads/writes against the data mount live here. Every function is forgiving on read —
// a missing or corrupt file yields an empty value rather than throwing, so a wiped volume
// (or a first boot) starts clean instead of crashing the process.

async function ensureDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true })
}

async function readConfigFile() {
  try {
    const raw = await readFile(config.configPath, 'utf8')
    return JSON.parse(raw)
  } catch (error) {
    // ENOENT is the expected first-boot/wiped-volume case — anything else means the file
    // exists but is unreadable/corrupt, which is worth a trace even though we still start clean
    if (error.code !== 'ENOENT') logger.warn({ error: error.message }, 'config.json unreadable, starting empty')
    return {}
  }
}

async function writeConfigFile(value) {
  await ensureDirectory(config.dataDir)
  await writeFile(config.configPath, JSON.stringify(value, null, 2), 'utf8')
}

async function readRecentLog(logPath, limit) {
  try {
    const raw = await readFile(logPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    return lines
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse()
  } catch (_error) {
    return []
  }
}

module.exports = { ensureDirectory, readConfigFile, writeConfigFile, readRecentLog }
