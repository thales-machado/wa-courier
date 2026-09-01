'use strict'

const $ = (id) => document.getElementById(id)
let groupsCache = []
let showErrorsOnly = localStorage.getItem('wac-recent-errors-only') !== 'false'
let lastRecentData = []
let recentSearchQuery = ''
let inboundShowErrorsOnly = localStorage.getItem('wac-inbound-errors-only') !== 'false'
let lastInboundRecentData = []
let inboundRecentSearchQuery = ''
let disconnectedSince = null
let lastQrImage = null
let qrReceivedAt = null
// conservative fallback until /ui-config loads the real WAC_MEDIA_MAX_BYTES value
let serverMediaMaxBytes = 8 * 1024 * 1024

function toast(msg) {
  const el = $('toast')
  el.textContent = msg
  el.classList.add('show')
  setTimeout(() => el.classList.remove('show'), 2200)
}

async function api(path, opts = {}) {
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {}
  const res = await fetch(path, { headers, ...opts })
  if (res.status === 401) {
    window.location.href = '/login'
    throw new Error('unauthorized')
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error || res.statusText), { body })
  return body
}

// ---------- button loading state ----------
async function withLoading(button, fn) {
  if (button.disabled) return
  const original = button.textContent
  button.disabled = true
  button.textContent = '…'
  try {
    return await fn()
  } finally {
    button.disabled = false
    button.textContent = original
  }
}

// ---------- session / QR ----------
async function refreshSession() {
  try {
    const s = await api('/session/qr-data')
    const st = $('badge-state')
    st.textContent = `state: ${s.state}`
    st.className = `badge ${s.state === 'open' ? 'ok' : s.state === 'connecting' ? 'warn' : 'bad'}`

    const conn = $('badge-connected')
    conn.textContent = s.connected ? 'connected' : 'disconnected'
    conn.className = `badge ${s.connected ? 'ok' : 'bad'}`

    $('session-info').innerHTML =
      (s.me ? `Session: <b>${escapeHtml(s.me.split(':')[0].split('@')[0])}</b><br>` : '') +
      (s.lastDisconnectReason ? `Last disconnect: <b>${escapeHtml(s.lastDisconnectReason)}</b>` : '')

    const qrBox = $('qr-box')
    if (s.qrImage && !s.connected) {
      if (s.qrImage !== lastQrImage) {
        lastQrImage = s.qrImage
        qrReceivedAt = Date.now()
      }
      $('qr-img').src = s.qrImage
      qrBox.classList.remove('hidden')
    } else {
      lastQrImage = null
      qrReceivedAt = null
      qrBox.classList.add('hidden')
    }

    updateConnectionBanner(s.connected)
  } catch (_e) {
    /* keep last known state */
  }
}

function updateConnectionBanner(connected) {
  const banner = $('conn-banner')
  if (connected) {
    disconnectedSince = null
    banner.classList.add('hidden')
    return
  }
  if (!disconnectedSince) disconnectedSince = Date.now()
  const downForMs = Date.now() - disconnectedSince
  if (downForMs > 30000) {
    const downForSec = Math.round(downForMs / 1000)
    banner.textContent = `WhatsApp session disconnected for ${downForSec}s — check the QR code below.`
    banner.classList.remove('hidden')
  } else {
    banner.classList.add('hidden')
  }
}

function updateQrFreshness() {
  const el = $('qr-freshness')
  if (!el) return
  if (!qrReceivedAt) {
    el.textContent = ''
    return
  }
  const ageSec = Math.round((Date.now() - qrReceivedAt) / 1000)
  el.textContent =
    ageSec > 25 ? `Code may be stale (${ageSec}s) — waiting for automatic refresh...` : `Code refreshed ${ageSec}s ago`
}

