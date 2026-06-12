#!/usr/bin/env node
// server.mjs — zero-dependency local server for the work-loop dashboard.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, appendFileSync, lstatSync, readdirSync, chmodSync, openSync, readSync, closeSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { childEnv, claudeInfo, loginPath, resolveClaude, splitCommand } from './env.mjs';
import { attach as busAttach, bootId, publish, publishLine } from './bus.mjs';
import * as Chat from './chat.mjs';
import * as Handoffs from './handoffs.mjs';
import * as Commands from './commands.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4317;
const tasksPath = join(__dirname, '.workloop', 'tasks.json');
const cfgPath = join(__dirname, 'workloop.config.json');

// First boot (or upgrade): create a default config if none exists.
const DEFAULT_CFG = {
  repoPath: '/ABSOLUTE/PATH/TO/your/repo',
  recentRepos: [], // MRU, server-maintained — newest first, max 8
  branchPrefix: 'workloop',
  openPR: false,
  verifier: { typecheck: 'npm run typecheck', test: 'npm test', lint: 'npm run lint', build: 'npm run build' },
  sources: { backlog: 'BACKLOG.md', todos: true, typeErrors: true, failingTests: true, lint: true, build: false },
  dev: { command: 'npm run dev', url: '' },
  agent: { command: 'claude', maxTurns: 30, allowedTools: 'Read,Edit,Bash', permissionMode: 'acceptEdits', stream: true },
  chat: { allowedTools: 'Read,Glob,Grep', maxTurns: 15, timeoutMs: 180000 },
  commands: [],
  ui: { theme: 'mission-control', ambientFx: true },
  editor: { command: '' },
};
if (!existsSync(cfgPath)) writeFileSync(cfgPath, JSON.stringify(DEFAULT_CFG, null, 2));

let pickerBusy = false;  // one native folder dialog at a time
let activeRuns = 0;      // git operations are blocked while an agent is working
let currentRun = null;   // { taskId, title, file } while a run is live — feeds the bus hello snapshot
let runnerChild = null;  // the live runner.mjs child, killed on server shutdown

// Configs written by older versions lack newer keys (chat, ui, commands, …) —
// always read through the defaults so every access site sees a full shape.
const readCfg = () => mergeCfg(DEFAULT_CFG, JSON.parse(readFileSync(cfgPath, 'utf8')));
const readTasks = () => {
  try { return JSON.parse(readFileSync(tasksPath, 'utf8')); }
  catch { return { meta: { repo: null, counts: { needsWork: 0, shouldImplement: 0 }, notes: [] }, tasks: [] }; }
};
const readBody = (req) => new Promise((res) => {
  let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch { res({}); } });
});
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const shIn = (cwd, cmd) => spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', env: childEnv(), timeout: 20000, maxBuffer: 1024 * 1024 * 30 });

function mergeCfg(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(base[k] || {}), ...v };
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

function loginState() {
  // Best-effort sign-in detection: Claude Code keeps OAuth credentials in the
  // macOS Keychain ("Claude Code-credentials"), or ~/.claude/.credentials.json
  // on other installs. Existence ≈ signed in; an expired token still surfaces
  // reactively at run time.
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) return true;
    }
    const p = join(homedir(), '.claude', '.credentials.json');
    return existsSync(p) && readFileSync(p, 'utf8').trim().length > 2;
  } catch { return null; } // unknown — don't claim either way
}

// Async scan: a spawnSync scanner froze the whole event loop (SSE included)
// for the duration of a scan. One shared in-flight promise also dedupes
// concurrent scan requests.
let scanInFlight = null;
function runScannerAsync(reason) {
  if (scanInFlight) return scanInFlight;
  publish('scan.start', 'scanning repo' + (reason ? ` (${reason})` : ''));
  scanInFlight = new Promise((done) => {
    let out = '', finished = false;
    const finish = (failNote) => {
      if (finished) return;
      finished = true;
      scanInFlight = null;
      const t = readTasks();
      const c = t.meta?.counts || { needsWork: 0, shouldImplement: 0 };
      publish('scan.done', failNote || `scan complete — ${c.needsWork} to fix · ${c.shouldImplement} queued`,
        { counts: c, notes: t.meta?.notes || [] });
      done(out.trim());
    };
    let sc;
    try { sc = spawn(process.execPath, [join(__dirname, 'scanner.mjs')], { cwd: __dirname }); }
    catch { return finish('scan failed to start'); }
    sc.stdout.on('data', (d) => (out += d));
    sc.stderr.on('data', (d) => (out += d));
    sc.on('close', () => finish());
    sc.on('error', () => finish('scan failed'));
  });
  return scanInFlight;
}

function gitInfo(repoPath) {
  if (!repoPath || repoPath.startsWith('/ABSOLUTE') || !existsSync(repoPath)) return { path: repoPath || null, exists: false, git: false, branch: null, dirty: null };
  const isGit = shIn(repoPath, 'git rev-parse --is-inside-work-tree').status === 0;
  let branch = null, dirty = null;
  if (isGit) {
    branch = (shIn(repoPath, 'git rev-parse --abbrev-ref HEAD').stdout || '').trim() || null;
    dirty = !!(shIn(repoPath, 'git status --porcelain').stdout || '').trim();
  }
  return { path: repoPath, exists: true, git: isGit, branch, dirty };
}

// ---------- git controls ----------
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

