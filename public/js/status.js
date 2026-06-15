/* status.js — ops bar: engine/repo status dots, sign-in flow, git controls. */

async function loadStatus(fresh) {
  try {
    const s = await (await fetch('/api/status' + (fresh ? '?fresh=1' : ''))).json();
    state.status = s;
    renderStatus(s);
  } catch { /* server hiccup */ }
}
// surface BOTH sign-in buttons (the HUD one and the in-drawer one) together
function setSignIn(show) {
  const hud = $('#hud-signin'), lb = $('#btn-login');
  if (hud) hud.hidden = !show;
  if (lb) lb.hidden = !show;
}

function renderStatus(s) {
  const de = $('#d-engine'), te = $('#t-engine');
  if (s.claude?.found) {
    const out = s.claude.signedIn === false;
    de.className = 'dot ' + (out ? 'warn' : s.claude.ok === false ? 'warn' : 'ok');
    te.textContent = 'engine: ' + (s.claude.version || s.claude.path.split('/').slice(-1)[0]) + (out ? ' — not signed in' : '');
    te.title = s.claude.path + (s.claude.signedIn === true ? ' · signed in' : '');
    setSignIn(out); // CLI present but not logged in → offer Sign in
  } else {
    de.className = 'dot bad';
    te.textContent = 'engine: claude not found — set the path in Engine & agent';
    setSignIn(true); // not connected to the CLI yet → still offer Sign in (routes to setup if needed)
  }
  const dr = $('#d-repo'), tr = $('#t-repo'), bn = $('#hud-branch-name');
  if (s.repo?.exists && s.repo.git) {
    // branch + dirty state rendered by renderGit
  } else if (s.repo?.exists) {
    dr.className = 'dot warn'; tr.textContent = 'not a git repository';
    bn.textContent = 'no git';
  } else {
    dr.className = 'dot bad'; tr.textContent = 'repo: not set';
    bn.textContent = 'no repo';
  }
  renderConnections(s);
  // one auto-open per page load: a missing repo outranks a missing sign-in
  if (!state.panelAutoOpened) {
    if (!s.repo?.exists) { state.panelAutoOpened = true; openPanel(); }
    else if (s.claude?.found && s.claude.signedIn === false) {
      state.panelAutoOpened = true;
      Drawers.openLeft('sec-status');
    }
  }
}