// ---------- directory ----------
function renderDir(items) {
  const list = $('dir-list')
  if (!items.length) {
    list.innerHTML = `
      <div class="dir-empty">
        No results.<br>
        <button class="btn btn-sm" id="btn-dir-goto-qr" type="button">Go to session / QR</button>
      </div>`
    bindDirEmptyShortcut()
    return
  }
  list.innerHTML = items
    .map(
      (i) => `
    <div class="dir-item">
      <div class="info">
        <div class="dir-item-top">
          <div class="name">${escapeHtml(i.name)}</div>
          <span class="tag">${i.kind === 'group' ? `GROUP${i.size ? ` · ${i.size}` : ''}` : 'CONTACT'}</span>
        </div>
        <div class="jid">${escapeHtml(i.jid)}</div>
      </div>
      <div class="dir-item-actions">
        <button class="btn btn-sm" data-copy="${escapeHtml(i.jid)}">Copy JID</button>
        <button class="btn btn-sm" data-use="${escapeHtml(i.jid)}">Use in Send</button>
        ${i.kind === 'group' ? `<button class="btn btn-sm" data-enable-inbound="${escapeHtml(i.jid)}">Enable inbound</button>` : ''}
      </div>
    </div>`
    )
    .join('')

  list.querySelectorAll('[data-copy]').forEach((b) => {
    b.addEventListener('click', () => {
      navigator.clipboard
        .writeText(b.dataset.copy)
        .then(() => toast('JID copied!'))
        .catch(() => toast('Clipboard unavailable — copy manually'))
    })
  })
  list.querySelectorAll('[data-use]').forEach((b) => {
    b.addEventListener('click', () => {
      $('send-to').value = b.dataset.use
      $('send-to').focus()
      $('card-send').scrollIntoView({ behavior: 'smooth', block: 'start' })
      toast('Destination filled in')
      checkSendToDestination()
    })
  })
  list.querySelectorAll('[data-enable-inbound]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api('/inbound-media/groups', {
          method: 'POST',
          body: JSON.stringify({ groupJid: b.dataset.enableInbound })
        })
        toast('Group enabled for inbound media')
        loadInboundGroups()
      } catch (e) {
        toast(`Error: ${e.body?.message || e.message}`)
      }
    })
  })
}

