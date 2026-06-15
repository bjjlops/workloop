#!/usr/bin/env node
// server.mjs — zero-dependency local server for the work-loop dashboard.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, lstatSync, readdirSync, chmodSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { childEnv, claudeInfo, loginPath, resolveClaude, splitCommand } from './env.mjs';
import * as Platform from './platform.mjs';
import { attach as busAttach, bootId, flushEventsSync, publish, publishForeign, publishLine, recent as busRecent } from './bus.mjs';
import * as Chat from './chat.mjs';
import * as Handoffs from './handoffs.mjs';
import * as Findings from './findings.mjs';
import * as Commands from './commands.mjs';
import { recordWrite, watchFile, unwatchFile, writeJsonAtomic } from './watch.mjs';
import { backlogCard, findingCard, recomputeCounts, BACKLOG_UNCHECKED_RE } from './cards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4317;
const tasksPath = join(__dirname, '.workloop', 'tasks.json');
const cfgPath = join(__dirname, 'workloop.config.json');

// First boot (or upgrade): create a default config if none exists.
const DEFAULT_CFG = {
  repoPath: '/ABSOLUTE/PATH/TO/your/repo',
  recentRepos: [], // MRU, server-maintained — newest first, max 8
  repoSettings: {}, // per-repo {verifier, dev} memory, server-maintained on switches
  branchPrefix: 'workloop',
  openPR: false,
  verifier: { typecheck: 'npm run typecheck', test: 'npm test', lint: 'npm run lint', build: 'npm run build' },
  sources: { backlog: 'BACKLOG.md', todos: true, typeErrors: true, failingTests: true, lint: true, build: false },
  dev: { command: 'npm run dev', url: '' },
  // note: the structured engine fields (bin/model/effort/flags) are deliberately
  // NOT defaulted — their absence tells the UI to migrate a legacy one-string command
  agent: { command: 'claude', maxTurns: 30, allowedTools: 'Read,Edit,Bash', permissionMode: 'acceptEdits', stream: true, timeoutMs: 1200000, verifyTimeoutMs: 600000 },
  chat: { allowedTools: 'Read,Glob,Grep', maxTurns: 15, timeoutMs: 180000 },
  commands: [],
  ui: { theme: 'mission-control', ambientFx: true },
  editor: { command: '' },
  git: { pushOnCommit: false },
};
if (!existsSync(cfgPath)) writeFileSync(cfgPath, JSON.stringify(DEFAULT_CFG, null, 2));

let pickerBusy = false;  // one native folder dialog at a time
let activeRuns = 0;      // git operations are blocked while an agent is working
let currentRun = null;   // { taskId, title, file } while a run is live — feeds the bus hello snapshot
let runnerChild = null;  // the live runner.mjs child, killed on server shutdown

// last run's outcome — persisted so the copilot's snapshot can answer "how
// did the last run go" after a restart, and shared so both instances agree
const lastRunPath = join(__dirname, '.workloop', 'lastrun.json');
let lastRun = (() => { try { return JSON.parse(readFileSync(lastRunPath, 'utf8')); } catch { return null; } })();
function setLastRun(r) {
  lastRun = { ...r, at: Date.now(), src: String(PORT) };
  writeJsonAtomic(lastRunPath, lastRun);
}

// Configs written by older versions lack newer keys (chat, ui, commands, …) —
// always read through the defaults so every access site sees a full shape.
const readCfg = () => mergeCfg(DEFAULT_CFG, JSON.parse(readFileSync(cfgPath, 'utf8')));
const readTasks = () => {
  try { return JSON.parse(readFileSync(tasksPath, 'utf8')); }
  catch { return { meta: { repo: null, counts: { needsWork: 0, shouldImplement: 0 }, notes: [] }, tasks: [] }; }
};
const MAX_BODY = 2 * 1024 * 1024; // 2 MB — generous for config/chat, a hard stop for abuse
const readBody = (req) => new Promise((res) => {
  let b = '', over = false;
  req.on('data', (d) => {
    if (over) return;
    b += d;
    if (b.length > MAX_BODY) { over = true; try { req.destroy(); } catch { /* already closed */ } res({}); }
  });
  req.on('end', () => { if (over) return; try { res(JSON.parse(b || '{}')); } catch { res({}); } });
});

// Workloop is a localhost-only tool that can execute shell commands. Two guards
// keep it that way: the Host must be a loopback name (blocks DNS-rebinding from
// a malicious site), and any Origin present must also be loopback (blocks a
// cross-site page from driving the API — CSRF→RCE). Both run before any handler.
const isLoopbackHost = (hostHeader) => {
  if (!hostHeader) return false;
  const h = String(hostHeader).replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
};
const originAllowed = (origin) => {
  if (!origin) return true; // same-origin GET, EventSource, and curl send no Origin
  try { return isLoopbackHost(new URL(origin).host); } catch { return false; }
};
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
// argv git — no shell startup, no quoting rules, identical on every OS
const gitIn = (cwd, args, timeout = 20000) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: childEnv(), timeout, maxBuffer: 1024 * 1024 * 30 });

// async argv git for NETWORK ops (push/pull/gh) — a spawnSync here would
// freeze the SSE bus for the whole transfer (we've been burned twice)
const gitInAsync = (cwd, args, { timeout = 60000, bin = 'git' } = {}) => new Promise((resolve) => {
  let out = '', err = '', p;
  try { p = spawn(bin, args, { cwd, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { return resolve({ status: -1, stdout: '', stderr: String(e.message || e), errorCode: e.code || null }); }
  const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } err += '\n[timed out]'; }, timeout);
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('error', (e) => { clearTimeout(timer); resolve({ status: -1, stdout: out, stderr: err || String(e.message || e), errorCode: e.code || null }); });
  p.on('close', (code) => { clearTimeout(timer); resolve({ status: code ?? -1, stdout: out, stderr: err, errorCode: null }); });
});

function mergeCfg(base, patch) {
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = { ...(base[k] || {}), ...v };
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

// Cached: /api/status (polled every 4s) calls this, and the macOS keychain probe
// is a synchronous `security` spawn — uncached it would hammer the event loop.
let loginCache = { at: 0, signedIn: null };
let lastPathRefresh = 0; // throttles the fresh login-PATH shell spawn on /api/status
const LOGIN_TTL = 30000;
function loginState() {
  // Best-effort sign-in detection: Claude Code keeps OAuth credentials in the
  // macOS Keychain ("Claude Code-credentials"), or ~/.claude/.credentials.json
  // on other installs. Existence ≈ signed in; an expired token still surfaces
  // reactively at run time.
  if (Date.now() - loginCache.at < LOGIN_TTL) return loginCache.signedIn;
  let v = null;
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) v = true;
    }
    if (v === null) {
      const p = join(homedir(), '.claude', '.credentials.json');
      v = existsSync(p) && readFileSync(p, 'utf8').trim().length > 2;
    }
  } catch { v = null; } // unknown — don't claim either way
  loginCache = { at: Date.now(), signedIn: v };
  return v;
}

// gh CLI detection for the Connections panel — cached and refreshed in the
// BACKGROUND. /api/status is polled every 4s (fresh=1) during the login watch,
// so a synchronous spawn here would pile up; callers always get the cached
// value immediately ({found: null} only before the first probe settles).
let ghCache = { at: 0, found: null, version: null, busy: false };
const GH_TTL = 5 * 60 * 1000;
function ghInfo(fresh) {
  const stale = Date.now() - ghCache.at > GH_TTL;
  if (!ghCache.busy && (stale || (fresh && Date.now() - ghCache.at > 30000))) {
    ghCache.busy = true;
    gitInAsync(__dirname, ['--version'], { bin: 'gh', timeout: 8000 }).then((r) => {
      ghCache = {
        at: Date.now(), busy: false,
        found: r.errorCode === 'ENOENT' ? false : r.status === 0,
        version: r.status === 0 ? (r.stdout.trim().split('\n')[0] || null) : null,
      };
    });
  }
  return { found: ghCache.found, version: ghCache.version };
}

