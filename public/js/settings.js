/* settings.js — control-center forms: load/save config, detect from repo,
   and the repo picker ("Your repos": current + recents instantly, plus every
   git repo found on this machine — one click switches workloop to it). */

/* ----- engine command: structured fields <-> composed command string ----- */
const ENGINE_MODELS = ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
function composeEngine({ bin, model, effort, flags }) {
  const parts = [(bin || 'claude').trim()];
  if (model) parts.push('--model', model.trim());
  if (effort) parts.push('--effort', effort.trim());
  if (flags && flags.trim()) parts.push(flags.trim());
  return parts.join(' ');
}
function decomposeEngine(command) { // legacy migration only — pre-picker configs stored one string
  const t = String(command || 'claude').trim().split(/\s+/).filter(Boolean);
  const out = { bin: t.shift() || 'claude', model: '', effort: '', flags: '' };
  const rest = [];
  for (let i = 0; i < t.length; i++) {
    const eq = t[i].match(/^--(model|effort)=(.+)$/);
    if (eq) { out[eq[1]] = eq[2]; continue; }
    if ((t[i] === '--model' || t[i] === '--effort') && t[i + 1] && !t[i + 1].startsWith('-')) {
      out[t[i].slice(2)] = t[++i];
      continue;
    }
    rest.push(t[i]);
  }
  if (out.model && !ENGINE_MODELS.includes(out.model)) { // unknown id: keep it, but as a flag
    rest.unshift('--model', out.model);
    out.model = '';
  }
  out.flags = rest.join(' ');
  return out;
}
function engineFields() {
  return { bin: $('#f-bin').value.trim() || 'claude', model: $('#f-model').value, effort: $('#f-effort').value, flags: $('#f-flags').value.trim() };
}
function renderEnginePreview() {
  if ($('#f-preview')) $('#f-preview').textContent = composeEngine(engineFields());
}

async function loadSettings() {
  const c = await (await fetch('/api/config')).json();
  $('#f-repo').value = (c.repoPath && !c.repoPath.startsWith('/ABSOLUTE')) ? c.repoPath : '';
  $('#f-tc').value = c.verifier?.typecheck || '';
  $('#f-test').value = c.verifier?.test || '';
  $('#f-lint').value = c.verifier?.lint || '';
  $('#f-build').value = c.verifier?.build || '';
  $('#f-dev').value = c.dev?.command || '';
  $('#f-devurl').value = c.dev?.url || '';
  const eng = c.agent?.bin !== undefined
    ? { bin: c.agent.bin || 'claude', model: c.agent.model || '', effort: c.agent.effort || '', flags: c.agent.flags || '' }
    : decomposeEngine(c.agent?.command); // older config: parse the one-string form once
  $('#f-bin').value = eng.bin;
  $('#f-model').value = ENGINE_MODELS.includes(eng.model) ? eng.model : '';
  $('#f-effort').value = ['low', 'medium', 'high', 'max'].includes(eng.effort) ? eng.effort : '';
  $('#f-flags').value = eng.flags;
  renderEnginePreview();
  const fx = $('#f-effort');
  if (fx && state.status?.claude?.supportsEffort === false) {
    fx.disabled = true;
    fx.title = "your Claude CLI doesn't support --effort — update it to enable this";
  }
  $('#f-turns').value = c.agent?.maxTurns || 30;
  if ($('#f-editor')) $('#f-editor').value = c.editor?.command || '';
  $('#f-pr').checked = !!c.openPR;
  if ($('#f-pushcommit')) $('#f-pushcommit').checked = !!c.git?.pushOnCommit;
  const lp = c.loop || {};
  if ($('#f-loop-enabled')) $('#f-loop-enabled').checked = !!lp.enabled;
  if ($('#f-loop-worktrees')) $('#f-loop-worktrees').checked = lp.worktrees !== false;
  if ($('#f-loop-autoplan')) $('#f-loop-autoplan').checked = lp.autoApprovePlan !== false;
  if ($('#f-loop-teardownfail')) $('#f-loop-teardownfail').checked = !!lp.teardownOnFail;
  if ($('#f-loop-retries')) $('#f-loop-retries').value = Number.isFinite(lp.maxRetries) ? lp.maxRetries : 2;
  if ($('#f-loop-linkdirs')) $('#f-loop-linkdirs').value = (lp.linkDirs || ['node_modules']).join(', ');
  $('#detectmsg').textContent = '';
  state.config = c;
  if (typeof reflectLoopMode === 'function') reflectLoopMode(); // toggle the Loop board button when loop mode flips
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
    agent: { ...engineFields(), command: composeEngine(engineFields()), maxTurns: Number($('#f-turns').value) || 30 },
    editor: { command: $('#f-editor') ? $('#f-editor').value.trim() : '' },
    loop: {
      enabled: $('#f-loop-enabled').checked,
      worktrees: $('#f-loop-worktrees').checked,
      autoApprovePlan: $('#f-loop-autoplan').checked,
      teardownOnFail: $('#f-loop-teardownfail').checked,
      maxRetries: Number($('#f-loop-retries').value) || 0,
      linkDirs: $('#f-loop-linkdirs').value.split(',').map((s) => s.trim()).filter(Boolean),
    },
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
    await loadSettings(); // the server restores remembered per-repo commands over re-detection
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

for (const id of ['f-bin', 'f-model', 'f-effort', 'f-flags']) {
  const el = $('#' + id);
  if (el) { el.addEventListener('input', renderEnginePreview); el.addEventListener('change', renderEnginePreview); }
}

$('#repo-find').addEventListener('click', async () => {
  const b = $('#repo-find');
  b.disabled = true;
  b.textContent = 'Scanning this machine…';
  state.repoFindOn = true; // later refreshes keep showing found repos (server caches the walk)
  try { await loadRepoList(true); }
  finally { b.disabled = false; b.textContent = 'Find repos on this machine'; }
});
