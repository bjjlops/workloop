// loop/agent.mjs — the shared headless-agent core for every loop stage and the
// classic runner. ONE place owns: spawning the engine, parsing its stream-json,
// mapping the agent's absolute file paths back to repo-relative for the galaxy,
// the false-"not logged in" sniff fix, and forwarding kill signals to the child
// so we never orphan a writing agent.
//
// Extracted from runner.mjs (the original lines 24-93,152-174) so the loop
// pipeline (plan/writer/checker) and the classic runner share one battle-tested
// implementation instead of forking the careful edge-case handling.
//
// No app-module imports except platform.mjs (process spawning is OS-specific) —
// this sits low in the dep graph so runner.mjs, pipeline.mjs, plan.mjs and
// checker.mjs can all import it.

import { spawnSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { spawnTool, userShell } from '../platform.mjs';

// ---------- process helpers (mirror runner.mjs's shArgs / sh) ----------
// runArgs: argv form, NO shell — use whenever an argument carries user/scan text
// (task titles, branch names, prompts) so shell metacharacters can't be read.
export function runArgs(file, args, { cwd, env } = {}) {
  const r = spawnSync(file, args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 30, env });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}
// runShell: a USER-AUTHORED command string (verifiers, dev command) — a shell is
// correct by definition here because the user wrote shell syntax.
export function runShell(cmd, { cwd, env } = {}) {
  const s = userShell(cmd);
  const r = spawnSync(s.bin, s.args, { ...s.opts, cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 30, env });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}

export const tail = (s, n = 20) => String(s || '').split('\n').filter((l) => l.trim()).slice(-n).join('\n');

// ---------- kill forwarding ----------
// Every live engine child registers here so a SIGTERM/SIGINT to the pipeline (or
// runner) process kills the agent instead of leaving it editing the tree as an
// orphan. The pipeline can run several agents in sequence (plan, write, check,
// retries) — track all of them.
const liveChildren = new Set();
export function killAllAgents(sig = 'SIGKILL') {
  for (const c of liveChildren) { try { c.kill(sig); } catch { /* gone */ } }
}

// ---------- file-event mapping ----------
// tool name -> galaxy stream meaning. Bash is deliberately absent: a shell
// command may touch many files or none — git polling attributes those instead.
const FILE_OPS = { Read: 'read', Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit' };

// The agent reports CANONICAL absolute paths (macOS: /tmp -> /private/tmp, and
// os.tmpdir() worktrees live under /var/folders -> /private/var). Match against
// the run root AND its realpath, or file events vanish silently. The remainder
// after stripping the root is the SAME repo-relative path whether the file was
// touched in the main checkout or in a worktree (a worktree mirrors the tree),
// so the galaxy lights the same node either way.
export function makeFileMapper(root) {
  const roots = [root];
  try { const real = realpathSync(root); if (real !== root) roots.push(real); } catch { /* root may not exist yet */ }
  return function relToRoot(p) {
    for (const r of roots) if (p.startsWith(r + '/')) return p.slice(r.length + 1);
    return null; // outside the run root (e.g. a Read through a node_modules symlink) — nothing to light up
  };
}

const isAuthError = (s) => /not logged in|please run \/login/i.test(s);

// Parse ONE stream-json line into { agent?, file? } events and accumulated text.
// `emit` receives {type:'agent'|'file', ...}; `onText` receives assistant prose
// so a caller (the checker) can read the agent's verdict. `relToRoot` maps file
// paths; auth() flags a real sign-in failure.
function handleLine(line, { emit, onText, relToRoot, auth }) {
  if (!line.trim()) return;
  let o;
  try { o = JSON.parse(line); }
  catch {
    // Non-JSON stdout is the CLI itself talking — the ONLY stdout where a real
    // "not logged in" can appear. JSON lines carry the agent's file reads/edits,
    // and files in a repo legitimately contain "/login" (regexes etc.) — sniffing
    // them aborts healthy runs with a false "engine is not logged in".
    auth(line);
    emit({ type: 'agent', message: line.slice(0, 300) });
    return;
  }
  if (o.type === 'assistant' && o.message?.content) {
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) { onText?.(b.text); emit({ type: 'agent', message: b.text.trim().slice(0, 400) }); }
      else if (b.type === 'tool_use') {
        emit({ type: 'agent', message: `> ${b.name}${b.input?.command ? ': ' + String(b.input.command).slice(0, 90) : ''}` });
        const op = FILE_OPS[b.name];
        let p = b.input?.file_path || b.input?.path;
        if (op && typeof p === 'string') {
          if (p.startsWith('/')) p = relToRoot(p);
          if (p) emit({ type: 'file', op, path: p });
        }
      }
    }
  } else if (o.type === 'result' && o.subtype && o.subtype !== 'success') {
    auth(`${o.subtype} ${o.result || ''}`); // a FAILED result's own text is the CLI's error, not file content
    emit({ type: 'agent', message: `result: ${o.subtype}` });
  }
}

/**
 * Run one headless agent to completion.
 *
 * @param {object} o
 * @param {string} o.claudeBin   resolved engine path (from env.resolveClaude)
 * @param {string[]} o.extraArgs model/effort/flags (from env.splitCommand)
 * @param {string} o.prompt      the full prompt (-p)
 * @param {string} o.allowedTools e.g. "Read,Edit,Bash" (writer) or "Read,Glob,Grep" (plan/checker)
 * @param {string} o.permissionMode e.g. "acceptEdits" (writer) or "plan"/"default" (read-only stages)
 * @param {number} o.maxTurns
 * @param {boolean} [o.stream=true] request stream-json; false treats stdout as raw text
 * @param {string} o.cwd          where the agent runs (worktree root or repo)
 * @param {object} o.env
 * @param {string} [o.root=cwd]   root for file-path -> relative mapping (the worktree/repo)
 * @param {(o:object)=>void} o.emit  sink for {type:'agent'|'file'} events
 * @returns {Promise<{code:number, sawAuthError:boolean, text:string}>}
 */
export function runAgent(o) {
  const { claudeBin, extraArgs = [], prompt, allowedTools, permissionMode, maxTurns, cwd, env } = o;
  const stream = o.stream !== false;
  const root = o.root || cwd;
  const emit = o.emit || (() => {});
  const relToRoot = makeFileMapper(root);
  let sawAuthError = false;
  const auth = (s) => { if (isAuthError(s)) sawAuthError = true; };
  let text = '';
  const onText = (t) => { text += t; };

  const args = ['-p', prompt, '--allowedTools', allowedTools, '--permission-mode', permissionMode, '--max-turns', String(maxTurns)];
  if (stream) args.push('--output-format', 'stream-json', '--verbose');
  args.push(...extraArgs);

  return new Promise((resolve) => {
    let child;
    try { child = spawnTool(claudeBin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, sawAuthError, text, error: `could not start engine: ${e.message}` }); }
    liveChildren.add(child);
    child.on('error', (e) => {
      liveChildren.delete(child);
      resolve({ code: -1, sawAuthError, text, error: `engine failed to launch (${e.code || e.message})` });
    });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); handleLine(line, { emit, onText, relToRoot, auth }); }
    });
    child.stderr.on('data', (d) => { const m = d.toString().trim(); auth(m); if (m) emit({ type: 'agent', message: m.slice(0, 300) }); });
    child.on('close', (c) => { liveChildren.delete(child); resolve({ code: c ?? -1, sawAuthError, text }); });
  });
}

// Re-export the spawn helpers callers occasionally need for async git network ops.
export { spawn };
