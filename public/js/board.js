/* board.js — task board: render cards, run a task (SSE), run-all, queue goals. */

async function loadTasks() {
  const data = await (await fetch('/api/tasks')).json();
  render(data);
  return data;
}
async function scan() {
  if (state.batch || state.running) { note('rescan postponed — a run is active'); return; }
  const b = $('#rescan'); b.disabled = true; b.textContent = 'Scanning…';
  try {
    const data = await (await fetch('/api/scan', { method: 'POST' })).json();
    if (data.error) { note(data.error); return; }
    render(data);
    Viz.reload();
  } finally { b.disabled = false; b.textContent = 'Rescan repo'; }
}
$('#rescan').addEventListener('click', scan);

// one run at a time — the bus owns state.running; reflect it on every Run button
function updateRunUI() {
  const runningId = state.running?.taskId;
  document.querySelectorAll('.card').forEach((el) => {
    const btn = el.querySelector('.run');
    if (!btn) return;
    if (el.classList.contains('running') || el.classList.contains('ok')) return; // run()/finish() manage these
    if (state.running && el.dataset.id !== runningId) {
      btn.disabled = true;
      btn.title = `one run at a time — running: ${state.running.title || ''}`;
    } else {
      btn.disabled = false;
      btn.title = '';
    }
  });
  const ra = $('#runall');
  if (ra && !state.batch) ra.disabled = !!state.running;
  const lb = $('#loopboard');
  if (lb && !state.batch) lb.disabled = !!state.running;
}

// Loop mode swaps "Run all" for "Loop board" — the orchestrator that plans, writes
// and adversarially checks every task in its own worktree. Toggled in Settings.
function reflectLoopMode() {
  const lb = $('#loopboard');
  if (!lb) return;
  const loopOn = !!state.config?.loop?.enabled;
  const hasNeeds = (state.tasks || []).some((t) => t.column === 'needs-work');
  lb.hidden = !(loopOn && hasNeeds);
  if (!state.batch) { lb.disabled = !!state.running; lb.textContent = '⟳ Loop board'; }
}

function render(data) {
  // scans reach us twice (direct response + bus scan.done) — render once per generation
  const gen = data.meta?.generatedAt;
  if (gen && gen === state.lastGen) return;
  state.lastGen = gen;
  state.tasks = data.tasks || [];
  const repo = data.meta?.repo;
  $('#repo').textContent = (repo && !String(repo).startsWith('/ABSOLUTE')) ? repo : 'not set — open Settings';
  $('#notes').textContent = (data.meta?.notes || []).join(' · ');
  const c = data.meta?.counts || { needsWork: 0, shouldImplement: 0 };
  $('#counts').innerHTML = `<span class="stat"><em>${c.needsWork}</em> to fix</span><span class="stat"><em>${c.shouldImplement}</em> queued</span>`;
  $('#n-needs').textContent = c.needsWork || '';
  $('#n-impl').textContent = c.shouldImplement || '';

  const cols = { 'needs-work': [], 'should-implement': [] };
  for (const t of state.tasks) (cols[t.column] || cols['should-implement']).push(t);

  fill('needs-work', cols['needs-work'],
    'Nothing failing right now. Write code, then <code>Rescan</code>.');
  fill('should-implement', cols['should-implement'],
    'No goals queued — type one above and hit <code>Queue it</code>.');

  const verified = cols['needs-work'].filter((t) => t.verifiable);
  const loopOn = !!state.config?.loop?.enabled;
  const ra = $('#runall');
  ra.hidden = loopOn || verified.length < 2; // in loop mode the Loop board button takes over
  if (!state.batch) { ra.disabled = !!state.running; ra.textContent = 'Run all'; }
  reflectLoopMode();

  const byFile = new Map(); // light up task targets on the galaxy
  for (const t of state.tasks) {
    if (!t.file) continue;
    const m = byFile.get(t.file) || { file: t.file, count: 0, column: t.column };
    m.count++;
    if (t.column === 'needs-work') m.column = 'needs-work';
    byFile.set(t.file, m);
  }
  Viz.setTaskMarks([...byFile.values()]);
}

function fill(id, tasks, emptyMsg) {
  const el = $('#' + id);
  if (!tasks.length) { el.innerHTML = `<div class="empty">${emptyMsg}</div>`; return; }
  el.innerHTML = '';
  tasks.forEach((t, i) => { const c = card(t); c.style.setProperty('--i', Math.min(i, 5)); el.appendChild(c); });
}

