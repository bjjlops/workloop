// platform.mjs — every OS-specific behavior in one place, so the rest of the
// app stays platform-blind. macOS is the reference platform; Windows is fully
// supported; Linux is best-effort (documented in the README).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, chmodSync, symlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

export const isWin = process.platform === 'win32';
export const isMac = process.platform === 'darwin';

/* ---------- shells ----------
   userShell: run a USER-AUTHORED command string (verifiers, dev command,
   saved commands, editor templates). A shell is correct by definition here —
   the user wrote shell syntax. POSIX gets a login shell so nvm/asdf PATHs
   work; Windows gets cmd.exe.                                              */
export function userShell(cmd) {
  if (isWin) {
    return { bin: 'cmd.exe', args: ['/d', '/s', '/c', `"${cmd}"`], opts: { windowsVerbatimArguments: true } };
  }
  return { bin: 'bash', args: ['-lc', cmd], opts: {} };
}

/* ---------- tool spawns (prompt-carrying — NEVER through a shell) ----------
   On Windows, npm installs CLIs as .cmd shims, and Node (post CVE-2024-27980)
   refuses to spawn them without shell:true — but cmd.exe cannot safely receive
   arbitrary argv (e.g. `%VAR%` expands even inside quotes, and our argv
   includes full prompts). So: .exe spawns directly; an npm .cmd shim resolves
   THROUGH to the real cli.js and runs under this same node; anything else is
   a hard, explainable error rather than a quiet injection hazard.          */
function resolveToolForExec(file) {
  if (!isWin) return { file, prefixArgs: [] };
  const lower = String(file).toLowerCase();
  if (lower.endsWith('.exe')) return { file, prefixArgs: [] };
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    const cliJs = join(dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (existsSync(cliJs)) return { file: process.execPath, prefixArgs: [cliJs] };
    throw new Error(`found a .cmd shim at ${file} but couldn't resolve its script — install the native build (claude.exe) or point the engine at a full path`);
  }
  // bare names / extensionless paths: try the .exe sibling before giving up
  if (existsSync(file + '.exe')) return { file: file + '.exe', prefixArgs: [] };
  return { file, prefixArgs: [] }; // PATH lookup may still find an .exe
}
export function spawnTool(file, args, opts = {}) {
  const r = resolveToolForExec(file);
  return spawn(r.file, [...r.prefixArgs, ...args], opts);
}
export function spawnToolSync(file, args, opts = {}) {
  let r;
  try { r = resolveToolForExec(file); }
  catch (e) { return { status: -1, stdout: '', stderr: String(e.message), error: e }; }
  return spawnSync(r.file, [...r.prefixArgs, ...args], opts);
}

/* ---------- directory links (worktree dependency sharing) ----------
   The loop engine runs agents in a throwaway git worktree, which contains only
   TRACKED files — a repo's gitignored node_modules (where tsc/eslint/jest live)
   is absent, so every verifier would fail on a missing binary. We link the real
   node_modules (and any other configured cache dir) into the worktree; tools
   only READ it, so a shared link is safe for concurrent runs.

   POSIX: a directory symlink. Windows: a JUNCTION (mklink /J) — unlike a symlink
   it needs no admin/Developer-Mode privilege and reads like a real directory.
   Returns { ok:true } | { ok:true, existed:true } | { error }. Callers treat an
   error as "fall back to verifying in the main checkout" (never a hard failure). */
export function linkDir(target, link) {
  if (!existsSync(target)) return { error: `link target missing: ${target}` };
  if (existsSync(link)) return { ok: true, existed: true };
  if (isWin) {
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', 'mklink', '/J', link, target], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 10000 });
    if (r.status === 0) return { ok: true };
    return { error: ((r.stderr || r.stdout || 'mklink failed').trim().split('\n')[0] || '').slice(0, 160) };
  }
  try { symlinkSync(target, link, 'dir'); return { ok: true }; }
  catch (e) { return { error: String(e.code || e.message) }; } // EPERM / EEXIST / EXDEV — caller falls back
}

/* ---------- process-tree control ---------- */
export function detachOpts() {
  // POSIX: detached gives the child its own group so killTree(-pid) reaps the
  // whole pipeline. Windows: taskkill /T walks the tree; detached would pop
  // a console window instead.
  return { detached: !isWin };
}
export function killTree(proc, sig = 'SIGTERM') {
  if (!proc || !proc.pid) return;
  if (isWin) {
    try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { timeout: 8000 }); }
    catch { try { proc.kill(); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-proc.pid, sig); }
  catch { try { proc.kill(sig); } catch { /* gone */ } }
}