function bindDirEmptyShortcut() {
  const btn = $('btn-dir-goto-qr')
  if (btn) btn.addEventListener('click', () => showSection('session'))
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function loadGroups() {
  try {
    const data = await api('/groups')
    groupsCache = (data.groups || []).map((g) => ({
      kind: 'group',
      jid: g.jid,
      name: g.subject || '(no name)',
      size: g.size
    }))
    runDirFilter()
  } catch (e) {
    $('dir-list').innerHTML =
      `<div class="dir-empty">${e.message === 'session_not_connected' || e.message === 'session_not_paired' ? 'Session not connected — scan the QR code first.' : `Error: ${escapeHtml(e.message)}`}</div>`
  }
}

let resolveTimer = null
let dirFilterTimer = null
function applyDirFilter() {
  clearTimeout(dirFilterTimer)
  dirFilterTimer = setTimeout(runDirFilter, 200)
}

function runDirFilter() {
  const q = $('dir-search').value.trim()
  const digits = q.replace(/\D/g, '')

  const filtered = groupsCache.filter((g) => !q || g.name.toLowerCase().includes(q.toLowerCase()))

  // if it looks like a phone number, also try resolving a contact
  if (digits.length >= 8 && /^[\d\s()+-]+$/.test(q)) {
    renderDir(filtered)
    clearTimeout(resolveTimer)
    resolveTimer = setTimeout(async () => {
      try {
        const r = await api(`/contacts/resolve?number=${encodeURIComponent(digits)}`)
        if (r.exists) {
          renderDir([{ kind: 'user', jid: r.jid, name: `+${r.number}` }, ...filtered])
        } else {
          renderDir([{ kind: 'user', jid: '(not on WhatsApp)', name: `+${digits}` }, ...filtered])
        }
      } catch (_e) {
        /* silent */
      }
    }, 600)
  } else {
    renderDir(filtered)
  }
}

// ---------- sending ----------
let attachedFile = null // { base64, mimetype, name, kind }

function detectMediaKind(mimetype) {
  if (mimetype.startsWith('image/')) return 'image'
  if (mimetype.startsWith('video/')) return 'video'
  if (mimetype.startsWith('audio/')) return 'audio'
  return 'document'
}

function setAttachment(file) {
  if (!file) return
  // mirrors the server's WAC_MEDIA_MAX_BYTES cap (via /ui-config), so the client neither
  // accepts a file the server would 413 nor blocks one it would take
  if (file.size > serverMediaMaxBytes) {
    toast(`File too large (max. ${Math.floor(serverMediaMaxBytes / (1024 * 1024))} MB)`)
    return
  }
  const kind = detectMediaKind(file.type || '')
  const reader = new FileReader()
  reader.onload = () => {
    const dataUrl = reader.result
    attachedFile = {
      base64: dataUrl.split(',')[1],
      mimetype: file.type || 'application/octet-stream',
      name: file.name || (kind === 'image' ? 'pasted image' : 'file'),
      kind
    }
    $('attach-img').src = kind === 'image' ? dataUrl : ''
    $('attach-img').classList.toggle('hidden', kind !== 'image')
    $('attach-kind').textContent = kind.toUpperCase()
    $('attach-name').textContent = `${attachedFile.name} · ${(file.size / 1024).toFixed(0)} KB`
    $('attach-preview').classList.remove('hidden')
    $('attach-hint').classList.add('hidden')
    $('send-image').value = ''
    $('send-image').disabled = true
  }
  reader.readAsDataURL(file)
}

function clearAttachment() {
  attachedFile = null
  $('attach-preview').classList.add('hidden')
  $('attach-hint').classList.remove('hidden')
  $('attach-img').src = ''
  $('attach-img').classList.remove('hidden')
  $('send-image').disabled = false
}

async function sendMessage() {
  const to = $('send-to').value.trim()
  const text = $('send-text').value.trim()
  const imageUrl = $('send-image').value.trim()
  const out = $('send-result')
  out.classList.add('hidden')

  if (!to || (!text && !imageUrl && !attachedFile)) {
    toast('Fill in destination and text/image')
    return
  }

  try {
    let res
    if (attachedFile) {
      res = await api('/messages/media', {
        method: 'POST',
        body: JSON.stringify({
          to,
          type: attachedFile.kind,
          mediaBase64: attachedFile.base64,
          mimetype: attachedFile.mimetype,
          fileName: attachedFile.kind === 'document' ? attachedFile.name : undefined,
          caption: attachedFile.kind !== 'audio' ? text || undefined : undefined
        })
      })
    } else if (imageUrl) {
      res = await api('/messages/media', {
        method: 'POST',
        body: JSON.stringify({ to, type: 'image', mediaUrl: imageUrl, caption: text || undefined })
      })
    } else if (to.endsWith('@g.us')) {
      res = await api('/messages/group/text', { method: 'POST', body: JSON.stringify({ groupJid: to, text }) })
    } else {
      res = await api('/messages/text', { method: 'POST', body: JSON.stringify({ to, text }) })
    }
    out.textContent = res.queued
      ? '⏳ Queued — check Sent Messages for delivery status'
      : `✔ Sent — id ${res.messageId}`
    out.className = 'send-result ok'
    clearAttachment()
    loadRecent()
  } catch (e) {
    out.textContent = `✖ ${e.body?.message || e.message}`
    out.className = 'send-result err'
  }
  out.classList.remove('hidden')
}

// ---------- destination preview ----------
let sendToTimer = null
function checkSendToDestination() {
  const el = $('send-to-status')
  const value = $('send-to').value.trim()
  const digits = value.replace(/\D/g, '')

  clearTimeout(sendToTimer)

  if (value.endsWith('@g.us') || value.endsWith('@s.whatsapp.net') || value.endsWith('@lid')) {
    el.textContent = 'JID provided directly'
    el.className = 'send-to-status'
    return
  }

  if (digits.length < 8) {
    el.textContent = ''
    el.className = 'send-to-status'
    return
  }

  el.textContent = 'checking...'
  el.className = 'send-to-status'
  sendToTimer = setTimeout(async () => {
    try {
      const r = await api(`/contacts/resolve?number=${encodeURIComponent(digits)}`)
      el.textContent = r.exists ? '✓ Number exists on WhatsApp' : '✗ Number not found on WhatsApp'
      el.className = `send-to-status ${r.exists ? 'ok' : 'err'}`
    } catch (_e) {
      el.textContent = ''
    }
  }, 600)
}

// ---------- recent sends ----------
function renderRecent() {
  const q = recentSearchQuery.trim().toLowerCase()
  const rows = lastRecentData
    // a queued message hasn't failed, so the errors filter shouldn't swallow it either way
    .filter((m) => !showErrorsOnly || (!m.ok && !m.queued))
    .filter(
      (m) =>
        !q ||
        String(m.to || '')
          .toLowerCase()
          .includes(q)
    )
    .map(
      (m) => `
      <tr>
        <td>${new Date(m.ts).toLocaleString('en-US')}</td>
        <td>${m.sentAt ? new Date(m.sentAt).toLocaleString('en-US') : '—'}</td>
        <td>${escapeHtml(m.to)}</td>
        <td>${escapeHtml(m.type)}</td>
        <td class="${m.queued ? 'text-muted' : m.ok ? 'ok' : 'err'}">${m.queued ? 'queued…' : m.ok ? 'ok' : escapeHtml(m.error || 'failed')}</td>
        <td>${escapeHtml(m.messageId || '—')}</td>
      </tr>`
    )
    .join('')
  $('recent-body').innerHTML =
    rows ||
    `<tr><td colspan="6" class="text-muted">${showErrorsOnly || q ? 'No matching sends.' : 'No messages sent yet.'}</td></tr>`
}

async function loadRecent() {
  try {
    const data = await api('/messages/recent')
    lastRecentData = data.messages || []
    renderRecent()
  } catch (_e) {
    /* silent */
  }
}

// ---------- top bar actions ----------
$('btn-logout-web').addEventListener('click', async () => {
  try {
    await api('/auth/web-logout', { method: 'POST' })
  } catch (_e) {
    /* redirect anyway */
  }
  window.location.href = '/login'
})

$('btn-logout-wa').addEventListener('click', async (e) => {
  if (!confirm('Disconnect the WhatsApp session? You will need to scan the QR code again.')) return
  await withLoading(e.currentTarget, async () => {
    try {
      await api('/session/logout', { method: 'POST' })
      toast('Session disconnected — waiting for new QR code')
      setTimeout(refreshSession, 3000)
    } catch (err) {
      toast(`Error: ${err.message}`)
    }
  })
})

// the key is owned by the WAC_API_KEY env var, so there is nothing on the server to reveal or
// rotate — this only reports whether one is configured and helps you mint a value to paste there
async function refreshApiKeyStatus() {
  try {
    const r = await api('/auth/api-key-status')
    $('api-key-status').textContent = r.configured ? 'API key: configured' : 'API key: not configured'
    $('api-key-hint').textContent = r.configured
      ? 'Managed via the WAC_API_KEY environment variable. To rotate it, edit your .env and restart.'
      : 'The HTTP API is closed. Set WAC_API_KEY in your .env and restart to enable it.'
  } catch (_e) {
    /* keep last known state */
  }
}

$('btn-generate-key').addEventListener('click', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const key = `wac_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
  navigator.clipboard
    .writeText(key)
    .then(() => {
      $('api-key-hint').textContent = `Copied. Put this in your .env as WAC_API_KEY and restart: ${key}`
      toast('Key generated and copied!')
    })
    // the key stays visible in the hint, so a failed clipboard write is not a dead end
    .catch(() => {
      $('api-key-hint').textContent = `Clipboard unavailable — copy manually and set WAC_API_KEY: ${key}`
      toast('Copy the key from the hint below')
    })
})

// ---------- theme ----------
function applyThemeButtonLabel() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  const btn = $('btn-theme-toggle')
  btn.setAttribute('aria-label', isLight ? 'Switch to dark theme' : 'Switch to light theme')
  btn.innerHTML = isLight
    ? '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>'
    : '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>'
}

$('btn-theme-toggle').addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  if (isLight) {
    document.documentElement.removeAttribute('data-theme')
    localStorage.setItem('wac-theme', 'dark')
  } else {
    document.documentElement.setAttribute('data-theme', 'light')
    localStorage.setItem('wac-theme', 'light')
  }
  applyThemeButtonLabel()
})

applyThemeButtonLabel()

$('btn-send').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, sendMessage)
})
$('btn-dir-refresh').addEventListener('click', async (e) => {
  await withLoading(e.currentTarget, loadGroups)
})
$('dir-search').addEventListener('input', applyDirFilter)
$('send-to').addEventListener('input', checkSendToDestination)

$('send-text').addEventListener('input', () => {
  $('send-text-count').textContent = String($('send-text').value.length)
})

function applyErrorsOnlyButtonLabel() {
  $('btn-recent-errors-only').textContent = showErrorsOnly ? 'Showing errors only' : 'Show errors only'
  $('btn-recent-errors-only').classList.toggle('btn-filter-active', showErrorsOnly)
}

$('btn-recent-errors-only').addEventListener('click', () => {
  showErrorsOnly = !showErrorsOnly
  localStorage.setItem('wac-recent-errors-only', String(showErrorsOnly))
  applyErrorsOnlyButtonLabel()
  renderRecent()
})

$('recent-search').addEventListener('input', () => {
  recentSearchQuery = $('recent-search').value
  renderRecent()
})

applyErrorsOnlyButtonLabel()

// ---------- image attachment (file / paste / drag&drop) ----------
const attachZone = $('attach-zone')
attachZone.addEventListener('click', (e) => {
  if (e.target.id !== 'btn-attach-clear') $('attach-file').click()
})
$('attach-file').addEventListener('change', (e) => setAttachment(e.target.files[0]))
$('btn-attach-clear').addEventListener('click', (e) => {
  e.stopPropagation()
  clearAttachment()
})

attachZone.addEventListener('dragover', (e) => {
  e.preventDefault()
  attachZone.classList.add('dragging')
})
attachZone.addEventListener('dragleave', () => attachZone.classList.remove('dragging'))
attachZone.addEventListener('drop', (e) => {
  e.preventDefault()
  attachZone.classList.remove('dragging')
  setAttachment(e.dataTransfer.files[0])
})

document.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'))
  if (item) {
    setAttachment(item.getAsFile())
    toast('Image pasted!')
  }
})

// ---------- inbound media webhook ----------
function renderInboundGroups(groups, webhookConfigured) {
  const list = $('inbound-groups-list')
  if (!groups.length) {
    list.innerHTML =
      '<div class="dir-empty">No groups enabled. Images and documents from these groups are downloaded and forwarded to the configured webhook.</div>'
  } else {
    list.innerHTML = groups
      .map(
        (jid) => `
      <div class="dir-item">
        <div class="info"><div class="jid">${escapeHtml(jid)}</div></div>
        <button class="btn btn-sm btn-danger" data-remove-group="${escapeHtml(jid)}">Remove</button>
      </div>`
      )
      .join('')

    list.querySelectorAll('[data-remove-group]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await api(`/inbound-media/groups/${encodeURIComponent(b.dataset.removeGroup)}`, { method: 'DELETE' })
          toast('Group removed')
          loadInboundGroups()
        } catch (e) {
          toast(`Error: ${e.message}`)
        }
      })
    })
  }

  $('inbound-webhook-warning').classList.toggle('hidden', !(groups.length > 0 && !webhookConfigured))
}

async function loadInboundGroups() {
  try {
    const data = await api('/inbound-media/groups')
    renderInboundGroups(data.groups || [], Boolean(data.webhookConfigured))
  } catch (_e) {
    /* silent */
  }
}

$('btn-inbound-group-add').addEventListener('click', async () => {
  const jid = $('inbound-group-input').value.trim()
  if (!jid) return
  try {
    await api('/inbound-media/groups', { method: 'POST', body: JSON.stringify({ groupJid: jid }) })
    $('inbound-group-input').value = ''
    toast('Group enabled for inbound media')
    loadInboundGroups()
  } catch (e) {
    toast(`Error: ${e.body?.message || e.message}`)
  }
})

function renderInboundRecent() {
  const q = inboundRecentSearchQuery.trim().toLowerCase()
  const rows = lastInboundRecentData
    .filter((m) => !inboundShowErrorsOnly || !m.ok)
    .filter(
      (m) =>
        !q ||
        [m.groupJid, m.sender, m.fileName].some((v) =>
          String(v || '')
            .toLowerCase()
            .includes(q)
        )
    )
    .map(
      (m) => `
      <tr>
        <td>${new Date(m.ts).toLocaleString('en-US')}</td>
        <td class="jid">${escapeHtml(m.groupJid)}</td>
        <td class="jid">${escapeHtml(m.sender)}</td>
        <td>${escapeHtml(m.type)}</td>
        <td>${escapeHtml(m.fileName)}</td>
        <td class="${m.ok ? 'ok' : 'err'}">${m.ok ? 'forwarded' : escapeHtml(m.error || 'failed')}</td>
      </tr>`
    )
    .join('')
  $('inbound-recent-body').innerHTML =
    rows ||
    `<tr><td colspan="6" class="text-muted">${inboundShowErrorsOnly || q ? 'No matching inbound media.' : 'No inbound media yet.'}</td></tr>`
}

async function loadInboundRecent() {
  try {
    const data = await api('/inbound-media/recent')
    lastInboundRecentData = data.messages || []
    renderInboundRecent()
  } catch (_e) {
    /* silent */
  }
}

function applyInboundErrorsOnlyButtonLabel() {
  $('btn-inbound-recent-errors-only').textContent = inboundShowErrorsOnly ? 'Showing errors only' : 'Show errors only'
  $('btn-inbound-recent-errors-only').classList.toggle('btn-filter-active', inboundShowErrorsOnly)
}

$('btn-inbound-recent-errors-only').addEventListener('click', () => {
  inboundShowErrorsOnly = !inboundShowErrorsOnly
  localStorage.setItem('wac-inbound-errors-only', String(inboundShowErrorsOnly))
  applyInboundErrorsOnlyButtonLabel()
  renderInboundRecent()
})

$('inbound-recent-search').addEventListener('input', () => {
  inboundRecentSearchQuery = $('inbound-recent-search').value
  renderInboundRecent()
})

applyInboundErrorsOnlyButtonLabel()

// ---------- inline group picker (shared by Send destination and Inbound Media group input) ----------
// avoids round-tripping to the Directory just to paste a group JID — filters the already-loaded
// groupsCache, no extra server call
function bindGroupPicker(inputEl, listEl, onPick) {
  function render(query) {
    const q = query.trim().toLowerCase()
    const matches = q ? groupsCache.filter((g) => g.name.toLowerCase().includes(q)).slice(0, 8) : []
    if (!matches.length) {
      listEl.classList.add('hidden')
      listEl.innerHTML = ''
      return
    }
    listEl.innerHTML = matches
      .map(
        (g) => `
      <div class="autocomplete-item" data-jid="${escapeHtml(g.jid)}">
        <span>${escapeHtml(g.name)}</span>
        <span class="jid">${escapeHtml(g.jid)}</span>
      </div>`
      )
      .join('')
    listEl.classList.remove('hidden')
    listEl.querySelectorAll('[data-jid]').forEach((el) => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault() // runs before the input blur, otherwise the list hides before the click lands
        onPick(el.dataset.jid)
        listEl.classList.add('hidden')
      })
    })
  }

  inputEl.addEventListener('input', () => render(inputEl.value))
  inputEl.addEventListener('focus', () => {
    if (inputEl.value.trim()) render(inputEl.value)
  })
  inputEl.addEventListener('blur', () => setTimeout(() => listEl.classList.add('hidden'), 100))
}

bindGroupPicker($('send-to'), $('send-to-suggestions'), (jid) => {
  $('send-to').value = jid
  checkSendToDestination()
})

bindGroupPicker($('inbound-group-input'), $('inbound-group-suggestions'), (jid) => {
  $('inbound-group-input').value = jid
})

// ---------- sidebar navigation ----------
const sidebarSections = ['session', 'messaging', 'logs']

function showSection(name) {
  if (!sidebarSections.includes(name)) name = 'session'
  for (const s of sidebarSections) {
    $(`view-${s}`).hidden = s !== name
  }
  document.querySelectorAll('.nav-item[data-section]').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === name)
  })
  localStorage.setItem('wac-active-section', name)
}

document.querySelectorAll('.nav-item[data-section]').forEach((el) => {
  el.addEventListener('click', () => showSection(el.dataset.section))
})

showSection(localStorage.getItem('wac-active-section') || 'session')

// ---------- init ----------
async function loadUiConfig() {
  try {
    const c = await api('/ui-config')
    if (Number.isFinite(c.mediaMaxBytes) && c.mediaMaxBytes > 0) serverMediaMaxBytes = c.mediaMaxBytes
  } catch (_e) {
    /* keep the conservative fallback */
  }
}

loadUiConfig()
refreshSession()
refreshApiKeyStatus()
loadGroups()
loadRecent()
loadInboundGroups()
loadInboundRecent()
setInterval(refreshSession, 5000)
setInterval(loadRecent, 30000)
setInterval(loadInboundRecent, 30000)
setInterval(updateQrFreshness, 1000)