function card(t) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.id = t.id;
  const gate = t.verifiable
    ? `<span class="gate"><span class="dot"></span>verified</span>`
    : `<span class="gate review"><span class="dot"></span>review only</span>`;
  const loc = t.file ? `<div class="loc">${esc(t.file)}${t.line ? ':' + t.line : ''}</div>` : '';
  const canDiscard = t.column === 'should-implement' || t.source === 'finding';
  el.innerHTML = `
    <div class="head">
      <div>
        <div class="title">${esc(t.title)}</div>
        ${loc}
      </div>
      <button class="run"><span class="tri">▶</span> Run</button>
      ${canDiscard ? '<button class="dismiss" title="Discard this task">✕</button>' : ''}
    </div>
    <div class="chips">
      <span class="badge ${esc(t.source)}">${esc(t.source)}</span>
      ${gate}
    </div>
    <div class="result"><span class="k">result</span> <span class="v"></span></div>
    <div class="log"></div>`;
  el.querySelector('.run').addEventListener('click', () => {
    if (state.batch || state.running) { note('one run at a time — wait for the active run to finish'); return; }
    run(el, t.id);
  });
  if (t.file) { // spotlight the target on the map while this card has attention
    el.addEventListener('mouseenter', () => Viz.spotlight(t.file));
    el.addEventListener('mouseleave', () => Viz.spotlight(null));
    el.addEventListener('focusin', () => Viz.spotlight(t.file));
    el.addEventListener('focusout', () => Viz.spotlight(null));
    const locEl = el.querySelector('.loc');
    if (locEl) {
      locEl.style.cursor = 'pointer';
      locEl.title = 'Show on the map';
      locEl.addEventListener('click', () => Viz.flyTo(t.file));
    }
  }
  if (canDiscard) {
    el.querySelector('.dismiss').addEventListener('click', async () => {
      if (state.batch || state.running) { note('a run is active — discard after it finishes'); return; }
      const msg = t.source === 'backlog'
        ? `Remove this goal from BACKLOG.md?\n\n${t.title}`
        : t.source === 'finding'
          ? `Discard this reported issue? It won't be re-added if reported again.\n\n${t.title}`
          : `Hide this from the board? The comment stays in your code.\n\n${t.title}`;
      if (!confirm(msg)) return;
      const r = await post('/api/task/discard', { id: t.id });
      if (r.error) { note(r.error); return; }
      render(r);
      refreshRepo(); // a backlog edit dirties the tree — surfaces the Commit button
      note(t.source === 'backlog' ? 'discarded — removed from BACKLOG.md (Commit when ready)'
        : t.source === 'finding' ? 'discarded — this report stays dismissed'
          : 'discarded — hidden from future scans');
    });
  }
  return el;
}

function run(el, id) {
  return new Promise((resolve) => {
    if (el.classList.contains('running')) return resolve();
    el.className = 'card running';
    const btn = el.querySelector('.run');
    btn.disabled = true;
    btn.innerHTML = '<span class="tri">◍</span> Running';
    const log = el.querySelector('.log');
    log.innerHTML = '';
    const append = (cls, msg) => {
      const d = document.createElement('div');
      d.className = 'line ' + cls;
      d.textContent = msg;
      log.appendChild(d);
      log.scrollTop = log.scrollHeight;
    };

    // NOTE: the bus (/api/events) owns state.running, body.run-active and the
    // RepoViz runStarted/runEnded hooks — this stream only feeds the card log.
    const es = new EventSource('/api/run?id=' + encodeURIComponent(id));
    es.onmessage = (e) => {
      let o; try { o = JSON.parse(e.data); } catch { return; }
      if (o.type === 'status') append('status', o.message);
      else if (o.type === 'agent') append('agent', o.message);
      else if (o.type === 'done') finish(el, btn, o, append);
    };
    es.addEventListener('end', () => {
      es.close();
      refreshRepo();
      // the SERVER schedules the post-run rescan now (scan.done re-renders
      // every tab) — no client-side scan here
      resolve();
    });
    es.onerror = () => {
      if (el.classList.contains('running')) {
        el.className = 'card fail has-log';
        el.querySelector('.result .v').textContent = 'connection lost';
        btn.disabled = false; btn.innerHTML = '<span class="tri">▶</span> Retry';
      }
      es.close(); resolve();
    };
  });
}