/* ---- Connections matrix: one row per dependency, dot + message + fix ---- */
function renderConnections(s) {
  const box = $('#conn-rows');
  if (!box) return;
  const rows = [];
  const row = (dot, name, msg, act, actLabel) => rows.push({ dot, name, msg, act, actLabel });

  if (s.claude?.found) {
    row(s.claude.ok === false ? 'warn' : 'ok', 'engine',
      (s.claude.version || s.claude.path.split('/').slice(-1)[0]) + ' · ' + s.claude.path,
      s.claude.ok === false ? 'engine' : null, 'Check');
  } else {
    row('bad', 'engine', 'claude CLI not found', 'engine', 'Set path');
  }

  if (!s.claude?.found) row('warn', 'sign in', 'needs the engine CLI first', 'engine', 'Set path');
  else if (s.claude.signedIn === true) row('ok', 'sign in', 'signed in');
  else if (s.claude.signedIn === false) row('bad', 'sign in', 'not signed in — runs and copilot need this', 'login', 'Sign in');
  else row('warn', 'sign in', 'could not verify sign-in state', 'login', 'Sign in');

  if (s.repo?.exists && s.repo.git) row('ok', 'repo', (s.repo.branch || '?') + ' · ' + s.repo.path, 'setup', 'Change');
  else if (s.repo?.exists) row('warn', 'repo', 'not a git repository — ' + s.repo.path, 'setup', 'Change');
  else row('bad', 'repo', 'not set', 'setup', 'Set up');

  if (!s.repo?.git) row('off', 'remote', '—');
  else if (s.remote) row('ok', 'remote', s.remote);
  else row('warn', 'remote', 'no remote — git remote add origin <url> enables Push & PR');

  if (s.gh?.found === true) row('ok', 'gh cli', s.gh.version || 'installed');
  else if (s.gh?.found === false) row('warn', 'gh cli', 'not installed — PRs fall back to compare pages (brew install gh)');
  else row('off', 'gh cli', 'checking…');

  if (!s.repo?.exists) row('off', 'verifier', '— set a repo first');
  else {
    const v = s.verifier || {};
    const set = Object.keys(v).filter((k) => v[k]?.cmd);
    const broken = set.filter((k) => v[k].runnable === false);
    if (!set.length) row('warn', 'verifier', 'none configured — fixes land review-only', 'engine', 'Configure');
    else if (broken.length) row('warn', 'verifier', broken.map((k) => `${k}: missing npm script "${v[k].missing}"`).join(' · '), 'engine', 'Configure');
    else row('ok', 'verifier', set.join(' · '));
  }

  if (s.dev?.running) row('ok', 'dev server', 'running' + (s.dev.url ? ' — ' + s.dev.url : ''), 'dev', 'Configure');
  else if (s.dev?.command) row('off', 'dev server', s.dev.command + ' — not running', 'dev', 'Configure');
  else row('warn', 'dev server', 'no dev command set', 'dev', 'Configure');

  if (s.backlog?.exists) row('ok', 'backlog', s.backlog.rel);
  else row('off', 'backlog', (s.backlog?.rel || 'BACKLOG.md') + ' — created on the first queued goal');

  if (s.claude?.found && s.claude.signedIn !== false) {
    row('ok', 'copilot', s.chat?.messages ? `${s.chat.messages} message${s.chat.messages === 1 ? '' : 's'} this session` : 'fresh session', 'chat', 'Open');
  } else {
    row('warn', 'copilot', 'needs the engine signed in', s.claude?.found ? 'login' : 'engine', s.claude?.found ? 'Sign in' : 'Set path');
  }

  box.innerHTML = rows.map((r) => `
    <div class="connrow">
      <span class="dot ${r.dot}"></span><span class="cname">${esc(r.name)}</span>
      <span class="cmsg" title="${esc(r.msg)}">${esc(r.msg)}</span>
      ${r.act ? `<button class="linkbtn" data-act="${esc(r.act)}">${esc(r.actLabel || 'Fix')}</button>` : ''}
    </div>`).join('');

  const issues = rows.filter((r) => r.dot === 'warn' || r.dot === 'bad').length;
  const sum = $('#conn-sum');
  if (sum) sum.textContent = issues ? `${issues} issue${issues === 1 ? '' : 's'}` : 'all good';
}

async function loadGit() {
  try {
    const g = await (await fetch('/api/git/state')).json();
    if (g && g.current) { state.git = g; renderGit(g); }
  } catch { /* repo not set yet */ }
}
function renderGit(g) {
  const sel = $('#branchsel'), dr = $('#d-repo'), tr = $('#t-repo');
  sel.innerHTML = g.branches.map((b) => `<option ${b === g.current ? 'selected' : ''}>${esc(b)}</option>`).join('');
  dr.className = 'dot ' + (g.dirty ? 'warn' : 'ok');
  tr.textContent = g.dirty
    ? `${g.changes.length} uncommitted change${g.changes.length === 1 ? '' : 's'}`
    : 'clean';
  $('#hud-branch-name').textContent = g.current
    + (g.dirty ? ' ±' + g.changes.length : '')
    + (g.ahead ? ' ↑' + g.ahead : '');
  $('#git-remote').textContent = g.remote || 'no remote';
  $('#btn-commit').hidden = !g.dirty;
  $('#btn-discard').hidden = !g.dirty;
  $('#btn-merge').hidden = !(g.isWorkloop && !g.dirty);
  // GitHub flow: unpushed work and incoming commits are visible at a glance
  const hasRemote = !!g.remote, hasUp = !!g.upstream;
  const push = $('#btn-push'), sync = $('#btn-sync'), pr = $('#btn-pr');
  if (push) {
    push.hidden = !(hasRemote && (!hasUp || g.ahead > 0));
    push.textContent = g.ahead ? `Push ↑${g.ahead}` : 'Push';
  }
  if (sync) {
    // behind only updates after a fetch (local tracking refs) — keep Sync
    // available whenever an upstream exists; ff-only makes it always safe
    sync.hidden = !hasUp;
    sync.textContent = g.behind ? `Sync ↓${g.behind}` : 'Sync';
  }
  if (pr) pr.hidden = !(hasRemote && g.current !== g.main);
  // uncommitted files pulse on the galaxy (porcelain renames arrive as "old -> new")
  if (typeof Viz !== 'undefined') Viz.setDirty(g.dirty ? g.changes.map((c) => c.file.split(' -> ').pop()) : []);
}
async function refreshRepo() { await loadStatus(false); await loadGit(); }

