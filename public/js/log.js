/* log.js — the activity log: renders every bus event as a kind-colored row.
   Verbose kinds (run.agent / dev.line / cmd.line) live in the DOM but hide
   behind the "verbose" chip; the row cap keeps the DOM bounded. */

const ActivityLog = (() => {
  const MAX_ROWS = 400;
  const VERBOSE = new Set(['run.agent', 'dev.line', 'cmd.line']);
  const GROUPS = ['run', 'git', 'dev', 'cmd', 'chat', 'scan'];
  const GROUP_OF = (kind) => {
    const g = kind.split('.')[0];
    if (GROUPS.includes(g)) return g;
    if (g === 'task') return 'scan';
    if (g === 'handoff') return 'chat'; // handoffs surface in the chat panel
    return 'misc';
  };

  let el, pill, chipsEl;
  let pinned = true, unseen = 0;
  const filters = JSON.parse(localStorage.getItem('wl.log.filters') || 'null')
    || { run: true, git: true, dev: true, cmd: true, chat: true, scan: true, misc: true, verbose: false };

  const ts = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };

  function applyFilters() {
    document.body.classList.toggle('log-verbose', !!filters.verbose);
    for (const g of [...GROUPS, 'misc']) el.classList.toggle('hide-' + g, !filters[g]);
    localStorage.setItem('wl.log.filters', JSON.stringify(filters));
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    for (const g of [...GROUPS, 'verbose']) {
      const b = document.createElement('button');
      b.className = 'logchip' + (filters[g] ? ' on' : '');
      b.textContent = g;
      b.title = g === 'verbose' ? 'Show raw agent/dev/command lines' : `Show ${g} events`;
      b.addEventListener('click', () => {
        filters[g] = !filters[g];
        b.classList.toggle('on', filters[g]);
        applyFilters();
      });
      chipsEl.appendChild(b);
    }
  }

  function nearBottom() { const s = $('#body-log'); return s.scrollHeight - s.scrollTop - s.clientHeight < 40; }

  function add(ev) {
    if (ev.kind === 'bus.hello') return;
    const g = GROUP_OF(ev.kind);
    const row = document.createElement('div');
    row.className = `lrow k-${g}`
      + (VERBOSE.has(ev.kind) ? ' verbose' : '')
      + (/\.(error|blocked)$/.test(ev.kind) || (ev.kind === 'run.done' && ev.data && !ev.data.ok) || (ev.kind === 'dev.exit' && ev.data && ev.data.code) ? ' err' : '')
      + ((ev.kind === 'run.done' && ev.data?.ok) || ev.kind === 'handoff.resolved' ? ' okk' : '');
    row.dataset.g = g;
    const short = ev.kind.split('.').slice(1).join('.') || ev.kind;
    row.innerHTML = `<span class="lts">${ts(ev.ts)}</span><span class="lk">${esc(ev.kind.split('.')[0])}·${esc(short)}</span><span class="lm">${esc(ev.message)}</span>`;
    el.appendChild(row);
    while (el.children.length > MAX_ROWS) el.firstChild.remove();
    const scroller = $('#body-log');
    if (pinned) scroller.scrollTop = scroller.scrollHeight;
    else { unseen++; pill.textContent = `↓ ${unseen} new`; pill.hidden = false; }
  }

  function clear() { if (el) el.innerHTML = ''; unseen = 0; if (pill) pill.hidden = true; }

  function showGroup(g) { // e.g. the HUD dev chip routes here
    for (const k of Object.keys(filters)) if (k !== 'verbose') filters[k] = k === g;
    filters.verbose = true;
    renderChips(); applyFilters();
    Drawers.setOpen('r', true);
    const scroller = $('#body-log');
    scroller.scrollTop = scroller.scrollHeight;
  }

  function init() {
    el = $('#activity-log'); pill = $('#log-newpill'); chipsEl = $('#logchips');
    renderChips(); applyFilters();
    const scroller = $('#body-log');
    scroller.addEventListener('scroll', () => {
      pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
      if (pinned) { unseen = 0; pill.hidden = true; }
    });
    pill.addEventListener('click', () => { scroller.scrollTop = scroller.scrollHeight; pinned = true; unseen = 0; pill.hidden = true; });
    Bus.on('', add);
  }

  return { init, add, clear, showGroup };
})();
