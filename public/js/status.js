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
    if (!state.panelAutoOpened) { state.panelAutoOpened = true; openPanel(); }
  }
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

$('#recheck').addEventListener('click', async () => {
  note('rechecking…');
  await loadStatus(true); // fresh=1 re-detects the claude binary + login state
  await loadGit();
  note('');
});

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