/* ---------- desktop integration ---------- */
export function reveal(absPath) { // show the file in the OS file manager
  if (isMac) { spawn('open', ['-R', absPath], { detached: true, stdio: 'ignore' }).unref(); return; }
  if (isWin) { spawn('explorer.exe', [`/select,${absPath}`], { detached: false, stdio: 'ignore' }); return; }
  spawn('xdg-open', [dirname(absPath)], { detached: true, stdio: 'ignore' }).unref();
}
export function openPath(absPath) { // open with the default app; mac falls back to a text editor
  if (isMac) {
    const o = spawn('open', [absPath], { detached: true, stdio: 'ignore' });
    o.on('exit', (code) => { if (code) spawn('open', ['-t', absPath], { detached: true, stdio: 'ignore' }).unref(); });
    o.on('error', () => { /* open(1) missing — nothing sensible left to try */ });
    o.unref();
    return;
  }
  if (isWin) { spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', `"${absPath}"`], { windowsVerbatimArguments: true, stdio: 'ignore' }); return; }
  spawn('xdg-open', [absPath], { detached: true, stdio: 'ignore' }).unref();
}
export function openURL(href) {
  if (isMac) { spawn('open', [href], { detached: true, stdio: 'ignore' }).unref(); return; }
  if (isWin) { spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', `"${href}"`], { windowsVerbatimArguments: true, stdio: 'ignore' }); return; }
  spawn('xdg-open', [href], { detached: true, stdio: 'ignore' }).unref();
}

/* ---------- native folder picker ---------- */
const PICK_PROMPT = 'Choose the repo to work on';
export function pickFolder() { // -> Promise<{path} | {cancelled:true} | {error}>
  return new Promise((resolvePick) => {
    let p;
    if (isMac) {
      p = spawn('osascript', ['-e', `POSIX path of (choose folder with prompt "${PICK_PROMPT}")`]);
    } else if (isWin) {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${PICK_PROMPT}'; if ($d.ShowDialog() -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }`;
      p = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', ps]);
    } else {
      const z = spawnSync('bash', ['-c', 'command -v zenity'], { encoding: 'utf8', timeout: 4000 });
      if (!(z.stdout || '').trim()) return resolvePick({ error: 'no folder picker available — install zenity, or paste the path into the Repo folder field' });
      p = spawn('zenity', ['--file-selection', '--directory', `--title=${PICK_PROMPT}`]);
    }
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 120000);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => { clearTimeout(timer); resolvePick({ error: 'could not open the folder picker' }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const path = out.trim().replace(/[\\/]+$/, '');
      if (code === 0 && path) return resolvePick({ path });
      if (isWin && code === 0) return resolvePick({ cancelled: true }); // dialog closed without OK
      if (/-128|cancell?ed/i.test(err) || code === 1) return resolvePick({ cancelled: true });
      resolvePick({ error: 'could not open the folder picker' });
    });
  });
}

/* ---------- engine sign-in terminal ---------- */
export function openLoginTerminal(claudeBin, stateDir) { // -> { ok } | { error }
  if (isMac) {
    // A .command file opened with Terminal needs no Automation permission
    // (AppleScript "do script" hangs on the TCC consent gate from a background process).
    const scriptPath = join(stateDir, 'login.command');
    writeFileSync(scriptPath, [
      '#!/bin/bash',
      'clear',
      "printf '\\n  Sign in to Claude Code below, then come back to Workloop and re-run your task.\\n\\n'",
      `"${claudeBin}" /login`,
      '',
    ].join('\n'));
    chmodSync(scriptPath, 0o755);
    const r = spawnSync('open', ['-a', 'Terminal', scriptPath], { encoding: 'utf8', timeout: 10000 });
    return r.status === 0 ? { ok: true } : { error: 'could not open Terminal: ' + ((r.stderr || 'unknown').trim().split('\n')[0] || '').slice(0, 140) };
  }
  if (isWin) {
    const scriptPath = join(stateDir, 'login.cmd');
    writeFileSync(scriptPath, `@echo off\r\necho Sign in to Claude Code, then close this window.\r\necho.\r\n"${claudeBin}" /login\r\npause\r\n`);
    try {
      spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', `"${scriptPath}"`], { windowsVerbatimArguments: true, stdio: 'ignore' });
      return { ok: true };
    } catch { return { error: 'could not open a terminal — run this yourself: ' + claudeBin + ' /login' }; }
  }
  return { error: `open a terminal and run: ${claudeBin} /login` };
}

/* ---------- repo-discovery skip list ---------- */
export const FIND_SKIP_EXTRA = isWin
  ? ['AppData', 'Application Data', 'OneDrive']
  : [];
export { basename }; // path-correct repo names on every OS
