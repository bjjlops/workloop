// env.mjs — shared environment helpers.
// Fixes the classic Mac problem: processes launched outside an interactive
// terminal don't see your login PATH, so `claude` (and nvm node) "don't exist".
// We capture the login-shell PATH once, and auto-discover the claude binary.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWin, spawnToolSync } from './platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cacheFile = join(__dirname, '.workloop', 'env.json');

function readCache() {
  try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return {}; }
}
function saveCache(extra) {
  try {
    mkdirSync(join(__dirname, '.workloop'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify({ ...readCache(), ...extra }, null, 2));
  } catch { /* non-fatal */ }
}
const expandTilde = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1)) : p);

/** Split an engine command like "claude --model x --effort high" into binary + flags. */
export function splitCommand(cmd = 'claude') {
  const parts = String(cmd || 'claude').trim().split(/\s+/).filter(Boolean);
  return { bin: parts[0] || 'claude', extraArgs: parts.slice(1) };
}

/** The user's real login-shell PATH (zsh first — macOS default — then bash).
    Windows has no login-shell PATH problem: the process env is already right. */
export function loginPath(force = false) {
  if (isWin) return process.env.PATH || '';
  if (!force) {
    const c = readCache();
    if (c.path) return c.path;
  }
  for (const [shell, args] of [['zsh', ['-lc', 'echo -n "$PATH"']], ['bash', ['-lc', 'echo -n "$PATH"']]]) {
    try {
      const r = spawnSync(shell, args, { encoding: 'utf8', timeout: 8000 });
      const p = (r.stdout || '').trim();
      if (r.status === 0 && p.includes('/')) { saveCache({ path: p }); return p; }
    } catch { /* try next shell */ }
  }
  return process.env.PATH || '';
}

/** Env for child processes: current env + login PATH merged in front. */
export function childEnv(force = false) {
  const seen = new Set();
  const merged = [...loginPath(force).split(delimiter), ...(process.env.PATH || '').split(delimiter)]
    .filter((p) => p && !seen.has(p) && (seen.add(p) || true)).join(delimiter);
  return { ...process.env, PATH: merged };
}

/** Find the claude binary. Order: explicit config path -> cache -> login PATH -> known installs. */
export function resolveClaude(cfgCommand = 'claude', force = false) {
  const { bin } = splitCommand(cfgCommand);
  const explicit = expandTilde(bin);
  if (explicit && /[\\/]/.test(explicit) && existsSync(explicit)) { saveCache({ claude: explicit }); return explicit; }

  if (!force) {
    const c = readCache();
    if (c.claude && existsSync(c.claude)) return c.claude;
  }

  try {
    if (isWin) {
      // `where` lists every match; prefer the native .exe over the npm .cmd shim
      const r = spawnSync('where.exe', [bin], { encoding: 'utf8', env: childEnv(force), timeout: 8000 });
      const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const pick = hits.find((h) => h.toLowerCase().endsWith('.exe')) || hits.find((h) => h.toLowerCase().endsWith('.cmd')) || hits[0];
      if (pick && existsSync(pick)) { saveCache({ claude: pick }); return pick; }
    } else {
      const r = spawnSync('bash', ['-c', `command -v ${bin}`], { encoding: 'utf8', env: childEnv(force), timeout: 8000 });
      const p = (r.stdout || '').trim();
      if (p && existsSync(p)) { saveCache({ claude: p }); return p; }
    }
  } catch { /* fall through to known locations */ }

  const home = homedir();
  const candidates = isWin
    ? [
      join(home, '.local', 'bin', 'claude.exe'),
      join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
    ]
    : [
      join(home, '.claude', 'local', 'claude'),
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      join(home, '.local', 'bin', 'claude'),
      join(home, '.npm-global', 'bin', 'claude'),
    ];
  if (!isWin) {
    try {
      const nvmBase = join(home, '.nvm', 'versions', 'node');
      if (existsSync(nvmBase)) for (const v of readdirSync(nvmBase)) candidates.push(join(nvmBase, v, 'bin', 'claude'));
    } catch { /* no nvm */ }
  }
  for (const c of candidates) if (existsSync(c)) { saveCache({ claude: c }); return c; }
  return null;
}

/** Path + version info for the status check. */
export function claudeInfo(cfgCommand = 'claude', force = false) {
  const path = resolveClaude(cfgCommand, force);
  if (!path) return { found: false, path: null, version: null };
  try {
    const r = spawnToolSync(path, ['--version'], { encoding: 'utf8', env: childEnv(), timeout: 10000 });
    const version = ((r.stdout || r.stderr || '').trim().split('\n')[0] || null);
    return { found: true, path, version, ok: r.status === 0, supportsEffort: supportsEffort(path, force) };
  } catch {
    return { found: true, path, version: null, ok: false, supportsEffort: null };
  }
}

/** Does this CLI accept --effort? Unknown flags HARD-ERROR every run on older
    builds, so the settings UI gates the effort picker on this (cached). */
function supportsEffort(path, force = false) {
  if (!force) {
    const c = readCache();
    if (typeof c.supportsEffort === 'boolean' && c.supportsEffortFor === path) return c.supportsEffort;
  }
  try {
    const r = spawnToolSync(path, ['--help'], { encoding: 'utf8', env: childEnv(), timeout: 10000, maxBuffer: 1024 * 1024 });
    const yes = /--effort\b/.test((r.stdout || '') + (r.stderr || ''));
    saveCache({ supportsEffort: yes, supportsEffortFor: path });
    return yes;
  } catch { return null; } // unknown — UI treats null as "don't gate"
}