// external edits should surface without waiting for an app event — a light
// idle poll keeps the ±N chip and the galaxy's dirty rings honest
setInterval(() => {
  if (!state.running && !state.batch && !document.hidden) loadGit();
}, 15000);

async function recheckAll() {
  note('rechecking…');
  await loadStatus(true); // fresh=1 re-detects the claude binary + login state
  await loadGit();
  note('');
}
$('#recheck').addEventListener('click', recheckAll);
$('#conn-recheck')?.addEventListener('click', recheckAll);

// connections fix buttons — delegated: the rows re-render on every status load
$('#conn-rows')?.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  if (act === 'login') doLogin();
  else if (act === 'engine') Drawers.openLeft('sec-engine');
  else if (act === 'setup') openPanel();
  else if (act === 'dev') Drawers.openLeft('sec-dev');
  else if (act === 'chat') { Drawers.setOpen('r', true); Drawers.setFolded('chat', false); }
});

// keep the matrix honest on config/dev/repo changes (debounced — the bus
// replays its ring on reconnect, so stale events must not re-fetch)
let connSync = null;
const connRefresh = (ev) => {
  if (!Bus.live(ev)) return;
  clearTimeout(connSync);
  connSync = setTimeout(() => loadStatus(false), 200);
};
Bus.on('config.saved', connRefresh);
Bus.on('config.changed', connRefresh);
Bus.on('repo.switch', connRefresh);
Bus.on('dev.start', connRefresh);
Bus.on('dev.exit', connRefresh);

$('#btn-newbranch').addEventListener('click', async () => {
  const input = $('#f-newbranch');
  const name = input.value.trim();
  if (!name) { note('name the branch first'); return; }
  if (state.batch || state.running) { note('a run is active — branch after it finishes'); return; }
  const b = $('#btn-newbranch'); b.disabled = true;
  const r = await post('/api/git/branch', { name });
  b.disabled = false;
  if (r.error) { note(r.error); return; }
  input.value = '';
  note('created and switched to ' + name);
  await refreshRepo();
});

