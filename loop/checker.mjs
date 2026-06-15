#!/usr/bin/env node
// loop/checker.mjs — the Checker (Layer 5). ALWAYS a separate process from the
// writer, with a different job: find failures, not ship code. It never edits.
//
// Sequence (5.3): a) read the diff + changed files; b) lint / type-check / static
// analysis (node --check on changed .mjs + the repo's verifier commands);
// c) the existing test suite; d) an ADVERSARIAL read-only agent that checks the
// change actually satisfies the task intent and scans adjacent files for
// regressions. Returns { ok, notes[] }. On any failure the pipeline feeds the
// notes back to the writer as the next prompt (5.4); on a full pass it marks the
// task done (5.5). Either way the outcome lands in CLAUDE.md (5.6).
//
// Usable two ways:
//   • imported  — pipeline calls check({...}) and owns the CLAUDE.md entry
//   • standalone — `node loop/checker.mjs [taskId] [--diff] [--repo P] [--static]`
//     checks a branch (or the uncommitted working tree) and records its own
//     Run Log entry, so you can run the Checker by hand before trusting the loop.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv, resolveClaude, splitCommand } from '../env.mjs';
import { runAgent, runArgs, runShell, tail } from './agent.mjs';
import * as memory from './memory.mjs';
import * as feedback from './feedback.mjs';

const CHECK_TOOLS = 'Read,Glob,Grep';

const git = (cwd, args) => runArgs('git', args, { cwd, env: childEnv() });

// scanner.mjs's rule: a verifier command whose npm script doesn't exist is
// skipped, not treated as a failure.
function runnable(cmd, scripts) {
  if (!cmd) return false;
  const m = cmd.match(/^npm\s+(?:run\s+)?([\w:.-]+)/);
  if (m) { const s = scripts[m[1]]; if (!s || (m[1] === 'test' && /no test specified/i.test(s))) return false; }
  return true;
}
function repoScripts(repo) {
  try { return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts || {}; } catch { return {}; }
}

function changedFiles(cwd, base, head) {
  const args = head ? ['diff', '--name-only', base, head] : ['diff', '--name-only', base || 'HEAD'];
  const r = git(cwd, args);
  return r.out.split('\n').map((s) => s.trim()).filter(Boolean);
}
function diffText(cwd, base, head, max = 8000) {
  const args = head ? ['diff', base, head] : ['diff', base || 'HEAD'];
  return tail(git(cwd, args).out, 400).slice(0, max);
}

function buildIntentPrompt(task, files, diff) {
  const t = task ? `TASK THE WRITER WAS GIVEN: ${task.title}\n${task.detail ? task.detail + '\n' : ''}` : '';
  return `You are an ADVERSARIAL code reviewer. Your ONLY job is to find reasons this change is WRONG, INCOMPLETE, or RISKY. Do not be agreeable. Do not praise. If it is fine, say so plainly, but look hard first.

${t}
FILES CHANGED:
${files.map((f) => '- ' + f).join('\n') || '(none)'}

DIFF (truncated):
${diff || '(empty)'}

Do this:
1. Read the changed files in full (and any file that imports them) to judge whether the change actually does what the task asked.
2. Look for: logic errors, half-done work, broken call sites, regressions in adjacent code, missed edge cases, and anything that contradicts the repo's conventions.
3. Be specific — cite file:line.

End with EXACTLY one line:
VERDICT: PASS   (only if you found nothing that should block)
or
VERDICT: FAIL — <one-sentence reason>
Then, if FAIL, a short bullet list of the specific problems for the writer to fix.`;
}

/**
 * Run the checker. Pure function — never edits, never records to CLAUDE.md
 * (the caller owns that). Returns { ok, notes:[{stage,ok,detail}], mode }.
 * @param {object} o
 *  repo       target repo (for package.json scripts / fallback verify)
 *  cwd        where to run checks (the worktree, or repo for an uncommitted diff)
 *  base,head  diff endpoints; head=null means "uncommitted working tree"
 *  task       { title, detail } | null
 *  verifiers  { typecheck, test, lint, build } commands to gate on
 *  engine     { claudeBin, extraArgs } | null  (null skips the adversarial agent)
 *  env, emit
 *  staticOnly skip the adversarial agent even if engine is present
 *  verifyMode 'worktree' | 'main-checkout-fallback' (recorded in notes only)
 */