// verifierStatus: which verifier commands are configured AND runnable — same
// rule the scanner applies (npm script must exist; npm's placeholder test
// script counts as missing), so the Connections row never disagrees with
// what a scan would actually do.
function verifierStatus(cfg) {
  let scripts = null;
  try { scripts = JSON.parse(readFileSync(join(cfg.repoPath, 'package.json'), 'utf8')).scripts || {}; }
  catch { /* no package.json — non-npm commands may still be runnable */ }
  const check = (cmd) => {
    cmd = (cmd || '').trim();
    if (!cmd) return { cmd: null, runnable: null };
    const m = cmd.match(/^npm\s+(?:run\s+)?([\w:.-]+)/);
    if (m && scripts) {
      const s = scripts[m[1]];
      if (!s || (m[1] === 'test' && /no test specified/i.test(s))) return { cmd, runnable: false, missing: m[1] };
    }
    return { cmd, runnable: true };
  };
  return {
    typecheck: check(cfg.verifier?.typecheck), test: check(cfg.verifier?.test),
    lint: check(cfg.verifier?.lint), build: check(cfg.verifier?.build),
  };
}

// Async scan: a spawnSync scanner froze the whole event loop (SSE included)
// for the duration of a scan. One shared in-flight promise also dedupes
// concurrent scan requests.
let scanInFlight = null;
function runScannerAsync(reason) {
  if (scanInFlight) return scanInFlight;
  // verifier commands must not run while the OTHER instance's agent edits the tree
  const fl = foreignRunLock();
  if (fl) {
    publish('scan.done', `scan skipped — a run is active in the other Workloop instance (:${fl.port})`);
    return Promise.resolve('');
  }
  publish('scan.start', 'scanning repo' + (reason ? ` (${reason})` : ''));
  scanInFlight = new Promise((done) => {
    let out = '', finished = false;
    const finish = (failNote) => {
      if (finished) return;
      finished = true;
      scanInFlight = null;
      // the scanner (a child process) wrote tasks.json — claim it as our own
      // write so the file watcher doesn't re-publish it as an external change
      try { recordWrite(tasksPath, readFileSync(tasksPath, 'utf8')); } catch { /* no tasks yet */ }
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

// Post-run rescan lives on the SERVER so every tab and the other instance
// re-syncs via scan.done — the old client-side scan never happened when the
// initiating tab closed mid-run. The 1.2s delay + activeRuns check means a
// Run-all batch (next run starts within ~100ms of the previous end) produces
// exactly one scan, after the final run.
let postRunScanTimer = null;
function scheduleScanAfterRun() {
  clearTimeout(postRunScanTimer);
  postRunScanTimer = setTimeout(() => {
    if (activeRuns === 0 && !Commands.running() && !scanInFlight) runScannerAsync('post-run');
  }, 1200);
}

function gitInfo(repoPath) {
  if (!repoPath || repoPath.startsWith('/ABSOLUTE') || !existsSync(repoPath)) return { path: repoPath || null, exists: false, git: false, branch: null, dirty: null };
  const isGit = gitIn(repoPath, ['rev-parse', '--is-inside-work-tree']).status === 0;
  let branch = null, dirty = null;
  if (isGit) {
    branch = (gitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null;
    dirty = !!(gitIn(repoPath, ['status', '--porcelain']).stdout || '').trim();
  }
  return { path: repoPath, exists: true, git: isGit, branch, dirty };
}

// ---------- git controls ----------
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/;

function gitState(repoPath) {
  const cfg = readCfg();
  const current = (gitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const branches = (gitIn(repoPath, ['branch', '--format=%(refname:short)']).stdout || '')
    .split('\n').map((s) => s.trim()).filter(Boolean);
  const changes = (gitIn(repoPath, ['status', '--porcelain']).stdout || '')
    .split('\n').filter(Boolean).map((l) => ({ code: l.slice(0, 2).trim(), file: l.slice(3) }));
  const prefix = cfg.branchPrefix || 'workloop';
  const remote = (gitIn(repoPath, ['remote', 'get-url', 'origin']).stdout || '').trim() || null;
  let upstream = null, ahead = 0, behind = 0; // local tracking refs only — no network on the poll
  const up = gitIn(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.status === 0) {
    upstream = up.stdout.trim();
    const lr = gitIn(repoPath, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]);
    const m = (lr.stdout || '').trim().match(/^(\d+)\s+(\d+)$/);
    if (m) { behind = +m[1]; ahead = +m[2]; } // left = upstream-only, right = HEAD-only
  }
  return {
    current, branches, changes, dirty: changes.length > 0, prefix,
    isWorkloop: current.startsWith(prefix + '/'),
    remote, main: defaultBranch(repoPath),
    upstream, ahead, behind,
  };
}

function defaultBranch(repoPath) {
  for (const b of ['main', 'master'])
    if (gitIn(repoPath, ['rev-parse', '--verify', '--quiet', b]).status === 0) return b;
  return 'main';
}

function remoteDefaultBranch(repoPath) { // PRs flow into the REMOTE's default, not the local guess
  const r = gitIn(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']); // "origin/main"
  if (r.status === 0) return r.stdout.trim().replace(/^origin\//, '');
  return defaultBranch(repoPath);
}

function githubWebBase(remote) { // https / ssh / git@ remote -> https://github.com/owner/repo, or null
  const m = (remote || '').match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/(.+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

function pushFailureMessage(stderr) {
  const s = stderr || '';
  if (/no configured push destination|does not appear to be a git repository|No such remote/i.test(s)) {
    return 'no remote — add one first: git remote add origin <url>';
  }
  if (/non-fast-forward|fetch first|\[rejected\]/i.test(s)) {
    return 'remote has new commits — Sync first, then Push';
  }
  if (/Authentication failed|Permission denied|could not read Username|403/i.test(s)) {
    return "git can't sign in to the remote — set up SSH keys or a credential helper (gh auth login works too)";
  }
  return (s.trim().split('\n').pop() || 'push failed').slice(0, 200);
}

// async: a spawnSync claude here blocked the whole SSE bus for up to 35s while
// the model wrote the message. Spawns through Platform.spawnTool so npm's .cmd
// shim resolves on Windows (a raw spawnSync of the shim never did).
async function generateCommitMessage(repoPath) {
  const porcelain = (gitIn(repoPath, ['status', '--porcelain']).stdout || '');
  const lines = porcelain.split('\n').filter(Boolean);
  const names = lines.map((l) => l.slice(3).trim());
  const fallback = () =>
    `chore: update ${names.length} file${names.length === 1 ? '' : 's'} (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', …' : ''})`;
  try {
    const claude = resolveClaude(splitCommand(readCfg().agent?.command || 'claude').bin);
    if (!claude) return fallback();
    const stat = (gitIn(repoPath, ['diff', 'HEAD', '--stat']).stdout || '').trim().split('\n').slice(-20).join('\n');
    const diff = (gitIn(repoPath, ['diff', 'HEAD']).stdout || '').slice(0, 6000);
    const prompt = `Write a single-line conventional commit message (max 70 characters) for these changes. Output ONLY the message itself — no quotes, no markdown, no explanation.\n\nChanged files:\n${names.join('\n')}\n\nDiff stat:\n${stat}\n\nDiff (truncated):\n${diff}`;
    const out = await new Promise((resolve) => {
      let child, sout = '';
      try { child = Platform.spawnTool(claude, ['-p', prompt], { env: childEnv(), cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch { return resolve(null); }
      const timer = setTimeout(() => { try { Platform.killTree(child, 'SIGKILL'); } catch { /* gone */ } resolve(null); }, 35000);
      child.stdout.on('data', (d) => (sout += d));
      child.on('error', () => { clearTimeout(timer); resolve(null); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? sout : null); });
    });
    if (out == null) return fallback();
    const line = out.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    const clean = line.replace(/^["'`]+|["'`]+$/g, '').slice(0, 72);
    return clean.length > 4 ? clean : fallback();
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
  const isGit = gitIn(repoPath, ['rev-parse', '--is-inside-work-tree']).status === 0;
  const paths = isGit
    ? (gitIn(repoPath, ['ls-files', '-z', '-c', '-o', '--exclude-standard']).stdout || '').split('\0').filter(Boolean)
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
    const out = gitIn(repoPath, ['-c', 'core.quotepath=off', 'log', '-n', '400', '--pretty=format:%x01%ct', '--name-only']).stdout || '';
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
  const raw = gitIn(repoPath, ['status', '--porcelain', '-z']).stdout || '';
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
  const head = (gitIn(repoPath, ['rev-parse', '--short', 'HEAD']).stdout || '').trim() || null;
  const branch = (gitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null;
  return { head, branch, dirty: changed.length > 0, ts: Date.now(), changed };
}

// ---------- repo discovery (the "Find repos on this Mac" picker) ----------
const FIND_SKIP = new Set(['node_modules', 'Library', 'Applications', 'Music', 'Movies', 'Pictures', 'Public', ...Platform.FIND_SKIP_EXTRA]);
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
        found.push({ path: dir, name: Platform.basename(dir), mtimeMs });
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
let devRetryAt = 0; // last stale-port auto-recovery — at most one per 30s
const devRunning = () => !!(dev.proc && !dev.exited);
const devStatus = () => ({
  running: devRunning(), url: dev.url,
  last: dev.lines.slice(-14), command: readCfg().dev?.command || null,
  // exitCode surfaces only for unexpected deaths — a manual Stop is not a failure
  exitCode: dev.exited && !dev.stopped ? dev.exitCode : null,
  startedAt: dev.startedAt || null,
});
function startDev() {
  const cfg = readCfg();
  const cmd = cfg.dev?.command;
  if (!cmd) return { error: 'No dev command set — add one in Settings (e.g. npm run dev).' };
  if (!cfg.repoPath || !existsSync(cfg.repoPath)) return { error: 'repoPath not set.' };
  if (devRunning()) return devStatus();
  dev = { proc: null, lines: [], url: cfg.dev?.url || null, urlMapped: false, exited: false, exitCode: null, stopped: false, startedAt: Date.now() };
  const sh = Platform.userShell(cmd);
  const p = spawn(sh.bin, sh.args, { ...sh.opts, cwd: cfg.repoPath, env: childEnv(), ...Platform.detachOpts() });
  dev.proc = p;
  publish('dev.start', `dev server starting — ${cmd}`, { command: cmd });
  p.on('close', (code) => { // close, not exit: the holder-pid line can flush AFTER exit fires
    if (dev.proc !== p) return;
    dev.exited = true; dev.exitCode = code ?? -1;
    // self-healing: if the start died because a STALE instance of this same
    // repo's dev server holds the port (orphaned by a server restart), clear
    // it and retry once. Expo names the holder: "<repoPath> (pid N)".
    if (!dev.stopped && dev.exitCode !== 0 && dev.stalePid && Date.now() - devRetryAt > 30000) {
      const pid = dev.stalePid;
      let owns = Platform.isWin; // win: trust the dev tool's own report; POSIX: verify first
      if (!owns) {
        // ps argv may be RELATIVE ("node node_modules/.bin/expo …") — the
        // process's cwd is the reliable ownership signal, argv the fallback
        const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
        owns = (cwd.stdout || '').split('\n').some((l) => l.startsWith('n') && resolve(l.slice(1)) === resolve(cfg.repoPath));
        if (!owns) {
          const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
          owns = (ps.stdout || '').includes(cfg.repoPath);
        }
      }
      if (owns) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
        devRetryAt = Date.now();
        publish('dev.line', `stale dev server (pid ${pid}) from this repo held the port — cleared it, retrying`);
        setTimeout(() => { if (!devRunning()) startDev(); }, 1200);
        return;
      }
    }
    publish('dev.exit', dev.stopped ? 'dev server stopped' : `dev server exited (code ${dev.exitCode})`,
      { code: dev.exitCode, stopped: dev.stopped });
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
      // known launch blockers: hands-on ones become handoffs immediately;
      // agent-runnable ones land under Needs work on the board instead
      const hint = Handoffs.checkDevLine(s, cfg.repoPath);
      if (hint?.fix) landFinding(cfg, { source: 'dev', ...hint.fix });
      // port-clash forensics: remember WHO holds the port when the tool says so
      if (/Port \d+ is running this app in another window/i.test(s)) dev.portClash = true;
      if (dev.portClash && !dev.stalePid) {
        const pm = s.match(/^(.+) \(pid (\d+)\)$/);
        if (pm && resolve(pm[1].trim()) === resolve(cfg.repoPath)) dev.stalePid = Number(pm[2]);
      }
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
    Platform.killTree(p, 'SIGTERM');
    // escalate if the tree ignores SIGTERM (some dev servers do)
    setTimeout(() => { if (dev.proc === p && !dev.exited) Platform.killTree(p, 'SIGKILL'); }, 1500);
    dev.exited = true; // reflect intent immediately in the UI
    dev.stopped = true; // deliberate stop — don't render it as a failure
  }
  return { running: false };
}
function shutdown() {
  // we're exiting NOW — graceful doesn't matter, orphans do. SIGKILL the dev
  // tree immediately (the polite stopDev() escalation would never get to run).
  if (devRunning()) {
    try { Platform.killTree(dev.proc, 'SIGKILL'); } catch { /* gone */ }
    dev.exited = true; dev.stopped = true;
  }
  Chat.shutdown();
  Commands.shutdown();
  if (runnerChild) { try { runnerChild.kill('SIGTERM'); } catch { /* gone */ } }
  flushEventsSync(); // pending activity lines must land before we vanish
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown); // closing the Terminal window must not orphan the dev tree

// A long-running local server must survive a stray async throw rather than
// black-holing — log it on the bus and to stderr, then keep serving.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  console.error('[workloop] unhandled rejection (kept alive):', reason);
  try { publish('server.error', `unhandled rejection: ${msg}`); } catch { /* bus down */ }
});
process.on('uncaughtException', (err) => {
  console.error('[workloop] uncaught exception (kept alive):', err);
  try { publish('server.error', `uncaught exception: ${err && err.message ? err.message : err}`); } catch { /* bus down */ }
});

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
  handoffsOpen: Handoffs.openCount(readCfg().repoPath),
});

// ---------- the AI side, connected ----------
// queueGoals: append unchecked items to the repo's backlog file. Shared by
// POST /api/backlog and the copilot's ```queue fences, so both paths dedupe
// and format identically. Returns what actually landed, with the 1-based
// line each goal occupies (boardAddBacklog needs it to mint scanner ids).
function queueGoals(cfg, titles) {
  const rel = cfg.sources?.backlog || 'BACKLOG.md';
  const file = join(cfg.repoPath, rel);
  let cur = existsSync(file) ? readFileSync(file, 'utf8') : '# Backlog\n\n';
  if (!cur.endsWith('\n')) cur += '\n';
  const open = new Set(cur.split('\n').map((l) => l.match(BACKLOG_UNCHECKED_RE)).filter(Boolean).map((m) => m[1].trim()));
  const queued = [], dup = [];
  for (const raw of titles) {
    const clean = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) continue;
    if (open.has(clean)) { dup.push(clean); continue; }
    queued.push({ title: clean, line: cur.split('\n').length }); // the line it's about to land on
    cur += `- [ ] ${clean}\n`;
    open.add(clean);
  }
  if (queued.length) { writeFileSync(file, cur); recordWrite(file, cur); }
  return { rel, queued, dup };
}

// boardAddBacklog: surgical task-board insert for freshly queued goals — the
// exact shape and ids the scanner would produce, so the tasks panel, galaxy
// marks, and the copilot's snapshot (all reading tasks.json) reflect a queued
// goal immediately instead of after the next full verifier scan. Returns the
// fresh state, or null when tasks.json belongs to a different repo (caller
// falls back to a real scan).
function boardAddBacklog(cfg, rel, queued) {
  const state = readTasks();
  if (state.meta?.repo !== cfg.repoPath) return null;
  state.tasks = state.tasks || [];
  for (const q of queued) {
    const card = backlogCard(rel, q.line - 1, q.title); // scanner ids by 0-based line
    if (state.tasks.some((t) => t.id === card.id)) continue;
    state.tasks.push(card);
  }
  state.meta.counts = recomputeCounts(state.tasks);
  state.meta.generatedAt = new Date().toISOString(); // bump so the client's render dedup re-renders
  writeJsonAtomic(tasksPath, state);
  return state;
}

// chatContext: one compact snapshot, regenerated per turn, of everything the
// dashboard panels render — task board, queue, live run, recent activity,
// open handoffs, git. The copilot reads the SAME state the user is looking
// at, so its answers can't drift out of sync with the work panel.
function chatContext(cfg) {
  const cap = (s, n = 140) => String(s || '').slice(0, n);
  const ago = (ts) => {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  };
  const t = readTasks();
  const counts = t.meta?.counts || { needsWork: 0, shouldImplement: 0 };
  const g = gitInfo(cfg.repoPath);
  const item = (x) => `  - [${x.source}] ${cap(x.title)}${x.file ? ` (${x.file}${x.line ? ':' + x.line : ''})` : ''}`;
  const sect = (label, rows, total) => {
    const more = total > rows.length ? `\n  - …and ${total - rows.length} more` : '';
    return `${label} (${total}):${rows.length ? '\n' + rows.join('\n') + more : ' none'}`;
  };
  const nw = (t.tasks || []).filter((x) => x.column === 'needs-work');
  const qd = (t.tasks || []).filter((x) => x.column === 'should-implement');
  const open = Handoffs.list(cfg.repoPath).filter((h) => h.status === 'open');
  const acts = busRecent(15).filter((e) => !e.kind.startsWith('chat.'))
    .map((e) => `  - ${ago(e.ts)} · ${e.kind} · ${cap(e.message)}`);
  const genAt = Date.parse(t.meta?.generatedAt || '') || 0;
  const bySource = {};
  for (const x of qd) bySource[x.source] = (bySource[x.source] || 0) + 1;
  const queueLabel = 'queue' + (qd.length ? ` (${Object.entries(bySource).map(([k, n]) => `${k} ${n}`).join(', ')})` : '');
  const lastRunLine = lastRun
    ? `${lastRun.ok ? 'ok' : 'needs you'} — "${cap(lastRun.title)}"${lastRun.branch ? ` · ${lastRun.branch}` : ''}${!lastRun.ok && lastRun.reason ? ` · ${cap(lastRun.reason, 100)}` : ''} · ${ago(lastRun.at)}`
    : 'none yet';
  return [
    'WORKSPACE STATE (live, regenerated for this turn — supersedes anything earlier in the conversation):',
    `repo: ${cfg.repoPath} · branch: ${g.branch || '?'} · ${g.dirty ? 'uncommitted changes' : 'clean tree'}`,
    `agent run: ${currentRun ? `ACTIVE — "${currentRun.title}"${currentRun.file ? ` (${currentRun.file})` : ''}` : 'none active'}`,
    `last run: ${lastRunLine}`,
    `dev server: ${devRunning() ? 'running' + (dev.url ? ` — ${dev.url}` : '') : 'not running'}`,
    `task board: ${genAt ? `updated ${ago(genAt)}` : 'not scanned yet'}`,
    sect('needs work', nw.slice(0, 8).map(item), counts.needsWork),
    sect(queueLabel, qd.slice(0, 8).map(item), counts.shouldImplement),
    sect('open handoffs', open.slice(0, 6).map((h) => `  - [${h.source}] ${cap(h.title)}${h.steps?.[0] ? ` — next: ${cap(h.steps[0], 80)}` : ''}`), open.length),
    `recent activity (oldest first):${acts.length ? '\n' + acts.join('\n') : ' none yet'}`,
  ].join('\n');
}

// ---------- cross-instance / external state sync ----------
// Two Workloop instances (e.g. :4317 and a :4321 preview) share this folder's
// .workloop/ state and the repo's backlog file. fs.watch + content hashing
// (watch.mjs) turn the other instance's writes — and hand-edits in any
// editor — into bus events, so every panel follows no matter who wrote.
const eventsPath = join(__dirname, '.workloop', 'events.jsonl');
let evOffset = (() => { try { return lstatSync(eventsPath).size; } catch { return 0; } })();

// tail the shared activity log: new lines appended by the OTHER instance are
// re-broadcast here (publishForeign never re-persists — no ping-pong).
function tailForeignEvents(abs) {
  let st;
  try { st = lstatSync(abs); } catch { return; }
  if (st.size < evOffset) { evOffset = st.size; return; } // other instance compacted at boot — skip to EOF
  if (st.size === evOffset) return;
  const buf = Buffer.alloc(st.size - evOffset);
  try { const fd = openSync(abs, 'r'); readSync(fd, buf, 0, buf.length, evOffset); closeSync(fd); }
  catch { return; }
  const nl = buf.lastIndexOf(0x0a);
  if (nl < 0) return; // torn line mid-append — wait for the rest
  evOffset += nl + 1;
  for (const line of buf.subarray(0, nl).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (String(ev.src) === String(PORT)) continue; // our own append
    publishForeign(ev);
  }
}

// syncBacklogIntoTasks: surgical backlog→board merge for EXTERNAL backlog
// edits (hand-edits, the other instance, the runner's check-off). Re-derives
// the backlog cards exactly as the scanner would — same ids: 0-based line +
// the RAW capture (scanner.mjs) — and leaves every other card untouched, so
// an outside edit reaches the board without paying for a verifier scan.
function syncBacklogIntoTasks(cfg, content) {
  const state = readTasks();
  if (state.meta?.repo !== cfg.repoPath) return null; // board belongs to another repo — a real scan owns this
  const rel = cfg.sources?.backlog || 'BACKLOG.md';
  const next = [];
  String(content || '').split('\n').forEach((ln, i) => {
    const m = ln.match(BACKLOG_UNCHECKED_RE);
    if (m && m[1].trim()) next.push(backlogCard(rel, i, m[1]));
  });
  const cur = (state.tasks || []).filter((t) => t.source === 'backlog');
  if (JSON.stringify(cur) === JSON.stringify(next)) return null; // no effective change
  state.tasks = [...(state.tasks || []).filter((t) => t.source !== 'backlog'), ...next];
  state.meta.counts = recomputeCounts(state.tasks);
  state.meta.generatedAt = new Date().toISOString();
  writeJsonAtomic(tasksPath, state);
  return state;
}

// findingCard (the EXACT task shape scanner.mjs also emits) and recomputeCounts
// live in cards.mjs — the equality guard below depends on surgical writes and
// scans agreeing byte-for-byte, so the builder must be one shared definition.

// syncFindingsIntoTasks: re-derive every finding card from the store —
// shared by landFinding (new report), run-success resolution, discard, and
// the cross-instance findings.json watcher.
function syncFindingsIntoTasks(cfg) {
  const state = readTasks();
  if (state.meta?.repo !== cfg.repoPath) return null; // board belongs to another repo — a real scan owns this
  const next = Findings.list(cfg.repoPath).slice(0, 40).map(findingCard);
  const cur = (state.tasks || []).filter((t) => t.source === 'finding');
  if (JSON.stringify(cur) === JSON.stringify(next)) return null; // no effective change — don't bump generatedAt
  state.tasks = [...(state.tasks || []).filter((t) => t.source !== 'finding'), ...next];
  state.meta.counts = recomputeCounts(state.tasks);
  state.meta.generatedAt = new Date().toISOString();
  writeJsonAtomic(tasksPath, state);
  return state;
}

// landFinding: an agent-fixable issue (copilot ```fix fence, dev-server hint)
// becomes a Needs-work card with a Run button — NOT a chat handoff. Chat is
// for conversation and hands-on items only.
function landFinding(cfg, { source, title, detail, file, line }) {
  // normalize absolute paths to repo-relative; outside the repo → no location
  if (typeof file === 'string' && file.startsWith('/')) {
    file = file.startsWith(cfg.repoPath + '/') ? file.slice(cfg.repoPath.length + 1) : null;
  }
  const f = Findings.create({ source, title, detail, file, line, repo: cfg.repoPath });
  if (!f) return null; // already on the board, or discarded by the user — stay quiet
  const st = syncFindingsIntoTasks(cfg);
  if (!st) runScannerAsync('finding landed'); // tasks.json was for another repo
  publish('task.found', `needs work — ${f.title}`, { findingId: f.id, source });
  return f;
}

let armedBacklog = null; // abs path of the backlog file currently watched — re-armed on repo switch
function armBacklogWatch(cfg) {
  const rp = cfg.repoPath;
  if (!rp || rp.startsWith('/ABSOLUTE') || !existsSync(rp)) return;
  const file = join(rp, cfg.sources?.backlog || 'BACKLOG.md');
  if (armedBacklog === file) return;
  if (armedBacklog) unwatchFile(armedBacklog);
  armedBacklog = file;
  try { recordWrite(file, readFileSync(file, 'utf8')); } catch { /* not created yet */ }
  watchFile(file, 'text', (content, again) => {
    if (activeRuns > 0) return again(2000); // the runner may be mid check-off — reconcile right after the run
    const live = readCfg();
    const st = syncBacklogIntoTasks(live, content);
    if (st) {
      publish('task.synced', `backlog updated externally — ${st.meta.counts.shouldImplement} queued`,
        { counts: st.meta.counts, source: 'backlog' });
    }
  });
}

function initStateWatchers() {
  const hfPath = join(__dirname, '.workloop', 'handoffs.json');
  const chatPath = join(__dirname, '.workloop', 'chat.json');
  const fdPath = join(__dirname, '.workloop', 'findings.json');
  // prime the self-write hashes with current disk content so a no-op fs event
  // (touch, double-fire) never re-publishes state nobody changed
  for (const p of [tasksPath, hfPath, chatPath, fdPath, lastRunPath, cfgPath]) {
    try { recordWrite(p, readFileSync(p, 'utf8')); } catch { /* absent */ }
  }
  watchFile(fdPath, 'json', (data) => {
    Findings.reload(data);
    const st = syncFindingsIntoTasks(readCfg()); // equality-guarded — no two-instance ping-pong
    if (st) {
      publish('task.synced', `findings updated externally — ${st.meta.counts.needsWork} to fix`,
        { counts: st.meta.counts, source: 'findings' });
    }
  });
  watchFile(tasksPath, 'json', (data) => {
    // never rescan from here — reactions to tasks.json must not write tasks.json
    const c = data?.meta?.counts || { needsWork: 0, shouldImplement: 0 };
    publish('task.synced', `task board updated externally — ${c.needsWork} to fix · ${c.shouldImplement} queued`,
      { counts: c, source: 'tasks' });
  });
  watchFile(hfPath, 'json', (data) => {
    const open = Handoffs.reload(data);
    publish('handoff.changed', `handoffs updated externally — ${open} open`, { open });
  });
  watchFile(chatPath, 'json', (data, again) => {
    if (Chat.busy()) return again(2000); // never clobber an in-flight turn's session
    Chat.reload(data);
    publish('chat.changed', 'chat updated externally', { messages: (data?.messages || []).length });
  });
  watchFile(lastRunPath, 'json', (data) => { if (data && typeof data === 'object') lastRun = data; });
  watchFile(eventsPath, 'raw', tailForeignEvents);
  watchFile(cfgPath, 'json', (data) => {
    const cfg = mergeCfg(DEFAULT_CFG, data || {});
    const before = armedBacklog;
    armBacklogWatch(cfg);
    publish('config.changed', 'settings changed externally', { repoPath: cfg.repoPath, repoSwitched: armedBacklog !== before });
  });
  armBacklogWatch(readCfg());
}

// ---------- cross-instance run lock ----------
// activeRuns is per-process; two instances on the same checkout could each
// start an agent and fight over the tree. A lock file in the shared .workloop/
// extends the single-writer rule across processes (pid = the runner child, so
// a crashed server's orphan still holds the lock until it actually dies).
const runLockPath = join(__dirname, '.workloop', 'run.lock');
function foreignRunLock() {
  let l;
  try { l = JSON.parse(readFileSync(runLockPath, 'utf8')); } catch { return null; }
  if (!l || String(l.port) === String(PORT)) return null; // ours — activeRuns governs
  const stale = Date.now() - (l.at || 0) > 30 * 60 * 1000;
  let alive = false;
  if (!stale && l.pid) { try { process.kill(l.pid, 0); alive = true; } catch { /* dead */ } }
  if (!alive) { try { unlinkSync(runLockPath); } catch { /* raced */ } return null; }
  return l;
}
// Atomically acquire the cross-instance write lock. Returns true on success, or
// the blocking lock object when another LIVE instance owns it. Exclusive create
// (flag 'wx') closes the check-then-write race where two instances could each
// pass foreignRunLock() and then both write the lock.
function acquireRunLock(taskId, pid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(runLockPath, JSON.stringify({ pid, port: String(PORT), taskId, at: Date.now() }), { flag: 'wx' });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') return true; // unexpected fs error — don't hard-block a run on it
      const held = foreignRunLock(); // null if it's ours/stale/dead (and clears a dead foreign lock)
      if (held) return held;         // a live foreign instance owns the tree
      try { unlinkSync(runLockPath); } catch { /* raced */ } // our own stale lock — drop and retry
    }
  }
  return true; // lock kept reappearing (rare) — proceed rather than wedge
}
const writeRunLock = (taskId, pid) => {
  try { writeJsonAtomic(runLockPath, { pid, port: String(PORT), taskId, at: Date.now() }); } catch { /* best-effort */ }
};
const clearRunLock = () => {
  try {
    const l = JSON.parse(readFileSync(runLockPath, 'utf8'));
    if (String(l.port) === String(PORT)) unlinkSync(runLockPath);
  } catch { /* gone */ }
};

// Single source of truth for "is a writer active in THIS instance?" — runs,
// saved commands, and write-capable chat all exclude each other (one writer per
// tree). Returns a human reason or null so callers can answer 409 consistently.
const writerBlockReason = () =>
  activeRuns > 0 ? 'an agent run is active'
    : Commands.running() ? 'a saved command is running'
      : Chat.busyWriting() ? 'a write-capable chat turn is active'
        : null;
const writerBusy = () => writerBlockReason() !== null;

// ---------- http ----------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // localhost-only guard: block DNS-rebinding (non-loopback Host) and cross-site
  // drivers (foreign Origin) before any handler — see isLoopbackHost/originAllowed.
  if (!isLoopbackHost(req.headers.host) || !originAllowed(req.headers.origin)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('forbidden: workloop is localhost-only');
  }
  try {
    await dispatch(req, res, url);
  } catch (e) {
    // one bad handler must not hang the request or take down the server
    publish('server.error', `request handler threw: ${e.message}`, { path: url.pathname });
    if (!res.headersSent) { try { json(res, 500, { error: 'internal error' }); } catch { /* socket gone */ } }
    else { try { res.end(); } catch { /* gone */ } }
  }
});

// Route dispatch — a long if-ladder today; Phase 4 will table-drive it.
async function dispatch(req, res, url) {
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
    // ```queue fences land here: same rules as POST /api/backlog — never
    // dirty the tree mid-run; the surgical board insert keeps every panel
    // (tasks, galaxy marks, the next turn's snapshot) in step via task.queued
    const onGoals = (titles) => {
      if (activeRuns > 0) return { queued: [], blocked: true };
      const live = readCfg();
      const { rel, queued } = queueGoals(live, titles);
      const board = queued.length ? boardAddBacklog(live, rel, queued) : true;
      for (const q of queued) publish('task.queued', `goal queued by copilot — ${q.title}`);
      if (queued.length && !board) runScannerAsync('copilot queued goals'); // board was for another repo
      return { queued: queued.map((q) => q.title), blocked: false };
    };
    // ```fix fences: agent-fixable issues land under Needs work on the board —
    // no mid-run block needed (findings.json lives in .workloop/, outside the
    // tree the agent is editing)
    const onFixes = (fixes) => {
      const live = readCfg();
      const landed = [];
      for (const fx of fixes) {
        const f = landFinding(live, { source: 'copilot', ...fx });
        if (f) landed.push(f.title);
      }
      return { landed };
    };
    return Chat.send(req, res, { text: clean, cfg, context: chatContext(cfg), onGoals, onFixes });
  }
  if (req.method === 'GET' && url.pathname === '/api/chat/history') return json(res, 200, Chat.history());
  if (req.method === 'POST' && url.pathname === '/api/chat/reset') {
    const r = Chat.reset();
    // same event the repo-switch path emits — other tabs refetch history and
    // the activity log records the reset instead of silently losing the thread
    publish('chat.reset', 'chat reset — new conversation');
    return json(res, 200, r);
  }

  if (req.method === 'GET' && url.pathname === '/api/handoffs') return json(res, 200, { handoffs: Handoffs.list(readCfg().repoPath) });
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
      Platform.reveal(abs);
      return json(res, 200, { ok: true });
    }
    const tpl = (cfg.editor?.command || '').trim();
    if (tpl) {
      // quote the path so a filename containing $()/backticks/; can't be
      // interpreted by the shell that runs the (user-authored) editor template
      const quoted = Platform.isWin ? `"${abs.replaceAll('"', '')}"` : "'" + abs.replaceAll("'", "'\\''") + "'";
      const cmd = tpl.replaceAll('{path}', quoted).replaceAll('{line}', String(Number(line) || 1));
      const sh = Platform.userShell(cmd);
      spawn(sh.bin, sh.args, { ...sh.opts, env: childEnv(), stdio: 'ignore', ...Platform.detachOpts() }).unref();
    } else {
      Platform.openPath(abs); // default app; macOS retries in a text editor when nothing's associated
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/pickfolder') { // native folder dialog
    if (pickerBusy) return json(res, 200, { error: 'a folder picker is already open — check your other windows' });
    pickerBusy = true;
    const r = await Platform.pickFolder(); // async — the dialog blocks on the user, never on the bus
    pickerBusy = false;
    return json(res, 200, r);
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
    const fl = foreignRunLock();
    if (fl) return json(res, 409, { error: `a run is active in the other Workloop instance (:${fl.port}) — rescan after it finishes` });
    const scanLog = await runScannerAsync();
    return json(res, 200, { ...readTasks(), scanLog });
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const fresh = url.searchParams.get('fresh') === '1';
    // refresh the login PATH (a synchronous login-shell spawn) at most every 30s,
    // not on every 4s poll
    if (fresh && Date.now() - lastPathRefresh > 30000) { lastPathRefresh = Date.now(); loginPath(true); }
    const cfg = readCfg();
    const repo = gitInfo(cfg.repoPath);
    // Connections-panel extras: everything below is fs reads, in-memory state,
    // or one cheap local git call — NEVER a new synchronous tool spawn (this
    // endpoint is polled every 4s with fresh=1 during the login watch).
    const remote = repo.git ? ((gitIn(cfg.repoPath, ['remote', 'get-url', 'origin']).stdout || '').trim() || null) : null;
    const backlogRel = cfg.sources?.backlog || 'BACKLOG.md';
    const { last: _devLines, ...devSlim } = devStatus();
    const chatHist = Chat.history();
    return json(res, 200, {
      node: process.version,
      claude: { ...claudeInfo(cfg.agent?.command || 'claude', fresh), signedIn: loginState() },
      repo,
      remote,
      gh: ghInfo(fresh),
      verifier: verifierStatus(cfg),
      backlog: { rel: backlogRel, exists: repo.exists ? existsSync(join(cfg.repoPath, backlogRel)) : false },
      dev: devSlim,
      chat: { active: !!chatHist.sessionId, startedAt: chatHist.startedAt || null, messages: (chatHist.messages || []).length },
      openPR: !!cfg.openPR,
      port: PORT,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, readCfg());

  if (req.method === 'POST' && url.pathname === '/api/config') {
    const patch = await readBody(req);
    if (typeof patch.repoPath === 'string') patch.repoPath = patch.repoPath.trim();
    // A real repoPath must be an existing directory — it widens every downstream
    // file/exec surface, so refuse a bogus or traversal path up front.
    if (typeof patch.repoPath === 'string' && patch.repoPath && !patch.repoPath.startsWith('/ABSOLUTE')) {
      let okDir = false;
      try { okDir = lstatSync(patch.repoPath).isDirectory(); } catch { okDir = false; }
      if (!okDir) return json(res, 400, { error: `repoPath is not an existing directory: ${patch.repoPath}` });
    }
    delete patch.recentRepos;  // server-owned — only real repo switches write it
    delete patch.repoSettings; // server-owned — per-repo memory below
    const prev = readCfg();
    const switching = typeof patch.repoPath === 'string' && patch.repoPath
      && !patch.repoPath.startsWith('/ABSOLUTE') && patch.repoPath !== prev.repoPath;
    if (switching && writerBusy()) {
      return json(res, 409, { error: 'an agent is working in the current repo — switch repos after it finishes' });
    }
    const next = mergeCfg(prev, patch);
    if (switching) {
      const keep = (p) => typeof p === 'string' && p && !p.startsWith('/ABSOLUTE') && existsSync(p);
      next.recentRepos = [patch.repoPath, prev.repoPath, ...(prev.recentRepos || [])]
        .filter((p, i, a) => keep(p) && a.indexOf(p) === i).slice(0, 8);
      // per-repo memory: stash the repo we're LEAVING (hand-tuned commands and
      // all), and if we've been to the new repo before, its remembered commands
      // beat whatever re-detection just proposed. Twice-bitten: detect kept
      // clobbering a tuned `expo start --offline` with plain `npm start`.
      next.repoSettings = { ...(prev.repoSettings || {}) };
      if (keep(prev.repoPath)) next.repoSettings[prev.repoPath] = { verifier: prev.verifier, dev: prev.dev };
      const back = next.repoSettings[patch.repoPath];
      if (back) {
        next.verifier = { ...next.verifier, ...back.verifier };
        next.dev = { ...next.dev, ...back.dev };
      }
      const keepSet = new Set([patch.repoPath, ...next.recentRepos]);
      for (const k of Object.keys(next.repoSettings)) if (!keepSet.has(k)) delete next.repoSettings[k];
      if (devRunning()) stopDev(); // the running app belongs to the OLD repo
      Chat.reset();                // the --resume session is per-cwd and about the OLD repo
      publish('chat.reset', 'chat reset — repo changed');
      publish('repo.switch', `repo → ${patch.repoPath}`, { repoPath: patch.repoPath, previous: prev.repoPath });
    }
    const cfgBody = JSON.stringify(next, null, 2);
    writeFileSync(cfgPath, cfgBody);
    recordWrite(cfgPath, cfgBody); // our own save — the config watcher must not re-publish it
    if (switching) armBacklogWatch(next); // the backlog file moved with the repo
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
    const { rel, queued } = queueGoals(cfg, [clean]);
    if (!queued.length) return json(res, 400, { error: 'already queued — that goal is on the board' });
    // surgical board insert — queueing shouldn't cost a verifier re-scan
    const board = boardAddBacklog(cfg, rel, queued);
    publish('task.queued', `goal queued — ${queued[0].title}`);
    if (board) return json(res, 200, board);
    const scanLog = await runScannerAsync('queued goal'); // tasks.json was for another repo
    return json(res, 200, { ...readTasks(), scanLog });
  }

  if (req.method === 'POST' && url.pathname === '/api/task/discard') {
    if (activeRuns > 0) return json(res, 409, { error: 'an agent run is active — discard after it finishes' });
    const { id } = await readBody(req);
    const state = readTasks();
    const task = (state.tasks || []).find((t) => t.id === id);
    if (!task) return json(res, 404, { error: 'task not found — Rescan and try again' });
    if (task.column !== 'should-implement' && task.source !== 'finding') {
      return json(res, 400, { error: 'only Should-implement tasks and reported findings can be discarded' });
    }
    const cfg = readCfg();
    if (task.source === 'finding') {
      // tombstone the finding so the copilot/dev monitor can't resurrect a
      // card the user explicitly killed (MUST precede the TODO branch — a
      // finding falling through would pollute dismissed.json)
      Findings.discard(task.findingId);
    } else if (task.source === 'backlog') {
      // backlog lives in workloop's own BACKLOG.md — remove the line for real
      try {
        const file = join(cfg.repoPath, cfg.sources?.backlog || 'BACKLOG.md');
        const lines = readFileSync(file, 'utf8').split('\n');
        const matches = (l) => { const m = (l || '').match(BACKLOG_UNCHECKED_RE); return !!m && m[1].trim() === task.title; };
        const i = (task.line && matches(lines[task.line - 1])) ? task.line - 1 : lines.findIndex(matches);
        if (i >= 0) {
          lines.splice(i, 1);
          const body = lines.join('\n');
          writeFileSync(file, body);
          recordWrite(file, body);
        }
      } catch { /* backlog file missing — nothing to remove */ }
    } else {
      // TODO/FIXME comments stay in the code — just hide them from future scans
      const dismissedPath = join(__dirname, '.workloop', 'dismissed.json');
      let dismissed = [];
      try { dismissed = JSON.parse(readFileSync(dismissedPath, 'utf8')); } catch { /* none yet */ }
      dismissed.push({ file: task.file, title: task.title, at: new Date().toISOString() });
      writeJsonAtomic(dismissedPath, dismissed);
    }
    // surgical board update — no expensive verifier re-scan for a dismiss
    state.tasks = state.tasks.filter((t) => t.id !== id);
    state.meta.counts = recomputeCounts(state.tasks);
    state.meta.generatedAt = new Date().toISOString(); // bump so the client's render dedup re-renders
    writeJsonAtomic(tasksPath, state);
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
    const head = (gitIn(repoPath, ['rev-parse', '--short', 'HEAD']).stdout || '').trim() || null;
    const dirtyHash = sha1(gitIn(repoPath, ['status', '--porcelain']).stdout || '');
    const key = sha1(`${repoPath}|${head}|${dirtyHash}|${heat ? 1 : 0}`);
    if (url.searchParams.get('fresh') !== '1' && treeCache.key === key && Date.now() - treeCache.at < TREE_TTL)
      return json(res, 200, { ...treeCache.payload, cached: true });
    const built = buildRepoTree(repoPath, heat);
    const branch = (gitIn(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || null;
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
    const r = Platform.openLoginTerminal(claudeBin, join(__dirname, '.workloop'));
    if (r.error) return json(res, 400, { error: r.error });
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
      const busy = writerBlockReason(); // every git write op excludes the single writer
      if (busy) return json(res, 409, { error: `${busy} — wait for it to finish` });
      const body = await readBody(req);
      const st = gitState(repoPath);

      if (url.pathname === '/api/git/switch') {
        const branch = String(body.branch || '').trim();
        if (!BRANCH_RE.test(branch)) return json(res, 400, { error: 'invalid branch name' });
        if (st.dirty) return json(res, 400, { error: 'uncommitted changes — Commit or Discard them first' });
        const r = gitIn(repoPath, ['switch', branch]);
        if (r.status !== 0) return json(res, 400, { error: (r.stderr || 'switch failed').trim().split('\n').pop() });
        publish('git.switch', `switched to ${branch}`, { branch });
        return json(res, 200, { switched: branch, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/branch') {
        const name = String(body.name || '').trim();
        if (!BRANCH_RE.test(name)) return json(res, 400, { error: 'invalid branch name' });
        if (st.branches.includes(name)) return json(res, 400, { error: 'a branch with that name already exists' });
        // no clean-tree requirement — `switch -c` legitimately carries uncommitted changes
        const r = gitIn(repoPath, ['switch', '-c', name]);
        if (r.status !== 0) return json(res, 400, { error: (r.stderr || 'branch failed').trim().split('\n').pop() });
        publish('git.branch', `created branch ${name}`, { branch: name });
        return json(res, 200, { created: name, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/commit') {
        if (!st.dirty) return json(res, 400, { error: 'nothing to commit — tree is clean' });
        const message = String(body.message || '').trim() || await generateCommitMessage(repoPath);
        const msgFile = join(__dirname, '.workloop', 'commitmsg.txt');
        writeFileSync(msgFile, message + '\n');
        gitIn(repoPath, ['add', '-A']);
        const c = gitIn(repoPath, ['commit', '-F', msgFile]);
        if (c.status !== 0) return json(res, 400, { error: 'commit failed: ' + (c.stderr || '').trim().split('\n').pop() });
        publish('git.commit', `committed — ${message}`, { message });
        let pushed = null, pushError = null; // optional one-click flow: commit lands even if the push doesn't
        if (cfg.git?.pushOnCommit && st.remote) {
          const r = await gitInAsync(repoPath, ['push', '-u', 'origin', st.current], { timeout: 60000 });
          pushed = r.status === 0;
          if (pushed) publish('git.push', `pushed ${st.current} to origin`, { branch: st.current });
          else pushError = pushFailureMessage(r.stderr);
        }
        return json(res, 200, { message, pushed, pushError, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/merge') {
        const branch = String(body.branch || '').trim();
        if (!BRANCH_RE.test(branch)) return json(res, 400, { error: 'invalid branch name' });
        if (st.dirty) return json(res, 400, { error: 'uncommitted changes — Commit or Discard them first' });
        const main = defaultBranch(repoPath);
        if (branch === main) return json(res, 400, { error: `already on ${main} — pick a workloop branch to merge` });
        if (st.current !== main) {
          const sw = gitIn(repoPath, ['switch', main]);
          if (sw.status !== 0) return json(res, 400, { error: `could not switch to ${main}: ` + (sw.stderr || '').trim().split('\n').pop() });
        }
        const m = gitIn(repoPath, ['merge', '--no-edit', branch]);
        if (m.status !== 0) {
          const conflicts = (gitIn(repoPath, ['diff', '--name-only', '--diff-filter=U']).stdout || '').trim();
          gitIn(repoPath, ['merge', '--abort']);
          return json(res, 409, { error: `merge conflict — aborted safely. Conflicting files: ${conflicts.split('\n').slice(0, 6).join(', ') || 'unknown'}. Resolve manually or re-run the task on a fresh branch.` });
        }
        gitIn(repoPath, ['branch', '-d', branch]); // safe delete: only removes fully-merged branches
        publish('git.merge', `merged ${branch} into ${main}`, { branch, into: main });
        return json(res, 200, { merged: branch, into: main, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/discard') {
        gitIn(repoPath, ['checkout', '--', '.']);
        const left = gitState(repoPath);
        const untracked = left.changes.filter((c) => c.code === '??').map((c) => c.file);
        publish('git.discard', 'discarded uncommitted changes');
        return json(res, 200, {
          discarded: true, state: left,
          note: untracked.length ? `untracked files kept: ${untracked.slice(0, 5).join(', ')}` : null,
        });
      }

      if (url.pathname === '/api/git/push') {
        if (!st.remote) return json(res, 400, { error: 'no remote — add one first: git remote add origin <url>' });
        if (st.current === 'HEAD') return json(res, 400, { error: 'detached HEAD — switch to a branch first' });
        const r = await gitInAsync(repoPath, ['push', '-u', 'origin', st.current], { timeout: 60000 });
        if (r.status !== 0) return json(res, 400, { error: pushFailureMessage(r.stderr) });
        publish('git.push', `pushed ${st.current} to origin`, { branch: st.current });
        return json(res, 200, { pushed: true, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/sync') {
        if (st.dirty) return json(res, 400, { error: 'uncommitted changes — Commit or Discard them first' });
        if (!st.upstream) return json(res, 400, { error: 'nothing to sync — this branch has no upstream yet (Push first)' });
        const r = await gitInAsync(repoPath, ['pull', '--ff-only'], { timeout: 120000 });
        if (r.status !== 0) {
          const diverged = /not possible to fast-forward|divergent|need to specify how to reconcile/i.test(r.stderr);
          return json(res, 400, { error: diverged
            ? 'local and remote have diverged — resolve in a terminal (git pull --rebase), then come back'
            : pushFailureMessage(r.stderr) });
        }
        publish('git.sync', `synced ${st.current} from origin`, { branch: st.current });
        return json(res, 200, { synced: true, state: gitState(repoPath) });
      }

      if (url.pathname === '/api/git/pr') {
        const main = remoteDefaultBranch(repoPath);
        if (st.current === main || st.current === st.main) {
          return json(res, 400, { error: `you're on ${st.current} — create a branch first; PRs flow into ${main}` });
        }
        if (!st.remote) return json(res, 400, { error: 'no remote — add one first: git remote add origin <url>' });
        // the branch must exist on the remote: gh would prompt interactively,
        // and a compare page for an unpushed branch is empty
        if (!st.upstream || st.ahead > 0) {
          const p = await gitInAsync(repoPath, ['push', '-u', 'origin', st.current], { timeout: 60000 });
          if (p.status !== 0) return json(res, 400, { error: pushFailureMessage(p.stderr) });
          publish('git.push', `pushed ${st.current} to origin`, { branch: st.current });
        }
        const gh = await gitInAsync(repoPath, ['pr', 'create', '--fill', '--head', st.current], { timeout: 45000, bin: 'gh' });
        if (gh.errorCode !== 'ENOENT') {
          const prUrl = ((gh.stdout + '\n' + gh.stderr).match(/https?:\/\/\S+\/pull\/\d+/) || [])[0] || null;
          if (gh.status === 0 && prUrl) {
            publish('git.pr', `PR opened — ${prUrl}`, { url: prUrl });
            return json(res, 200, { url: prUrl, state: gitState(repoPath) });
          }
          if (prUrl) return json(res, 200, { url: prUrl, existing: true, state: gitState(repoPath) }); // "already exists" prints the URL
          return json(res, 400, { error: (gh.stderr.trim().split('\n').pop() || 'gh pr create failed').slice(0, 200) });
        }
        const base = githubWebBase(st.remote); // no gh installed — hand the browser a compare page
        if (!base) return json(res, 400, { error: "origin is not GitHub — open the PR in your host's UI" });
        const compareUrl = `${base}/compare/${encodeURIComponent(main)}...${encodeURIComponent(st.current)}?expand=1`;
        publish('git.pr', 'opening the compare page', { compareUrl });
        return json(res, 200, { compareUrl, state: gitState(repoPath) });
      }
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/run') {
    const id = url.searchParams.get('id') || '';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 10000\n\n');
    // One writer at a time. In-process exclusion first (specific message), then
    // the ATOMIC cross-instance lock — acquired BEFORE spawning so two instances
    // sharing this checkout can't both win the race.
    const blockEnd = (reason) => {
      publish('run.blocked', 'run blocked — another writer is active', { taskId: id });
      res.write(`data: ${JSON.stringify({ type: 'done', ok: false, reason })}\n\n`);
      res.write('event: end\ndata: {}\n\n');
      return res.end();
    };
    const local = writerBlockReason();
    if (local) return blockEnd(`${local} — wait for it to finish, then Retry`);
    const lock = acquireRunLock(id, process.pid); // placeholder pid; the real child pid is written below
    if (lock !== true) return blockEnd(`a run is active in the other Workloop instance (:${lock.port}) — wait for it, then Retry`);
    const task = (readTasks().tasks || []).find((t) => t.id === id);
    const child = spawn(process.execPath, [join(__dirname, 'runner.mjs'), id], { cwd: __dirname });
    activeRuns++;
    runnerChild = child;
    currentRun = { taskId: id, title: task?.title || id, file: task?.file || null };
    writeRunLock(id, child.pid); // replace the placeholder pid with the real runner pid (atomic)
    publish('run.start', `run started — ${currentRun.title}`, currentRun);
    let doneSeen = false;
    const mirror = (line) => { // additive bus tap — the per-run SSE stream is untouched
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'status') publish('run.status', o.message || '', { taskId: id });
      else if (o.type === 'agent') publishLine('run.agent', o.message || '', { taskId: id });
      else if (o.type === 'file' && o.path) publish('run.file', `${o.op} ${o.path}`, { taskId: id, op: o.op, path: o.path });
      else if (o.type === 'done' && !doneSeen) {
        doneSeen = true;
        publish('run.done',
          o.ok ? `run complete — ${currentRun.title}` : `run needs you — ${o.reason || 'stopped'}`,
          { taskId: id, ok: !!o.ok, verified: !!o.verified, reason: o.reason, branch: o.branch, pr: o.pr, note: o.note });
        setLastRun({ taskId: id, title: currentRun?.title || id, ok: !!o.ok, verified: !!o.verified, reason: o.reason || null, branch: o.branch || null, pr: o.pr || null, note: o.note || null });
        // a finding fixed by the run leaves the store — the post-run scan drops its card
        if (o.ok && task?.findingId) Findings.resolve(task.findingId);
        if (!o.ok) Handoffs.fromRunFailure(id, currentRun?.title || id, o.reason, o.branch, o.log, readCfg().repoPath);
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
        setLastRun({ taskId: id, title: currentRun?.title || id, ok: false, reason: 'runner exited unexpectedly', branch: null, pr: null, note: null });
      }
      currentRun = null;
      clearRunLock();
      scheduleScanAfterRun(); // every tab re-syncs via scan.done — not just the one that clicked Run
      res.write('event: end\ndata: {}\n\n');
      res.end();
    });
    req.on('close', () => {
      // SIGTERM lets runner.mjs run its cleanup (kills the agent tree, releases
      // the lock) and exit; escalate to SIGKILL if it's still alive after a grace.
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { if (runnerChild === child && child.exitCode === null) { try { Platform.killTree(child, 'SIGKILL'); } catch { /* gone */ } } }, 4000).unref?.();
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is busy — is Workloop already running? Try: PORT=4318 npm start\n`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  const cfg = readCfg();
  console.log(`\n  WORKLOOP  ->  http://localhost:${PORT}`);
  publish('server.start', 'workloop online', { bootId, port: PORT });
  ghInfo(false); // pre-warm the gh probe so the Connections row is settled by first paint
  initStateWatchers(); // cross-instance/external sync — after boot state is loaded
  if (cfg.repoPath && !cfg.repoPath.startsWith('/ABSOLUTE') && existsSync(cfg.repoPath)) {
    console.log(`  repo: ${cfg.repoPath}`);
    runScannerAsync('boot').then(() => console.log('  initial scan complete'));
  } else {
    console.log('  repo: not set — the dashboard will walk you through Setup\n');
  }
});