$('#branchsel').addEventListener('change', async (e) => {
  const prev = state.git?.current;
  if (state.batch || state.running) { e.target.value = prev; note('a run is active — switch after it finishes'); return; }
  const branch = e.target.value;
  e.target.disabled = true;
  const r = await post('/api/git/switch', { branch });
  e.target.disabled = false;
  if (r.error) { note(r.error); e.target.value = prev; }
  else { note('switched to ' + branch); await refreshRepo(); await scan(); }
});
// doLogin(): opens Terminal at `claude /login`, then polls until signed in.
// Shared by the HUD "Sign in" button and the in-drawer one.
async function doLogin() {
  const btns = [$('#hud-signin'), $('#btn-login')].filter(Boolean);
  btns.forEach((b) => { b.disabled = true; b.dataset.label = b.textContent; b.textContent = 'Opening…'; });
  const r = await post('/api/login', {});
  btns.forEach((b) => { b.disabled = false; b.textContent = b.dataset.label || 'Sign in'; });
  if (r.error) {
    // CLI not found yet — point them at where to set its path
    note(r.error);
    if (/not found|engine path|Settings/i.test(r.error) && typeof Drawers !== 'undefined') Drawers.openLeft('sec-engine');
    return;
  }
  note('Terminal opened — run /login there; I\'ll notice when you\'re signed in');
  // watch for the sign-in to complete (up to 3 minutes)
  if (state.loginWatch) clearInterval(state.loginWatch);
  let waited = 0;
  state.loginWatch = setInterval(async () => {
    waited += 4000;
    try {
      const s = await (await fetch('/api/status?fresh=1')).json();
      if (s.claude?.signedIn) {
        clearInterval(state.loginWatch); state.loginWatch = null;
        state.status = s; renderStatus(s);
        note('✓ signed in — ready to run');
        return;
      }
    } catch { /* server hiccup */ }
    if (waited >= 180000) { clearInterval(state.loginWatch); state.loginWatch = null; }
  }, 4000);
}
$('#btn-login').addEventListener('click', doLogin);
$('#hud-signin')?.addEventListener('click', doLogin);
$('#btn-commit').addEventListener('click', async () => {
  const b = $('#btn-commit'); b.disabled = true; b.textContent = 'Summarizing…';
  const r = await post('/api/git/commit', {});
  b.disabled = false; b.textContent = 'Commit';
  if (r.error) note(r.error);
  else {
    const suffix = r.pushed === true ? ' · pushed' : r.pushed === false ? ' · push failed: ' + (r.pushError || '?') : '';
    note('committed: ' + r.message + suffix);
    await refreshRepo();
  }
});

$('#btn-push')?.addEventListener('click', async () => {
  const b = $('#btn-push'); b.disabled = true; b.textContent = 'Pushing…';
  const r = await post('/api/git/push', {});
  b.disabled = false;
  note(r.error || 'pushed to origin');
  await refreshRepo();
});

$('#btn-sync')?.addEventListener('click', async () => {
  const b = $('#btn-sync'); b.disabled = true; b.textContent = 'Syncing…';
  const r = await post('/api/git/sync', {});
  b.disabled = false;
  if (r.error) note(r.error);
  else { note('synced from origin'); await scan(); }
  await refreshRepo();
});

$('#btn-pr')?.addEventListener('click', async () => {
  const w = window.open('about:blank'); // synchronous — popup blockers eat windows opened after an await
  const b = $('#btn-pr'); b.disabled = true; b.textContent = 'Opening…';
  const r = await post('/api/git/pr', {});
  b.disabled = false; b.textContent = 'Open PR';
  const url = r.url || r.compareUrl;
  if (url) {
    if (w) w.location = url;
    note(r.existing ? 'PR already exists — opened it' : 'PR page opened');
  } else {
    if (w) w.close();
    note(r.error || 'could not open a PR');
  }
  await refreshRepo();
});

$('#f-pushcommit')?.addEventListener('change', (e) => post('/api/config', { git: { pushOnCommit: e.target.checked } }));
$('#btn-discard').addEventListener('click', async () => {
  const files = (state.git?.changes || []).map((c) => c.file).slice(0, 12).join('\n');
  if (!confirm('Discard ALL uncommitted changes? This cannot be undone.\n\n' + files)) return;
  const r = await post('/api/git/discard', {});
  if (r.error) note(r.error);
  else { note('changes discarded' + (r.note ? ' · ' + r.note : '')); await refreshRepo(); await scan(); }
});
$('#btn-merge').addEventListener('click', async () => {
  const b = $('#btn-merge'); b.disabled = true; b.textContent = 'Merging…';
  const r = await post('/api/git/merge', { branch: state.git.current });
  b.disabled = false; b.textContent = 'Merge → main';
  if (r.error) note(r.error);
  else { note(`merged ${r.merged} into ${r.into} · branch deleted`); await refreshRepo(); await scan(); }
});
