// runs before paint (loaded synchronously in <head>, no defer/async) to avoid a flash of the
// wrong theme — kept as its own tiny file instead of inline so the CSP can skip 'unsafe-inline'
;(() => {
  var saved = localStorage.getItem('wac-theme')
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light')
})()