function gitState(repoPath) {
  const cfg = readCfg();
  const current = (shIn(repoPath, 'git rev-parse --abbrev-ref HEAD').stdout || '').trim();
  const branches = (shIn(repoPath, "git branch --format='%(refname:short)'").stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const changes = (shIn(repoPath, 'git status --porcelain').stdout || '')
    .split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) }));
  const prefix = cfg.branchPrefix || 'workloop';
  const remote = (shIn(repoPath, 'git remote get-url origin').stdout || '').trim() || null;
  return {
    current, branches, changes, dirty: changes.length > 0, prefix,
    isWorkloop: current.startsWith(prefix + '/'),
    remote, main: defaultBranch(repoPath),
  };
}

function defaultBranch(repoPath) {
  for (const b of ['main', 'master'])
    if (shIn(repoPath, `git rev-parse --verify --quiet ${b}`).status === 0) return b;
  return 'main';
}

function generateCommitMessage(repoPath) {
  const porcelain = (shIn(repoPath, 'git status --porcelain').stdout || '');
  const lines = porcelain.split('\n').filter(Boolean);
  const names = lines.map((l) => l.slice(3).trim());
  const fallback = () =>
    `chore: update ${names.length} file${names.length === 1 ? '' : 's'} (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;
  try {
    const claude = resolveClaude(splitCommand(readCfg().agent?.command || 'claude').bin);
    if (!claude) return fallback();
    const stat = (shIn(repoPath, 'git diff HEAD --stat | tail -n 20').stdout || '').trim();
    const diff = (shIn(repoPath, 'git diff HEAD | head -c 6000').stdout || '');
    const prompt = `Write a single-line conventional commit message (max 70 characters) for these changes. Output ONLY the message itself — no quotes, no markdown, no explanation.\n\nChanged files:\n${names.join('\n')}\n\nDiff stat:\n${stat}\n\nDiff (truncated):\n${diff}`;
    const r = spawnSync(claude, ['-p', prompt], { encoding: 'utf8', env: childEnv(), timeout: 35000, cwd: repoPath });
    const line = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    const clean = line.replace(/^["'`]+|["'`]+$/g, '').slice(0, 72);
    return (r.status === 0 && clean.length > 4) ? clean : fallback();
  } catch { return fallback(); }
}

// ---------- repo tree (data for the dashboard's repo map) ----------
const FILE_CAP = 8000;   // per-file detail above this is aggregated per-directory
const TREE_TTL = 15000;  // ms — re-stat an unchanged-looking tree at most this often
const WALK_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.expo', 'coverage', '.next', '.turbo', '.cache', 'out']);
const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const extOf = (p) => { const b = p.slice(p.lastIndexOf('/') + 1), i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };

function walkFiles(root) {
  const out = [], stack = [''];
  while (stack.length && out.length < FILE_CAP * 3) {
    const rel = stack.pop();
    let entries = [];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!WALK_IGNORE.has(e.name)) stack.push(p); }
      else if (e.isFile()) out.push(p);
    }
  }
  return out;
}

function buildRepoTree(repoPath, heat) {
  const isGit = shIn(repoPath, 'git rev-parse --is-inside-work-tree').status === 0;
  const paths = isGit
    ? (shIn(repoPath, 'git ls-files -z -c -o --exclude-standard').stdout || '').split('\0').filter(Boolean)
    : walkFiles(repoPath);
  const seen = new Set(), langs = {};
  let files = [], bytes = 0, depth = 0;
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    let st; try { st = lstatSync(join(repoPath, p)); } catch { continue; } // deleted-but-tracked
    if (!st.isFile()) continue;                                            // symlinks, fifos
    const e = extOf(p);
    langs[e] = (langs[e] || 0) + 1;
    bytes += st.size;
    depth = Math.max(depth, p.split('/').length);
    files.push({ p, s: st.size });
  }
  if (heat && isGit) { // one history pass: newest commit touching each file (first-seen wins)
    const out = shIn(repoPath, 'git -c core.quotepath=off log -n 400 --pretty=format:%x01%ct --name-only').stdout || '';
    const hm = new Map(); let ts = 0;
    for (const line of out.split('\n')) {
      if (!line) continue;
      if (line.charCodeAt(0) === 1) ts = Number(line.slice(1));
      else if (!hm.has(line)) hm.set(line, ts);
    }
    for (const f of files) { const t = hm.get(f.p); if (t) f.t = t; }
  }
  const stats = { files: files.length, bytes, depth, langs };
  let dirs = [], truncated = false;
  if (files.length > FILE_CAP) { // keep the biggest files individually, fold the rest per-directory
    truncated = true;
    files.sort((a, b) => b.s - a.s);
    const agg = new Map();
    for (const f of files.slice(FILE_CAP)) {
      const d = f.p.includes('/') ? f.p.slice(0, f.p.lastIndexOf('/')) : '.';
      const e = agg.get(d) || { p: d, s: 0, n: 0 };
      e.s += f.s; e.n++; agg.set(d, e);
    }
    files = files.slice(0, FILE_CAP);
    dirs = [...agg.values()];
  }
  return { git: isGit, files, dirs, truncated, stats };
}

let treeCache = { key: null, at: 0, payload: null };

function repoStatus(repoPath) {
  const raw = shIn(repoPath, 'git status --porcelain -z').stdout || '';
  const parts = raw.split('\0').filter(Boolean);
  const changed = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2), file = parts[i].slice(3);
    const ren = code[0] === 'R' || code[0] === 'C';
    const from = ren ? parts[++i] : null; // -z renames arrive as "XY new\0old"
    const kind = code === '??' || code.includes('A') ? 'added'
      : code.includes('D') ? 'deleted'
        : ren ? 'renamed' : 'modified';
    let size = null;
    if (kind !== 'deleted') { try { size = lstatSync(join(repoPath, file)).size; } catch { /* raced */ } }
    changed.push({ file, code: code.trim(), kind, size, from });
  }
  const head = (shIn(repoPath, 'git rev-parse --short HEAD').stdout || '').trim() || null;
  const branch = (shIn(repoPath, 'git rev-parse --abbrev-ref HEAD').stdout || '').trim() || null;
  return { head, branch, dirty: changed.length > 0, ts: Date.now(), changed };
}

