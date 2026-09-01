# Directory Badge Layout & UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Directory card badge/title overlap (P0), decouple the mobile sidebar footer from the nav (P1), and apply two small motion-polish fixes (P3: `.icon-btn` active feedback, toast entrance) flagged by the approved UX audit.

**Architecture:** Pure CSS/HTML restructuring inside `src/public/app.css` and `src/public/app.js`. No new JS logic, no new files. The `.dir-item` becomes a two-row flex layout (top row: name + badge pinned top-right; bottom row: JID + actions) instead of the current stacked-column layout with an inline badge.

**Tech Stack:** Vanilla CSS/HTML/JS (no build step, no framework).

**Spec:** Diagnostic report delivered this session (impeccable audit + emil-design-eng animation review), approved by user. No separate spec file — findings summarized in Global Constraints below.

## Global Constraints
- Group name emoji must render exactly as returned by the API — do not touch `escapeHtml()` (`app.js:183-189`), it already only escapes `&<>"'`.
- Badge (`GROUP · N` / `CONTACT`) moves to the top-right corner of `.dir-item`, vertically aligned above the "Enable inbound" button — not inline with the name text.
- Only animate `transform`/`opacity` (perf rule); keep existing `prefers-reduced-motion` handling on `.badge.warn` untouched.
- No UI test framework in this project — validate visually with Playwright (temp local static server, delete all screenshots/servers after).
- `npm run lint && npm test` must pass before considering any task done.

---

### Task 1: Restructure `.dir-item` layout (P0 — badge/title overlap)

**Files:**
- Modify: `src/public/app.js:131-135` (`renderDir` item template)
- Modify: `src/public/app.css:585-623` (`.dir-item`, `.dir-item .name`, `.tag`, `.dir-item .name .tag`, `.dir-item .jid`)

**Interfaces:**
- Consumes: `i.name`, `i.kind`, `i.size`, `i.jid` from the existing `groupsCache`/resolve item shape (unchanged).
- Produces: new DOM structure — `.dir-item` gets a `.dir-item-top` row (`.name-text` + `.tag`) and keeps `.jid` + `.dir-item-actions` below. `.dir-item-actions` gains no new class; `Enable inbound` button stays the last child so it sits directly under the badge.

- [ ] **Step 1: Rewrite the `renderDir` item template**

In `src/public/app.js`, replace the `.map((i) => ...)` template (currently lines 130-141):

```js
    .map(
      (i) => `
    <div class="dir-item">
      <div class="dir-item-top">
        <div class="info">
          <div class="name">${escapeHtml(i.name)}</div>
          <div class="jid">${escapeHtml(i.jid)}</div>
        </div>
        <span class="tag">${i.kind === 'group' ? `GROUP${i.size ? ` · ${i.size}` : ''}` : 'CONTACT'}</span>
      </div>
      <div class="dir-item-actions">
        <button class="btn btn-sm" data-copy="${escapeHtml(i.jid)}">Copy JID</button>
        <button class="btn btn-sm" data-use="${escapeHtml(i.jid)}">Use in Send</button>
        ${i.kind === 'group' ? `<button class="btn btn-sm" data-enable-inbound="${escapeHtml(i.jid)}">Enable inbound</button>` : ''}
      </div>
    </div>`
    )
    .join('')
```

- [ ] **Step 2: Update `.dir-item` CSS to a two-row flex layout**

In `src/public/app.css`, replace the block from `.dir-item {` (line 585) through `.dir-item .name .tag {` / its closing brace (line 615):

```css
.dir-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.dir-item:last-child {
  border-bottom: none;
}
.dir-item-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}
.dir-item .info {
  min-width: 0;
}
.dir-item .name {
  font-size: 14px;
  overflow-wrap: break-word;
}
.tag {
  display: inline-block;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--accent-2);
  border: 1px solid var(--accent);
  border-radius: 2px;
  padding: 1px 6px 1px 9px;
  clip-path: polygon(5px 0, 100% 0, 100% 100%, 5px 100%, 0 50%);
  white-space: nowrap;
}
```

Note: this drops the now-unused `.dir-item .name .tag { margin-left: 6px; vertical-align: 1px; }` rule (the badge is no longer a child of `.name`).

- [ ] **Step 3: Visual check with Playwright**

Start a temp static server serving `src/public/` (map `/assets/*` to root), open `app.html`, switch to the Directory view, inject mocked items via `browser_evaluate` (reuse the same 4 mock items from the diagnostic pass: short name, `Gestão GC 🍕🐭🚀`, short name, one very long name), screenshot at 1280x900 and 390x844. Confirm: badge sits top-right, aligned above "Enable inbound"; emoji renders unchanged; no text/badge overlap at any width. Delete the screenshots, `.playwright-mcp`, and stop the temp server afterward.

- [ ] **Step 4: Lint + test**