export async function check(o) {
  const { repo, cwd, base, head = null, task = null, verifiers = {}, engine = null, env = childEnv(), emit = () => {}, staticOnly = false, verifyMode = 'worktree', verifyTimeoutMs = 10 * 60 * 1000 } = o;
  const notes = [];
  const files = changedFiles(cwd, base, head);
  emit({ type: 'status', message: `Checker: ${files.length} changed file(s)` });
  notes.push({ stage: 'diff', ok: true, detail: `${files.length} file(s): ${files.slice(0, 12).join(', ')}` });

  // (b) node --check on changed .mjs — workloop's de-facto syntax/type gate.
  const mjs = files.filter((f) => f.endsWith('.mjs'));
  for (const f of mjs) {
    if (!existsSync(join(cwd, f))) continue; // deleted
    const r = runArgs(process.execPath, ['--check', f], { cwd, env });
    const ok = r.code === 0;
    if (!ok) { emit({ type: 'status', message: `node --check FAILED: ${f}` }); notes.push({ stage: 'syntax', ok, detail: `${f}: ${tail(r.err, 4)}` }); }
  }
  if (mjs.length && !notes.some((n) => n.stage === 'syntax')) notes.push({ stage: 'syntax', ok: true, detail: `node --check passed on ${mjs.length} .mjs file(s)` });

  // (b/c) verifier commands (typecheck / lint / build / test). A missing npm
  // script is skipped, not failed. Run where node_modules is available.
  const scripts = repoScripts(repo);
  for (const [label, cmd] of Object.entries(verifiers)) {
    if (!runnable(cmd, scripts)) continue;
    emit({ type: 'status', message: `Checker verifying: ${cmd}` });
    const r = runShell(cmd, { cwd, env, timeout: verifyTimeoutMs });
    const ok = r.code === 0;
    notes.push({ stage: `verify:${label}`, ok, detail: ok ? `${cmd} passed` : `${cmd} failed (${verifyMode}):\n${tail(r.out + '\n' + r.err, 12)}` });
    if (!ok) emit({ type: 'status', message: `Verifier failed: ${cmd}` });
  }

  // (d/e) adversarial intent + adjacent-regression check.
  if (engine && !staticOnly && files.length) {
    emit({ type: 'status', message: 'Checker: adversarial review...' });
    const res = await runAgent({
      claudeBin: engine.claudeBin, extraArgs: engine.extraArgs,
      prompt: buildIntentPrompt(task, files, diffText(cwd, base, head)),
      allowedTools: CHECK_TOOLS, permissionMode: 'acceptEdits', // read-only toolset
      maxTurns: 14, stream: true, cwd, root: cwd, env, emit,
    });
    const text = (res.text || '').trim();
    const verdict = (text.match(/VERDICT:\s*(PASS|FAIL)/i) || [])[1] || (res.error ? 'FAIL' : 'PASS');
    const ok = /PASS/i.test(verdict) && !res.error && !res.sawAuthError;
    const detail = res.error ? `intent-check could not run: ${res.error}`
      : res.sawAuthError ? 'engine not logged in — intent-check skipped'
        : (text.split('VERDICT:')[1] || text).trim().slice(0, 600) || 'no notes';
    notes.push({ stage: 'intent', ok, detail });
  } else if (!engine) {
    notes.push({ stage: 'intent', ok: true, detail: 'no engine — adversarial review skipped (static-only)' });
  }

  const ok = notes.every((n) => n.ok);
  return { ok, notes, mode: verifyMode, files };
}

// Render notes into a single block for the writer's retry prompt / CLAUDE.md.
export function formatNotes(notes) {
  return notes.filter((n) => !n.ok).map((n) => `- [${n.stage}] ${n.detail}`).join('\n') || 'all checks passed';
}

// ---------- standalone CLI ----------
async function cli(argv) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = dirname(__dirname);
  const cfg = JSON.parse(readFileSync(join(root, 'workloop.config.json'), 'utf8'));
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : null; };
  const taskId = argv.find((a) => !a.startsWith('--')) || null;
  const staticOnly = !!flag('--static');
  const repo = flag('--repo') || (taskId ? cfg.repoPath : root); // default: workloop self when no task
  const branch = flag('--branch');
  const base = flag('--base') || 'HEAD';
  const cwd = flag('--worktree') || repo;

  let task = null;
  if (taskId) {
    try { task = (JSON.parse(readFileSync(join(root, '.workloop', 'tasks.json'), 'utf8')).tasks || []).find((t) => t.id === taskId) || null; } catch { /* */ }
  }
  const rs = (cfg.repoSettings && cfg.repoSettings[repo]) || {};
  const verifiers = rs.verifier || (repo === cfg.repoPath ? cfg.verifier : {});

  let engine = null;
  if (!staticOnly) {
    const { bin, extraArgs } = splitCommand(cfg.agent?.command || 'claude');
    const claudeBin = resolveClaude(bin);
    if (claudeBin) engine = { claudeBin, extraArgs };
  }

  const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
  const r = await check({
    repo, cwd, base, head: branch || null, task, verifiers, engine,
    env: childEnv(), emit, staticOnly,
  });
  emit({ type: 'check', ok: r.ok, mode: r.mode, files: r.files, notes: r.notes });

  // Standalone: record our own outcome (no pipeline owns it here).
  feedback.recordRun({
    date: new Date().toISOString().slice(0, 19) + 'Z',
    title: task?.title || `manual check (${repo === root ? 'workloop' : repo})`,
    result: r.ok ? 'PASS' : 'FAIL', retries: 0,
    notes: r.ok ? 'none' : formatNotes(r.notes),
    files: r.files,
  });
  process.exit(r.ok ? 0 : 1);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) cli(process.argv.slice(2));