// ---------- repo discovery (the "Find repos on this Mac" picker) ----------
const FIND_SKIP = new Set(['node_modules', 'Library', 'Applications', 'Music', 'Movies', 'Pictures', 'Public']);
const FIND_TTL = 60000, FIND_MAX_DIRS = 4000, FIND_MAX_REPOS = 200, FIND_MAX_MS = 4000, FIND_MAX_DEPTH = 3;
const FIND_DIR_MS = 250; // TCC-protected dirs (Desktop/Documents) can BLOCK readdir for minutes — skip them like EPERM
let repoFindCache = { at: 0, found: null };
let findInFlight = null; // concurrent ?find=1 requests share one walk

const readdirQuick = (dir) => Promise.race([
  readdir(dir, { withFileTypes: true }),
  new Promise((_, rej) => setTimeout(() => rej(new Error('slow dir')), FIND_DIR_MS)),
]);

async function findRepos() {
  if (repoFindCache.found && Date.now() - repoFindCache.at < FIND_TTL) return repoFindCache.found;
  if (findInFlight) return findInFlight;
  findInFlight = (async () => {
    const t0 = Date.now(), found = [];
    // BFS with an index pointer: budget pressure sheds DEEP repos, not shallow
    // ones. Async readdir so a slow walk never freezes the SSE bus (same
    // lesson as the async scanner above).
    const queue = [{ dir: homedir(), depth: 0 }];
    let qi = 0, scanned = 0;
    while (qi < queue.length && scanned < FIND_MAX_DIRS && found.length < FIND_MAX_REPOS && Date.now() - t0 < FIND_MAX_MS) {
      const { dir, depth } = queue[qi++];
      scanned++;
      let entries;
      try { entries = await readdirQuick(dir); } catch { continue; } // EPERM/TCC/hung — skip quietly
      if (entries.some((e) => e.name === '.git')) { // worktrees keep a .git FILE — still a repo
        let mtimeMs = 0;
        try { mtimeMs = lstatSync(join(dir, '.git')).mtimeMs; } catch { /* fine */ }
        found.push({ path: dir, name: dir.slice(dir.lastIndexOf('/') + 1), mtimeMs });
        if (depth > 0) continue; // don't descend into repos — but a $HOME dotfiles repo must not end the walk
      }
      if (depth >= FIND_MAX_DEPTH) continue;
      for (const e of entries) {
        // withFileTypes: isDirectory() is false for symlinks — cycles are impossible
        if (!e.isDirectory() || e.name.startsWith('.') || FIND_SKIP.has(e.name)) continue;
        queue.push({ dir: join(dir, e.name), depth: depth + 1 });
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    repoFindCache = { at: Date.now(), found };
    return found;
  })().finally(() => { findInFlight = null; });
  return findInFlight;
}

// ---------- dev preview ("run my app locally") ----------
let dev = { proc: null, lines: [], url: null, urlMapped: false, exited: true, exitCode: null, stopped: false, startedAt: 0 };
const devRunning = () => !!(dev.proc && !dev.exited);
const devStatus = () => ({
  running: devRunning(), url: dev.url,
  last: dev.lines.slice(-14), command: readCfg().dev?.command || null,
  // exitCode surfaces only for unexpected deaths — a manual Stop is not a failure
  exitCode: dev.exited && !dev.stopped ? dev.exitCode : null,
  startedAt: dev.startedAt || null,
});
const killGroup = (proc, sig) => {
  try { process.kill(-proc.pid, sig); }
  catch { try { proc.kill(sig); } catch { /* gone */ } }
};
function startDev() {
  const cfg = readCfg();
  const cmd = cfg.dev?.command;
  if (!cmd) return { error: 'No dev command set — add one in Settings (e.g. npm run dev).' };
  if (!cfg.repoPath || !existsSync(cfg.repoPath)) return { error: 'repoPath not set.' };
  if (devRunning()) return devStatus();
  dev = { proc: null, lines: [], url: cfg.dev?.url || null, urlMapped: false, exited: false, exitCode: null, stopped: false, startedAt: Date.now() };
  const p = spawn('bash', ['-lc', cmd], { cwd: cfg.repoPath, env: childEnv(), detached: true });
  dev.proc = p;
  publish('dev.start', `dev server starting — ${cmd}`, { command: cmd });
  p.on('exit', (code) => {
    if (dev.proc === p) {
      dev.exited = true; dev.exitCode = code ?? -1;
      publish('dev.exit', dev.stopped ? 'dev server stopped' : `dev server exited (code ${dev.exitCode})`,
        { code: dev.exitCode, stopped: dev.stopped });
    }
  });
  p.on('error', () => { if (dev.proc === p) { dev.exited = true; dev.exitCode = -1; publish('dev.exit', 'dev server failed to start', { code: -1, stopped: false }); } });
  const onData = (d) => {
    for (const raw of d.toString().split('\n')) {
      // strip ANSI styling first — escape codes are not whitespace, so they
      // leak into the URL match ("http://localhost:8081\x1b[24m") and the log
      const s = raw.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!s) continue;
      dev.lines.push(s.slice(0, 200));
      if (dev.lines.length > 200) dev.lines.shift();
      publishLine('dev.line', s.slice(0, 200));
      Handoffs.checkDevLine(s); // known launch blockers become handoffs immediately
      // URL detection: direct http(s)://localhost wins; exp:// and LAN-IP URLs
      // (Metro/Expo/Vite "Network" lines) map to the same port on localhost.
      if (!dev.url || dev.urlMapped) {
        const m = s.match(/(https?|exp):\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\d+\.\d+\.\d+\.\d+):(\d+)([^\s"')]*)/);
        if (m) {
          const httpLocal = m[1] !== 'exp' && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(m[2]);
          if (httpLocal) { dev.url = `${m[1]}://localhost:${m[3]}${m[4] || ''}`; dev.urlMapped = false; }
          else if (!dev.url) { dev.url = `http://localhost:${m[3]}`; dev.urlMapped = true; }
        }
      }
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  return devStatus();
}
function stopDev() {
  if (devRunning()) {
    const p = dev.proc;
    killGroup(p, 'SIGTERM');
    // escalate if the tree ignores SIGTERM (some dev servers do)
    setTimeout(() => { if (dev.proc === p && !dev.exited) killGroup(p, 'SIGKILL'); }, 1500);
    dev.exited = true; // reflect intent immediately in the UI
    dev.stopped = true; // deliberate stop — don't render it as a failure
  }
  return { running: false };
}
function shutdown() {
  stopDev();
  Chat.shutdown();
  Commands.shutdown();
  if (runnerChild) { try { runnerChild.kill('SIGTERM'); } catch { /* gone */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ---------- static files ----------
// Read-per-request with no-store: edits to the dashboard never need a server
// restart, and a local tool has no use for HTTP caching.
const PUB = join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return false; }
  if (p === '/') p = '/index.html';
  const abs = resolve(PUB, '.' + p);
  if (abs !== PUB && !abs.startsWith(PUB + sep)) { res.writeHead(403); res.end('forbidden'); return true; }
  let st;
  try { st = lstatSync(abs); } catch { return false; } // miss — fall through to the 404
  if (!st.isFile()) return false;                       // also rejects symlinks
  res.writeHead(200, {
    'Content-Type': MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : readFileSync(abs));
  return true;
}

// snapshot for the bus hello event — lets a page that loads mid-run re-sync
const busSnapshot = () => ({
  running: currentRun,
  dev: { running: devRunning(), url: dev.url },
  handoffsOpen: Handoffs.openCount(),
});

// ---------- http ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (!url.pathname.startsWith('/api/') && serveStatic(req, res, url)) return;

  if (req.method === 'GET' && url.pathname === '/api/events') return busAttach(req, res, url, busSnapshot());

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    const { text } = await readBody(req);
    const clean = String(text || '').trim().slice(0, 4000);
    if (!clean) return json(res, 400, { error: 'empty message' });
    const cfg = readCfg();
    if (!cfg.repoPath || !existsSync(cfg.repoPath)) return json(res, 400, { error: 'repoPath not set — point Workloop at a repo first' });
    // read-only chat may run alongside an agent; write-capable chat may not
    if (Chat.hasWriteTools(cfg.chat?.allowedTools) && (activeRuns > 0 || Commands.running()))
      return json(res, 409, { error: 'chat has write tools configured — wait for the active run/command to finish' });
    return Chat.send(req, res, { text: clean, cfg });
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/history') return json(res, 200, Chat.history());
  if (req.method === 'POST' && url.pathname === '/api/chat/reset') return json(res, 200, Chat.reset());

  if (req.method === 'GET' && url.pathname === '/api/handoffs') return json(res, 200, { handoffs: Handoffs.list() });
  if (req.method === 'POST' && (url.pathname === '/api/handoffs/resolve' || url.pathname === '/api/handoffs/dismiss')) {
    const { id } = await readBody(req);
    const h = Handoffs.setStatus(String(id || ''), url.pathname.endsWith('resolve') ? 'done' : 'dismissed');
    return h ? json(res, 200, { ok: true, handoff: h }) : json(res, 404, { error: 'handoff not found' });
  }

  if (req.method === 'POST' && url.pathname === '/api/commands/run') {
    if (activeRuns > 0) return json(res, 409, { error: 'an agent run is active — run commands after it finishes' });
    if (Chat.busyWriting()) return json(res, 409, { error: 'a write-capable chat turn is active — wait for it to finish' });
    const { id } = await readBody(req);
    const r = Commands.run(readCfg(), String(id || ''));
    return json(res, r.error ? 409 : 200, r);
  }
  if (req.method === 'POST' && url.pathname === '/api/commands/stop') return json(res, 200, Commands.stop());
  if (req.method === 'GET' && url.pathname === '/api/commands/status') return json(res, 200, Commands.status());

  if (req.method === 'POST' && url.pathname === '/api/open') {
    const { path: rel, line, mode } = await readBody(req);
    const cfg = readCfg();
    if (!cfg.repoPath || !existsSync(cfg.repoPath)) return json(res, 400, { error: 'repoPath not set' });
    const abs = resolve(cfg.repoPath, String(rel || ''));
    if (!abs.startsWith(cfg.repoPath + sep) || !existsSync(abs)) return json(res, 400, { error: 'path is not inside the repo' });
    if (mode === 'finder') {
      spawn('open', ['-R', abs], { detached: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }
    const tpl = (cfg.editor?.command || '').trim();
    if (tpl) {
      // single-quote the path so a filename containing $()/backticks/; can't be
      // interpreted by the shell that runs the (user-authored) editor template
      const sq = "'" + abs.replaceAll("'", "'\\''") + "'";
      const cmd = tpl.replaceAll('{path}', sq).replaceAll('{line}', String(Number(line) || 1));
      spawn('bash', ['-lc', cmd], { env: childEnv(), detached: true, stdio: 'ignore' }).unref();
    } else {
      // no editor configured: `open` uses the file's default app, but source
      // extensions (.ts/.sql/…) often have NO association and `open` fails
      // silently — retry in the default text editor so the click always lands
      const o = spawn('open', [abs], { detached: true, stdio: 'ignore' });
      o.on('exit', (code) => { if (code) spawn('open', ['-t', abs], { detached: true, stdio: 'ignore' }).unref(); });
      o.on('error', () => { /* open(1) missing — nothing sensible left to try */ });
      o.unref();
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/pickfolder') { // native Finder folder dialog
    if (process.platform !== 'darwin') return json(res, 400, { error: 'the folder picker needs macOS' });
    if (pickerBusy) return json(res, 200, { error: 'a folder picker is already open — check your other windows' });
    pickerBusy = true;
    // async spawn: the dialog blocks on the user; spawnSync would freeze the SSE bus
    const p = spawn('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose the repo to work on")'], { env: childEnv() });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 120000);
    let done = false; // 'error' and 'close' can both fire — answer once
    const finish = (body) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pickerBusy = false;
      json(res, 200, body);
    };
    p.on('error', () => finish({ error: 'could not open the folder picker' }));
    p.on('close', (code) => {
      const path = out.trim().replace(/\/$/, '');
      if (code === 0 && path) return finish({ path });
      if (/-128|cancell?ed/i.test(err)) return finish({ cancelled: true });
      finish({ error: 'could not open the folder picker' });
    });
    return; // responds from the close handler
  }

  if (req.method === 'GET' && url.pathname === '/api/file') { // peek: first N lines, read-only
    const cfg = readCfg();
    if (!cfg.repoPath || !existsSync(cfg.repoPath)) return json(res, 400, { error: 'repoPath not set' });
    const rel = String(url.searchParams.get('path') || '');
    const abs = resolve(cfg.repoPath, rel);
    if (!abs.startsWith(cfg.repoPath + sep)) return json(res, 400, { error: 'path is not inside the repo' });
    let st;
    try { st = lstatSync(abs); } catch { return json(res, 404, { error: 'file not found' }); }
    // lstat (not stat): a symlink inside the repo must not read content outside it
    if (!st.isFile()) return json(res, 400, { error: 'not a regular file' });
    const n = Math.min(400, Math.max(1, Math.floor(Number(url.searchParams.get('n')) || 120)));
    const CAP = 512 * 1024;
    const len = Math.min(st.size, CAP);
    const buf = Buffer.alloc(len);
    try { const fd = openSync(abs, 'r'); readSync(fd, buf, 0, len, 0); closeSync(fd); }
    catch { return json(res, 500, { error: 'could not read file' }); }
    const name = rel.split('/').pop();
    if (buf.subarray(0, Math.min(8192, len)).includes(0)) {
      return json(res, 200, { name, size: st.size, total: null, text: '', binary: true, truncated: false });
    }
    const lines = buf.toString('utf8').split('\n');
    const capped = st.size > CAP;
    if (capped && lines.length) lines.pop(); // the byte cap cut the last line mid-way
    return json(res, 200, {
      name, size: st.size, total: capped ? null : lines.length,
      text: lines.slice(0, n).join('\n'), binary: false,
      truncated: capped || lines.length > n,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') return json(res, 200, readTasks());

  if (req.method === 'POST' && url.pathname === '/api/scan') {
    if (activeRuns > 0) return json(res, 409, { error: 'an agent run is active — rescan after it finishes' });
    const scanLog = await runScannerAsync();
    return json(res, 200, { ...readTasks(), scanLog });
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const fresh = url.searchParams.get('fresh') === '1';
    if (fresh) loginPath(true);
    const cfg = readCfg();
    return json(res, 200, {
      node: process.version,
      claude: { ...claudeInfo(cfg.agent?.command || 'claude', fresh), signedIn: loginState() },
      repo: gitInfo(cfg.repoPath),
      openPR: !!cfg.openPR,
      port: PORT,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, readCfg());

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const patch = await readBody(req);
    if (typeof patch.repoPath === 'string') patch.repoPath = patch.repoPath.trim();
    delete patch.recentRepos; // server-owned — only real repo switches write it
    const prev = readCfg();
    const switching = typeof patch.repoPath === 'string' && patch.repoPath
      && !patch.repoPath.startsWith('/ABSOLUTE') && patch.repoPath !== prev.repoPath;
    if (switching && (activeRuns > 0 || Commands.running() || Chat.busyWriting())) {
      return json(res, 409, { error: 'an agent is working in the current repo — switch repos after it finishes' });
    }
    const next = mergeCfg(prev, patch);
    if (switching) {
      const keep = (p) => typeof p === 'string' && p && !p.startsWith('/ABSOLUTE') && existsSync(p);
      next.recentRepos = [patch.repoPath, prev.repoPath, ...(prev.recentRepos || [])]
        .filter((p, i, a) => keep(p) && a.indexOf(p) === i).slice(0, 8);
      if (devRunning()) stopDev(); // the running app belongs to the OLD repo
      Chat.reset();                // the --resume session is per-cwd and about the OLD repo
      publish('chat.reset', 'chat reset — repo changed');
      publish('repo.switch', `repo → ${patch.repoPath}`, { repoPath: patch.repoPath, previous: prev.repoPath });
    }
    writeFileSync(cfgPath, JSON.stringify(next, null, 2));
    publish('config.saved', 'settings saved', { keys: Object.keys(patch || {}) });
    return json(res, 200, next);
  }

  if (req.method === 'GET' && url.pathname === '/api/detect') {
    const p = (url.searchParams.get('path') || '').trim();
    if (!p || !existsSync(p)) return json(res, 200, { exists: false });
    let scripts = {};
    try { scripts = JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')).scripts || {}; } catch { /* none */ }
    const hasTs = existsSync(join(p, 'tsconfig.json'));
    const realTest = scripts.test && !/no test specified/i.test(scripts.test);
    const proposal = {
      repoPath: p,
      verifier: {
        typecheck: scripts.typecheck ? 'npm run typecheck' : (hasTs ? 'npx tsc --noEmit' : ''),
        test: realTest ? 'npm test' : '',
        lint: scripts.lint ? 'npm run lint' : '',
        build: scripts.build ? 'npm run build' : '',
      },
      dev: { command: scripts.dev ? 'npm run dev' : (scripts.start ? 'npm start' : ''), url: '' },
    };
    return json(res, 200, { exists: true, hasPackage: Object.keys(scripts).length > 0, scripts: Object.keys(scripts), hasTs, proposal });
  }

  if (req.method === 'GET' && url.pathname === '/api/repos') { // the repo picker's data
    const cfg = readCfg();
    const current = (cfg.repoPath && !cfg.repoPath.startsWith('/ABSOLUTE')) ? cfg.repoPath : null;
    const recent = (cfg.recentRepos || []).filter((p) => typeof p === 'string' && existsSync(p));
    const found = url.searchParams.get('find') === '1' ? await findRepos() : [];
    return json(res, 200, { current, recent, found });
  }

  if (req.method === 'POST' && url.pathname === '/api/backlog') {
    if (activeRuns > 0) return json(res, 409, { error: 'an agent run is active — queue the goal after it finishes' });
    const { title } = await readBody(req);
    const clean = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return json(res, 400, { error: 'empty goal' });
    const cfg = readCfg();
    if (!cfg.repoPath || !existsSync(cfg.repoPath)) return json(res, 400, { error: 'repoPath not set' });
    const file = join(cfg.repoPath, cfg.sources?.backlog || 'BACKLOG.md');
    if (!existsSync(file)) writeFileSync(file, '# Backlog\n\n');
    const cur = readFileSync(file, 'utf8');
    const open = cur.split('\n').map((l) => l.match(/^\s*[-*]\s+\[ \]\s+(.*)$/)).filter(Boolean).map((m) => m[1].trim());
    if (open.includes(clean)) return json(res, 400, { error: 'already queued — that goal is on the board' });
    appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}- [ ] ${clean}\n`);
    publish('task.queued', `goal queued — ${clean}`);
    const scanLog = await runScannerAsync();
    return json(res, 200, { ...readTasks(), scanLog });
  }

  if (req.method === 'POST' && url.pathname === '/api/task/discard') {
    if (activeRuns > 0) return json(res, 409, { error: 'an agent run is active — discard after it finishes' });
    const { id } = await readBody(req);
    const state = readTasks();
    const task = (state.tasks || []).find((t) => t.id === id);
    if (!task) return json(res, 404, { error: 'task not found — Rescan and try again' });
    if (task.column !== 'should-implement') return json(res, 400, { error: 'only Should-implement tasks can be discarded' });
    const cfg = readCfg();
    if (task.source === 'backlog') {
      // backlog lives in workloop's own BACKLOG.md — remove the line for real
      try {
        const file = join(cfg.repoPath, cfg.sources?.backlog || 'BACKLOG.md');
        const lines = readFileSync(file, 'utf8').split('\n');
        const matches = (l) => { const m = (l || '').match(/^\s*[-*]\s+\[ \]\s+(.*)$/); return !!m && m[1].trim() === task.title; };
        const i = (task.line && matches(lines[task.line - 1])) ? task.line - 1 : lines.findIndex(matches);
        if (i >= 0) { lines.splice(i, 1); writeFileSync(file, lines.join('\n')); }
      } catch { /* backlog file missing — nothing to remove */ }
    } else {
      // TODO/FIXME comments stay in the code — just hide them from future scans
      const dismissedPath = join(__dirname, '.workloop', 'dismissed.json');
      let dismissed = [];
      try { dismissed = JSON.parse(readFileSync(dismissedPath, 'utf8')); } catch { /* none yet */ }
      dismissed.push({ file: task.file, title: task.title, at: new Date().toISOString() });
      writeFileSync(dismissedPath, JSON.stringify(dismissed, null, 2));
    }
    // surgical board update — no expensive verifier re-scan for a dismiss
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.meta.counts = {
      needsWork: state.tasks.filter((t) => t.column === 'needs-work').length,
      shouldImplement: state.tasks.filter((t) => t.column === 'should-implement').length,
    };
    state.meta.generatedAt = new Date().toISOString(); // bump so the client's render dedup re-renders
    writeFileSync(tasksPath, JSON.stringify(state, null, 2));
    publish('task.discard', `discarded — ${task.title}`, { id });
    return json(res, 200, state);
  }

  if (req.method === 'POST' && url.pathname === '/api/dev/start') return json(res, 200, startDev());
  if (req.method === 'POST' && url.pathname === '/api/dev/stop') return json(res, 200, stopDev());
  if (req.method === 'GET' && url.pathname === '/api/dev/status') return json(res, 200, devStatus());

  if (req.method === 'GET' && url.pathname === '/api/repotree') {
    const cfg = readCfg();
    const repoPath = cfg.repoPath;
    if (!repoPath || repoPath.startsWith('/ABSOLUTE') || !existsSync(repoPath))
      return json(res, 200, { error: 'repo not set' });
    const heat = url.searchParams.get('heat') === '1';
    const head = (shIn(repoPath, 'git rev-parse --short HEAD').stdout || '').trim() || null;
    const dirtyHash = sha1(shIn(repoPath, 'git status --porcelain').stdout || '');
    const key = sha1(`${repoPath}|${head}|${dirtyHash}|${heat ? 1 : 0}`);
    if (url.searchParams.get('fresh') !== '1' && treeCache.key === key && Date.now() - treeCache.at < TREE_TTL)
      return json(res, 200, { ...treeCache.payload, cached: true });
    const built = buildRepoTree(repoPath, heat);
    const branch = (shIn(repoPath, 'git rev-parse --abbrev-ref HEAD').stdout || '').trim() || null;
    const payload = { repo: repoPath, branch, head, generatedAt: Date.now(), cached: false, ...built };
    treeCache = { key, at: Date.now(), payload };
    return json(res, 200, payload);
  }

  if (req.method === 'POST' && url.pathname === '/api/login') {
    // Open Terminal with the Claude Code login flow — the CLI's OAuth sign-in
    // is interactive, so it needs a real TTY; we hand the user a ready one.
    const cfg = readCfg();
    const claudeBin = resolveClaude(splitCommand(cfg.agent?.command || 'claude').bin, true);
    if (!claudeBin) return json(res, 400, { error: 'Claude Code CLI not found — set the engine path in Settings, then Recheck' });
    if (process.platform !== 'darwin')
      return json(res, 400, { error: `open a terminal and run: ${claudeBin} /login` });
    // A .command file opened with Terminal needs no Automation permission
    // (AppleScript "do script" hangs on the TCC consent gate from a background process).
    const scriptPath = join(__dirname, '.workloop', 'login.command');
    writeFileSync(scriptPath, [
      '#!/bin/bash',
      'clear',
      "printf '\\n  Sign in to Claude Code below, then come back to Workloop and re-run your task.\\n\\n'",
      `"${claudeBin}" /login`,
      '',
    ].join('\n'));
    chmodSync(scriptPath, 0o755);
    const r = spawnSync('open', ['-a', 'Terminal', scriptPath], { encoding: 'utf8', timeout: 10000 });
    if (r.status !== 0) return json(res, 500, { error: 'could not open Terminal: ' + ((r.stderr || r.error?.message || 'unknown').trim().split('\n')[0]).slice(0, 140) });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/repotree/status') {
    const cfg = readCfg();
    const repoPath = cfg.repoPath;
    if (!repoPath || repoPath.startsWith('/ABSOLUTE') || !existsSync(repoPath))
      return json(res, 200, { error: 'repo not set' });
    return json(res, 200, repoStatus(repoPath));
  }

  if (url.pathname.startsWith('/api/git/')) {
    const cfg = readCfg();
    const repoPath = cfg.repoPath;
    if (!repoPath || !existsSync(repoPath)) return json(res, 400, { error: 'repoPath not set' });

    if (req.method === 'GET' && url.pathname === '/api/git/state') return json(res, 200, gitState(repoPath));

    if (req.method === 'GET' && url.pathname === '/api/git/log') { // per-file history (read-only)
      const rel = String(url.searchParams.get('path') || '');
      const abs = resolve(repoPath, rel);
      if (!abs.startsWith(repoPath + sep)) return json(res, 400, { error: 'path is not inside the repo' });
      const n = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get('n')) || 8)));
      // argv-style + `--`: no shell, and a `-leading` filename can't read as a flag.
      // No existsSync — history of a deleted file is still useful and still safe.
      const r = spawnSync('git',
        ['-c', 'core.quotepath=off', 'log', '-n', String(n), '--pretty=format:%h%x01%ct%x01%an%x01%s', '--', rel],
        { cwd: repoPath, encoding: 'utf8', env: childEnv(), timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
      if (r.status !== 0) return json(res, 200, { commits: [] }); // not a git repo
      const commits = (r.stdout || '').split('\n').filter(Boolean).map((l) => {
        const [h, ts, an, ...s] = l.split('\x01');
        return { h, ts: Number(ts), an, s: s.join('\x01') };
      });
      return json(res, 200, { commits });
    }

    if (req.method === 'POST') {
      if (activeRuns > 0) return json(res, 409, { error: 'an agent run is active — wait for it to finish' });
      if (Commands.running()) return json(res, 409, { error: 'a saved command is running — wait for it to finish' });
      if (Chat.busyWriting()) return json(res, 409, { error: 'a write-capable chat turn is active — wait for it to finish' });
      const body = await readBody(req);
      const st = gitState(repoPath);

      if (url.pathname === '/api/git/switch') {
        const branch = String(body.branch || '').trim();
        if (!BRANCH_RE.test(branch)) return json(res, 400, { error: 'invalid branch name' });
        if (st.dirty) return json(res, 400, { error: 'uncommitted changes — Commit or Discard them first' });
        const r = shIn(repoPath, `git switch "${branch}"`);
        if (r.status !== 0) return json(res, 400, { error: (r.stderr || 'switch failed').trim().split('\n').pop() });
        publish('git.switch', `switched to ${branch}`, { branch });
        return json(res, 200, { switched: branch, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/branch') {
        const name = String(body.name || '').trim();
        if (!BRANCH_RE.test(name)) return json(res, 400, { error: 'invalid branch name' });
        if (st.branches.includes(name)) return json(res, 400, { error: 'a branch with that name already exists' });
        // no clean-tree requirement — `switch -c` legitimately carries uncommitted changes
        const r = shIn(repoPath, `git switch -c "${name}"`);
        if (r.status !== 0) return json(res, 400, { error: (r.stderr || 'branch failed').trim().split('\n').pop() });
        publish('git.branch', `created branch ${name}`, { branch: name });
        return json(res, 200, { created: name, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/commit') {
        if (!st.dirty) return json(res, 400, { error: 'nothing to commit — tree is clean' });
        const message = String(body.message || '').trim() || generateCommitMessage(repoPath);
        const msgFile = join(__dirname, '.workloop', 'commitmsg.txt');
        writeFileSync(msgFile, message + '\n');
        shIn(repoPath, 'git add -A');
        const c = shIn(repoPath, `git commit -F "${msgFile}"`);
        if (c.status !== 0) return json(res, 400, { error: 'commit failed: ' + (c.stderr || '').trim().split('\n').pop() });
        publish('git.commit', `committed — ${message}`, { message });
        return json(res, 200, { message, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/merge') {
        const branch = String(body.branch || '').trim();
        if (!BRANCH_RE.test(branch)) return json(res, 400, { error: 'invalid branch name' });
        if (st.dirty) return json(res, 400, { error: 'uncommitted changes — Commit or Discard them first' });
        const main = defaultBranch(repoPath);
        if (branch === main) return json(res, 400, { error: `already on ${main} — pick a workloop branch to merge` });
        if (st.current !== main) {
          const sw = shIn(repoPath, `git switch "${main}"`);
          if (sw.status !== 0) return json(res, 400, { error: `could not switch to ${main}: ` + (sw.stderr || '').trim().split('\n').pop() });
        }
        const m = shIn(repoPath, `git merge --no-edit "${branch}"`);
        if (m.status !== 0) {
          const conflicts = (shIn(repoPath, 'git diff --name-only --diff-filter=U').stdout || '').trim();
          shIn(repoPath, 'git merge --abort');
          return json(res, 409, { error: `merge conflict — aborted safely. Conflicting files: ${conflicts.split('\n').slice(0, 6).join(', ') || 'unknown'}. Resolve manually or re-run the task on a fresh branch.` });
        }
        shIn(repoPath, `git branch -d "${branch}"`); // safe delete: only removes fully-merged branches
        publish('git.merge', `merged ${branch} into ${main}`, { branch, into: main });
        return json(res, 200, { merged: branch, into: main, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/discard') {
        shIn(repoPath, 'git checkout -- .');
        const left = gitState(repoPath);
        const untracked = left.changes.filter((c) => c.code === '??').map((c) => c.file);
        publish('git.discard', 'discarded uncommitted changes');
        return json(res, 200, {
          discarded: true, state: left,
          note: untracked.length ? `untracked files kept: ${untracked.slice(0, 5).join(', ')}` : null,
        });
      }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/run') {
    const id = url.searchParams.get('id') || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 10000\n\n');
    if (activeRuns > 0 || Commands.running() || Chat.busyWriting()) { // one writer at a time — they'd fight over the tree
      publish('run.blocked', 'run blocked — another writer is active', { taskId: id });
      const reason = activeRuns > 0 ? 'another run is already active — wait for it to finish, then Retry'
        : Commands.running() ? 'a saved command is running — wait for it to finish, then Retry'
          : 'a write-capable chat turn is active — wait for it to finish, then Retry';
      res.write(`data: ${JSON.stringify({ type: 'done', ok: false, reason })}\n\n`);
      res.write('event: end\ndata: {}\n\n');
      return res.end();
    }
    const task = (readTasks().tasks || []).find((t) => t.id === id);
    const child = spawn(process.execPath, [join(__dirname, 'runner.mjs'), id], { cwd: __dirname });
    activeRuns++;
    runnerChild = child;
    currentRun = { taskId: id, title: task?.title || id, file: task?.file || null };
    publish('run.start', `run started — ${currentRun.title}`, currentRun);
    let doneSeen = false;
    const mirror = (line) => { // additive bus tap — the per-run SSE stream is untouched
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'status') publish('run.status', o.message || '', { taskId: id });
      else if (o.type === 'agent') publishLine('run.agent', o.message || '', { taskId: id });
      else if (o.type === 'done' && !doneSeen) {
        doneSeen = true;
        publish('run.done',
          o.ok ? `run complete — ${currentRun.title}` : `run needs you — ${o.reason || 'stopped'}`,
          { taskId: id, ok: !!o.ok, reason: o.reason, branch: o.branch, pr: o.pr, note: o.note });
        if (!o.ok) Handoffs.fromRunFailure(id, currentRun?.title || id, o.reason, o.branch, o.log);
      }
    };
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { res.write(`data: ${line}\n\n`); mirror(line); } }
    });
    child.stderr.on('data', (d) => {
      res.write(`data: ${JSON.stringify({ type: 'agent', message: String(d).trim() })}\n\n`);
      publishLine('run.agent', String(d).trim(), { taskId: id });
    });
    child.on('close', () => {
      activeRuns = Math.max(0, activeRuns - 1);
      if (runnerChild === child) runnerChild = null;
      if (!doneSeen) { // killed or crashed before its done line
        doneSeen = true;
        publish('run.done', `run ended — ${currentRun?.title || id}`, { taskId: id, ok: false, reason: 'runner exited unexpectedly' });
      }
      currentRun = null;
      res.write('event: end\ndata: {}\n\n');
      res.end();
    });
    req.on('close', () => { try { child.kill(); } catch { /* gone */ } });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is busy — is Workloop already running? Try: PORT=4318 npm start\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  const cfg = readCfg();
  console.log(`\n  WORKLOOP  ->  http://localhost:${PORT}`);
  publish('server.start', 'workloop online', { bootId, port: PORT });
  if (cfg.repoPath && !cfg.repoPath.startsWith('/ABSOLUTE') && existsSync(cfg.repoPath)) {
    console.log(`  repo: ${cfg.repoPath}`);
    runScannerAsync('boot').then(() => console.log('  initial scan complete'));
  } else {
    console.log('  repo: not set — the dashboard will walk you through Setup\n');
  }
});