function finish(el, btn, o, append) {
  el.classList.remove('running');
  el.classList.add('has-log');
  const v = el.querySelector('.result .v');
  if (o.ok) {
    el.classList.add('ok');
    if (o.pr) { v.innerHTML = 'PR ready · <a href="' + esc(o.pr) + '" target="_blank" rel="noopener">open</a>'; }
    else { v.textContent = (o.note || 'done') + (o.branch ? ' · ' + o.branch : ''); }
    btn.innerHTML = '<span class="tri">✓</span> Done';
  } else {
    el.classList.add('warn');
    v.textContent = 'needs you — ' + (o.reason || 'stopped') + (o.branch ? ' · ' + o.branch : '');
    if (/logged in|\/login/i.test(o.reason || '')) { // auth failure: offer the fix right here
      const sb = document.createElement('button');
      sb.className = 'linkbtn';
      sb.textContent = 'Sign in';
      sb.addEventListener('click', () => $('#btn-login').click());
      v.appendChild(document.createTextNode(' · '));
      v.appendChild(sb);
    }
    btn.disabled = false; btn.innerHTML = '<span class="tri">▶</span> Retry';
  }
  if (o.log) append('agent', o.log);
}

/* ---------- run all (sequential queue) ---------- */
$('#runall').addEventListener('click', async () => {
  if (state.batch) return;
  const cards = [...document.querySelectorAll('#needs-work .card')]
    .filter((el) => { const t = state.tasks.find((x) => x.id === el.dataset.id); return t && t.verifiable; });
  if (!cards.length) return;
  state.batch = true;
  const ra = $('#runall');
  ra.disabled = true;
  for (let i = 0; i < cards.length; i++) {
    ra.textContent = `Running ${i + 1}/${cards.length}…`;
    await run(cards[i], cards[i].dataset.id);
  }
  state.batch = false;
  ra.textContent = 'Run all';
  // the server's post-run scan covers the batch too — scan.done re-renders
});

/* ---------- loop the board (orchestrator: plan → write → check per task) ---------- */
function markLooped(id, o) {
  const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.classList.remove('running');
  el.classList.add('has-log', o.ok ? 'ok' : 'warn');
  const v = el.querySelector('.result .v');
  if (v) v.textContent = o.ok ? 'looped ✓ — reviewed branch ready' : ('needs you — ' + (o.reason || 'checker failed'));
  const btn = el.querySelector('.run');
  if (btn) btn.innerHTML = o.ok ? '<span class="tri">✓</span> Done' : '<span class="tri">▶</span> Retry';
}

function loopBoard() {
  if (state.batch || state.running) { note('one run at a time — wait for the active run to finish'); return; }
  const lb = $('#loopboard');
  state.batch = true;
  lb.disabled = true; lb.textContent = '⟳ Looping…';
  let planned = 0, done = 0;
  const reset = () => { state.batch = false; lb.disabled = false; lb.textContent = '⟳ Loop board'; };
  // the orchestrator narrates plan/write/check phases on the activity log (the bus);
  // here we track overall progress and mark each card as its worker finishes.
  const es = new EventSource('/api/loop');
  es.onmessage = (e) => {
    let o; try { o = JSON.parse(e.data); } catch { return; }
    if (o.type === 'manifest') {
      planned = o.count || 0;
      note(`loop: ${planned} task(s) planned${(o.deferred || []).length ? ' · ' + o.deferred.length + ' deferred (repeated failures)' : ''}`);
    } else if (o.type === 'task-done') {
      done++; markLooped(o.id, o);
      lb.textContent = `⟳ Looping ${done}${planned ? '/' + planned : ''}…`;
    } else if (o.type === 'done') {
      const s = o.summary;
      note(s ? `loop done — ${s.passed}/${s.total} passed${s.deferred ? ' · ' + s.deferred + ' deferred' : ''}` : (o.reason || 'loop finished'));
    }
  };
  es.addEventListener('end', () => { es.close(); reset(); refreshRepo(); });
  es.onerror = () => { es.close(); reset(); note('loop stream closed'); };
}
$('#loopboard')?.addEventListener('click', loopBoard);

/* ---------- add a goal (promptless tasking) ---------- */
async function queueGoal() {
  const input = $('#goal'); const btn = $('#queue');
  const title = input.value.trim();
  if (!title) return;
  if (state.batch || state.running) { note('a run is active — queue the goal after it finishes'); return; }
  btn.disabled = true; btn.textContent = 'Queuing…';
  try {
    const r = await fetch('/api/backlog', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    const data = await r.json();
    if (data.error) { note(data.error); return; }
    input.value = '';
    render(data);
  } finally { btn.disabled = false; btn.textContent = 'Queue it'; }
}
$('#queue').addEventListener('click', queueGoal);
$('#goal').addEventListener('keydown', (e) => { if (e.key === 'Enter') queueGoal(); });
