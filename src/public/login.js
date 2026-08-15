'use strict'

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('login-error')
  err.classList.add('hidden')
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: document.getElementById('username').value,
      password: document.getElementById('password').value
    })
  })
  if (res.ok) {
    window.location.href = '/'
    return
  }
  const body = await res.json().catch(() => ({}))
  err.textContent = body.message || 'Invalid credentials'
  err.classList.remove('hidden')
})
