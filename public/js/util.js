/* util.js — shared helpers + page state. Classic scripts share the global
   scope, so these are visible to every later script exactly as they were in
   the original single-file page. */

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const state = { tasks: [], status: null, git: null, batch: false, running: null, panelAutoOpened: false, devTimer: null };

// note(): transient toast, top-center. Sticky context (scan notes) goes to
// #notes in the control center instead.
let toastTimer = null;
function note(t) {
  const el = $('#toast');
  if (!el) return;
  if (!t) { el.hidden = true; return; }
  el.textContent = t;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

async function post(u, b) {
  try { return await (await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })).json(); }
  catch { return { error: 'server unreachable' }; }
}