Run: `npm run lint && npm test`
Expected: both pass, no changes needed elsewhere (no other file references `.dir-item .name .tag` or the old template shape — confirm via `grep -rn "dir-item .name" src` returning nothing after the edit).

- [ ] **Step 5: Commit**

```bash
git add src/public/app.js src/public/app.css
git commit -m "fix: separate directory badge from title to stop overlap"
```

---

### Task 2: Decouple mobile sidebar footer from nav (P1)

**Files:**
- Modify: `src/public/app.css:346-380` (`@media (max-width: 860px)` block, `.sidebar-footer` rules)

**Interfaces:**
- Consumes: existing `.sidebar`, `.sidebar-footer`, `.nav-item` structure in `app.html` (unchanged, no HTML edit needed).
- Produces: no new classes; only adjusts the existing mobile media-query rules so the footer reads as part of the same bar instead of a disconnected pushed-right block.

- [ ] **Step 1: Add a visual separator to `.sidebar-footer` in the mobile layout**

In `src/public/app.css`, inside the `@media (max-width: 860px)` block, change:

```css
  .sidebar-footer {
    margin-top: 0;
    margin-left: auto;
    flex-direction: row;
    border-top: none;
    padding-top: 0;
  }
```

to:

```css
  .sidebar-footer {
    margin-top: 0;
    margin-left: auto;
    flex-direction: row;
    border-top: none;
    border-left: 1px solid var(--sidebar-border);
    padding-top: 0;
    padding-left: 10px;
  }
```

- [ ] **Step 2: Visual check with Playwright**

Same temp server as Task 1. Screenshot `app.html` at 390x844 with the sidebar visible. Confirm the footer buttons now read as anchored to the nav bar (left border divider) instead of floating disconnected. Clean up screenshots/server afterward.

- [ ] **Step 3: Lint + test**

Run: `npm run lint && npm test`
Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/public/app.css
git commit -m "fix: anchor mobile sidebar footer to nav bar with a divider"
```

---

### Task 3: Motion polish — `.icon-btn` active feedback + toast entrance (P3)

**Files:**
- Modify: `src/public/app.css:235-256` (`.icon-btn`)
- Modify: `src/public/app.css:702-717` (`.toast`)

**Interfaces:**
- Consumes: existing `.icon-btn` (theme toggle button) and `.toast`/`.toast.show` classes (unchanged JS — `app.js` `toast()` function at line 17-22 only toggles the `.show` class already).
- Produces: no new classes; adds an `:active` state and a translateY-based entrance to existing selectors.

- [ ] **Step 1: Add `:active` feedback to `.icon-btn`**

In `src/public/app.css`, after the existing `.icon-btn:focus-visible` block, add:

```css
.icon-btn:active {
  transform: scale(0.93);
}
```

And update the `.icon-btn` transition line to include `transform`:

```css
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--sidebar-muted);
  padding: 6px;
  border-radius: 6px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    transform 0.1s;
}
```

- [ ] **Step 2: Add a translateY entrance to `.toast`**

Replace:

```css
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: var(--card-2);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 13px;
  opacity: 0;
  transition: opacity 0.2s;
  pointer-events: none;
}
.toast.show {
  opacity: 1;
}
```

with:

```css
.toast {
  position: fixed;
  bottom: 24px;
  right: 24px;
  background: var(--card-2);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 13px;
  opacity: 0;
  transform: translateY(8px);
  transition:
    opacity 0.2s,
    transform 0.2s;
  pointer-events: none;
}
.toast.show {
  opacity: 1;
  transform: translateY(0);
}
```

- [ ] **Step 3: Visual check with Playwright**

Same temp server. Trigger a toast (e.g. click "Copy JID" on a mocked item) and the theme-toggle button; confirm the toast now slides up slightly while fading in, and the theme button visibly compresses on click. Clean up afterward.

- [ ] **Step 4: Lint + test**

Run: `npm run lint && npm test`
Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add src/public/app.css
git commit -m "polish: add active/entrance motion to icon button and toast"
```

---

## Self-Review

1. **Spec coverage:** P0 (badge overlap) → Task 1. P1 (sidebar footer) → Task 2. P3 icon-btn + toast → Task 3. Emoji-preservation constraint → explicitly untouched `escapeHtml`, verified in Task 1. Badge-above-"Enable inbound" constraint → satisfied by `.dir-item-top` flex row placing `.tag` at the end, right-aligned via `justify-content: space-between`, directly above the actions row where "Enable inbound" is the last button.
2. **Placeholder scan:** none found — every step has literal before/after code.
3. **Type consistency:** N/A (no typed interfaces; DOM class names cross-checked between `app.js` template and `app.css` selectors — `.dir-item-top`, `.info`, `.name`, `.tag`, `.jid`, `.dir-item-actions` all match across both files).
