/* settings.js — control-center forms: load/save config, detect from repo,
   and the repo picker ("Your repos": current + recents instantly, plus every
   git repo found on this machine — one click switches workloop to it). */

async function loadSettings() {
  const c = await (await fetch('/api/config')).json();
  $('#f-repo').value = (c.repoPath && !c.repoPath.startsWith('/ABSOLUTE')) ? c.repoPath : '';
  $('#f-tc').value = c.verifier?.typecheck || '';
  $('#f-test').value = c.verifier?.test || '';
  $('#f-lint').value = c.verifier?.lint || '';
  $('#f-build').value = c.verifier?.build || '';
  $('#f-dev').value = c.dev?.command || '';
  $('#f-devurl').value = c.dev?.url || '';
  $('#f-engine').value = c.agent?.command || 'claude';
  $('#f-turns').value = c.agent?.maxTurns || 30;
  if ($('#f-editor')) $('#f-editor').value = c.editor?.command || '';
  $('#f-pr').checked = !!c.openPR;
  if ($('#f-pushcommit')) $('#f-pushcommit').checked = !!c.git?.pushOnCommit;
  $('#detectmsg').textContent = '';
  state.config = c;
  if (typeof Commands !== 'undefined' && Commands.renderList) Commands.renderList(c.commands || []);
  if (typeof Themes !== 'undefined' && Themes.syncFromConfig) Themes.syncFromConfig(c);
  loadRepoList(state.repoFindOn);
}

// openPanel(): legacy name kept — status.js auto-opens setup when no repo is set
async function openPanel() {
  await loadSettings();
  Drawers.openLeft('sec-setup');
  $('#f-repo').focus({ preventScroll: true });
}

async function runDetect() {
  const p = $('#f-repo').value.trim();
  const msg = $('#detectmsg');
  if (!p) { msg.textContent = 'enter a repo path first'; return null; }
  msg.textContent = 'looking…';
  const d = await (await fetch('/api/detect?path=' + encodeURIComponent(p))).json();
  if (!d.exists) { msg.textContent = 'that path does not exist on this machine'; return d; }
  const pr = d.proposal;
  $('#f-tc').value = pr.verifier.typecheck;
  $('#f-test').value = pr.verifier.test;
  $('#f-lint').value = pr.verifier.lint;
  $('#f-build').value = pr.verifier.build;
  if (!$('#f-dev').value) $('#f-dev').value = pr.dev.command;
  const found = Object.entries(pr.verifier).filter(([, v]) => v).map(([k]) => k);
  msg.textContent = d.hasPackage
    ? `found scripts: ${d.scripts.join(', ') || 'none'} → enabled ${found.join(', ') || 'nothing'}${d.hasTs && !d.scripts.includes('typecheck') ? ' (typecheck via tsconfig)' : ''}`
    : 'no package.json found — fill commands manually or leave empty';
  return d;
}
$('#detect').addEventListener('click', runDetect);

async function saveSettings() {
  const body = {
    repoPath: $('#f-repo').value.trim(),
    openPR: $('#f-pr').checked,
    verifier: { typecheck: $('#f-tc').value.trim(), test: $('#f-test').value.trim(), lint: $('#f-lint').value.trim(), build: $('#f-build').value.trim() },
    dev: { command: $('#f-dev').value.trim(), url: $('#f-devurl').value.trim() },
    agent: { command: $('#f-engine').value.trim() || 'claude', maxTurns: Number($('#f-turns').value) || 30 },
    editor: { command: $('#f-editor') ? $('#f-editor').value.trim() : '' },
  };
  const b = $('#save'); b.disabled = true; b.textContent = 'Saving…';
  try {
    const c = await post('/api/config', body);
    if (c.error) { note(c.error); return false; } // e.g. switching repos mid-run → 409
    state.config = c; // fresh config incl. server-maintained recentRepos
    note('saved — rescanning');
    await loadStatus(true);
    await loadGit();
    await scan();
    return true;
  } finally {
    b.disabled = false; b.textContent = 'Save & scan';
    loadRepoList(state.repoFindOn);
  }
}
$('#save').addEventListener('click', saveSettings);

/* ----- repo picker ----- */
async function loadRepoList(find) {
  const box = $('#repo-list');
  if (!box) return;
  try {
    const r = await (await fetch('/api/repos' + (find ? '?find=1' : ''))).json();
    renderRepoList(r);
  } catch { /* server hiccup — the list just doesn't refresh */ }
}

function renderRepoList(r) {
  const box = $('#repo-list');
  const seen = new Set();
  const rows = [];
  for (const p of [r.current, ...(r.recent || [])].filter(Boolean)) {
    if (!seen.has(p)) { seen.add(p); rows.push(p); }
  }
  for (const f of r.found || []) {
    if (!seen.has(f.path)) { seen.add(f.path); rows.push(f.path); }
  }
  box.innerHTML = '';
  for (const path of rows) {
    const cur = path === r.current;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'reporow' + (cur ? ' on' : '');
    el.title = cur ? path : 'Switch to ' + path;
    el.innerHTML = `<span class="rname">${esc(path.split('/').pop())}</span>`
      + `<span class="rpath">${esc(path.replace(/^\/Users\/[^/]+/, '~'))}</span>`
      + (cur ? '<span class="rtag">current</span>' : '');
    if (!cur) el.addEventListener('click', () => switchRepo(path));
    box.appendChild(el);
  }
}

let repoSwitching = false;
async function switchRepo(path) {
  if (repoSwitching) return;
  if (state.batch || state.running) { note('a run is active — switch repos after it finishes'); return; }
  repoSwitching = true;
  $('#repo-list').classList.add('busy');
  try {
    $('#f-repo').value = path;
    $('#f-dev').value = ''; // the old repo's dev command must not leak into the new repo
    $('#f-devurl').value = '';
    const d = await runDetect(); // refills verifier/dev for the NEW repo
    if (d && d.exists === false) { note('that folder no longer exists'); return; }
    await saveSettings();
  } finally {
    repoSwitching = false;
    $('#repo-list').classList.remove('busy');
  }
}

$('#f-browse')?.addEventListener('click', async () => {
  const b = $('#f-browse');
  b.disabled = true;
  try {
    const r = await post('/api/pickfolder', {});
    if (r.cancelled) return;
    if (r.error) { note(r.error); return; }
    if (r.path) await switchRepo(r.path); // picking a folder = editing it: detect → save → rescan
  } finally { b.disabled = false; }
});

$('#repo-find').addEventListener('click', async () => {
  const b = $('#repo-find');
  b.disabled = true;
  b.textContent = 'Scanning this machine…';
  state.repoFindOn = true; // later refreshes keep showing found repos (server caches the walk)
  try { await loadRepoList(true); }
  finally { b.disabled = false; b.textContent = 'Find repos on this machine'; }
});
