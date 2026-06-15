#!/usr/bin/env node
// loop/pipeline.mjs <taskId> [--prompt-file P] — run ONE task through the full
// loop-engineering pipeline and emit the SAME newline-delimited JSON the classic
// runner does, so server.mjs streams it unchanged:
//
//   worktree (L2) → plan (L3) → write (L4) → check (L5, retry ≤ maxRetries)
//                 → merge/PR (L2.3) → teardown (L2.4) → feedback (L7)
//
// New optional NDJSON types this emits beyond the classic {status,agent,file,
// done}: {type:'phase',phase} (lets the server heartbeat the run lock),
// {type:'plan',path}, {type:'check',ok,notes}, {type:'retry',n}. The server
// forwards unknown types to the browser untouched and republishes these to the
// activity bus.
//
// Safety stance inherited from runner.mjs: the agent only ever produces a branch
// + local commit (in an isolated worktree, so the main checkout is never dirtied)
// and optionally a PR. It never merges into your working branch, deploys, or runs
// migrations — the operator does that.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv, resolveClaude, splitCommand } from '../env.mjs';
import { runAgent, runArgs, killAllAgents, tail } from './agent.mjs';
import * as worktree from './worktree.mjs';
import * as plan from './plan.mjs';
import * as checker from './checker.mjs';
import * as memory from './memory.mjs';
import * as feedback from './feedback.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const cfg = JSON.parse(readFileSync(join(root, 'workloop.config.json'), 'utf8'));
const repo = cfg.repoPath;
const loop = cfg.loop || {};
const ENV = childEnv();
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const taskId = process.argv[2];
const promptFileArg = (() => { const i = process.argv.indexOf('--prompt-file'); return i >= 0 ? process.argv[i + 1] : null; })();

process.on('SIGTERM', () => { killAllAgents(); process.exit(143); });
process.on('SIGINT', () => { killAllAgents(); process.exit(130); });

const slug = (s) => ((s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task');
const git = (cwd, args) => runArgs('git', args, { cwd, env: ENV });
const COMMIT_TYPE = { typescript: 'fix', test: 'fix', lint: 'style', build: 'fix', todo: 'chore', backlog: 'feat', finding: 'fix' };

function buildWriterPrompt(task, { conventions, targetConventions, planText, retryNotes }) {
  if (promptFileArg && existsSync(promptFileArg) && !retryNotes) {
    try { return readFileSync(promptFileArg, 'utf8'); } catch { /* fall through to built-in */ }
  }
  const dod = task.verifiable
    ? `DEFINITION OF DONE: the command \`${task.verifyCmd}\` exits 0 with no errors.`
    : task.source === 'finding'
      ? `DEFINITION OF DONE: the reported issue above is fixed. There is no automated check, so make the complete fix and clearly summarize what you changed.`
      : `DEFINITION OF DONE: implement the task above. There is no automated check, so make your best, complete change and clearly summarize what (if anything) remains.`;
  const loopRule = task.verifiable
    ? `- After editing, run \`${task.verifyCmd}\` yourself and read the output. If it still fails, fix and re-run.`
    : `- Make the change carefully and keep it tightly scoped to this task.`;
  const todoRule = task.source === 'todo' ? `\n- When done, delete the TODO/FIXME/HACK comment itself at the location above.` : '';
  const loc = task.file ? `LOCATION: ${task.file}${task.line ? ':' + task.line : ''}\n` : '';
  const ctx = task.detail ? `CONTEXT:\n${task.detail}\n` : '';
  const conv = conventions ? `\nREPO CONVENTIONS (CLAUDE.md — follow these):\n${conventions}\n` : '';
  const tconv = targetConventions ? `\nTARGET PROJECT CONVENTIONS (its own CLAUDE.md):\n${targetConventions}\n` : '';
  const planBlock = planText ? `\nAPPROVED PLAN (follow it; deviate only with reason):\n${planText}\n` : '';
  const retryBlock = retryNotes ? `\nA CHECKER REVIEWED YOUR PREVIOUS ATTEMPT AND FOUND PROBLEMS. Fix exactly these:\n${retryNotes}\n` : '';
  return `You are the WRITER in an autonomous fix loop, working inside an isolated git worktree.

TASK: ${task.title}
${loc}${ctx}${conv}${tconv}${planBlock}${retryBlock}
${dod}

RULES:
${loopRule}${todoRule}
- Change only what this task needs. Do not touch unrelated files.
- Do NOT commit, push, merge, deploy, or run migrations — the pipeline handles git.
- When finished, give a one-paragraph summary of what you changed.`;
}

// Backlog tasks: tick off the implemented item so the next scan drops it.
function tickBacklog(cwd, task) {
  if (task.source !== 'backlog') return;
  try {
    const blFile = join(cwd, cfg.sources?.backlog || 'BACKLOG.md');
    const lines = readFileSync(blFile, 'utf8').split('\n');
    const matches = (l) => { const m = (l || '').match(/^\s*[-*]\s+\[ \]\s+(.*)$/); return !!m && m[1].trim() === task.title; };
    const i = (task.line && matches(lines[task.line - 1])) ? task.line - 1 : lines.findIndex(matches);
    if (i >= 0) { lines[i] = lines[i].replace('[ ]', '[x]'); writeFileSync(blFile, lines.join('\n')); }
  } catch { /* no backlog file — nothing to tick */ }
}

async function runWriter(task, wt, engine, promptParts) {
  emit({ type: 'phase', phase: 'write' });
  emit({ type: 'status', message: 'Writer: implementing in worktree...' });
  const res = await runAgent({
    claudeBin: engine.claudeBin, extraArgs: engine.extraArgs,
    prompt: buildWriterPrompt(task, promptParts),
    allowedTools: cfg.agent.allowedTools, permissionMode: cfg.agent.permissionMode,
    maxTurns: cfg.agent.maxTurns, stream: cfg.agent.stream !== false,
    cwd: wt.path, root: wt.path, env: ENV, emit,
  });
  if (res.error) return { ok: false, reason: res.error };
  if (res.sawAuthError) return { ok: false, reason: 'engine is not logged in — open Terminal, run `claude`, /login, then Retry', auth: true };
  return { ok: true };
}

function commitWorktree(task, wt) {
  if (!git(wt.path, ['status', '--porcelain']).out.trim()) return { ok: false, reason: 'no file changes were made' };
  tickBacklog(wt.path, task);
  const type = COMMIT_TYPE[task.source] || 'chore';
  const subject = `${type}: ${task.title.slice(0, 72)}`;
  git(wt.path, ['add', '-A']);
  const c = git(wt.path, ['commit', '-m', subject, '-m', `[workloop] task ${task.id}`]);
  if (c.code !== 0) return { ok: false, reason: 'commit failed', log: tail(c.err) };
  emit({ type: 'status', message: `Committed: ${subject}` });
  return { ok: true, subject };
}

(async () => {
  let wt = null;
  try {
    if (!loop.enabled && process.env.WORKLOOP_LOOP_FORCE !== '1')
      return emit({ type: 'done', ok: false, reason: 'loop mode is disabled — set loop.enabled in workloop.config.json' });

    const state = JSON.parse(readFileSync(join(root, '.workloop', 'tasks.json'), 'utf8'));
    const task = (state.tasks || []).find((t) => t.id === taskId);
    if (!task) return emit({ type: 'done', ok: false, reason: 'task not found — Rescan and try again' });
    if (!existsSync(repo)) return emit({ type: 'done', ok: false, reason: `repoPath not found: ${repo}` });
    if (git(repo, ['rev-parse', '--is-inside-work-tree']).code !== 0)
      return emit({ type: 'done', ok: false, reason: 'repoPath is not a git repository' });

    const { bin, extraArgs } = splitCommand(cfg.agent.command || 'claude');
    const claudeBin = resolveClaude(bin);
    if (!claudeBin) return emit({ type: 'done', ok: false, reason: 'Claude Code CLI not found — set the full path in Settings → Engine command, then Recheck.' });
    const engine = { claudeBin, extraArgs };
    emit({ type: 'status', message: `Engine: ${claudeBin}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}` });

    // ---- L2: worktree off the current main HEAD ----
    emit({ type: 'phase', phase: 'worktree' });
    const base = (git(repo, ['rev-parse', 'HEAD']).out || 'HEAD').trim();
    const branch = `${cfg.branchPrefix}/${task.source}-${slug(task.title)}-${task.id.slice(0, 4)}`;
    const linkDirs = loop.worktrees === false ? [] : (loop.linkDirs || ['node_modules']);
    wt = worktree.create(repo, task.id, { base, branch, linkDirs });
    if (!wt.ok) return emit({ type: 'done', ok: false, reason: wt.reason });
    emit({ type: 'status', message: `Worktree: ${wt.path} (branch ${branch})` });
    const depFail = wt.linked.find((l) => l.dir === 'node_modules' && l.error);
    const verifyMode = depFail ? 'main-checkout-fallback' : 'worktree';
    if (depFail) emit({ type: 'status', message: `Could not link node_modules (${depFail.error}) — verifier commands will be skipped; verify the branch manually.` });

    // ---- L3: plan (the checkpoint) ----
    emit({ type: 'phase', phase: 'plan' });
    emit({ type: 'status', message: 'Planner: drafting plan...' });
    const planRes = await plan.makePlan({ task, repo, cwd: wt.path, root: wt.path, claudeBin, extraArgs, env: ENV, maxTurns: cfg.agent.maxTurns, emit });
    if (!planRes.ok) { await finish(false, { reason: planRes.error || 'planning failed', branch }); return; }
    emit({ type: 'plan', path: planRes.path, summary: planRes.plan.slice(0, 200) });
    // Checkpoint: headless auto-approves; human approval is scaffolded (see /api/loop/approve).
    if (loop.autoApprovePlan === false) emit({ type: 'status', message: 'Plan awaiting approval (auto-approving — human gate not yet wired)' });

    const promptParts = {
      conventions: memory.conventions(),
      targetConventions: memory.readTargetConventions(repo),
      planText: planRes.plan,
    };

    // ---- L4 + L5: write → check, retry on checker failure ----
    const maxRetries = Number.isFinite(loop.maxRetries) ? loop.maxRetries : 2;
    const verifiers = verifierMap(repo);
    let attempt = 0, lastCheck = null;
    while (attempt <= maxRetries) {
      if (attempt > 0) emit({ type: 'retry', n: attempt });
      const w = await runWriter(task, wt, engine, attempt === 0 ? promptParts : { ...promptParts, retryNotes: checker.formatNotes(lastCheck.notes) });
      if (!w.ok) { await finish(false, { reason: w.reason, branch, log: w.log }); return; }
      const committed = commitWorktree(task, wt);
      if (!committed.ok) { await finish(false, { reason: committed.reason, branch, log: committed.log }); return; }

      emit({ type: 'phase', phase: 'check' });
      lastCheck = await checker.check({
        repo, cwd: wt.path, base, head: 'HEAD', task,
        verifiers: verifyMode === 'main-checkout-fallback' ? {} : verifiers,
        engine, env: ENV, emit, verifyMode,
      });
      emit({ type: 'check', ok: lastCheck.ok, mode: lastCheck.mode, notes: lastCheck.notes });
      if (lastCheck.ok) break;
      emit({ type: 'status', message: `Checker found issues:\n${checker.formatNotes(lastCheck.notes)}` });
      attempt++;
    }

    const passed = lastCheck.ok;
    const changed = lastCheck.files || [];

    // ---- L2.3: merge/PR (never auto-merge into the working branch) ----
    emit({ type: 'phase', phase: 'merge' });
    let pr = null, note = null;
    if (passed && cfg.openPR) {
      emit({ type: 'status', message: 'Pushing and opening PR...' });
      const p = git(wt.path, ['push', '-u', 'origin', branch]);
      if (p.code !== 0) { note = 'committed on branch; push failed: ' + tail(p.err, 4); }
      else { const r = runArgs('gh', ['pr', 'create', '--fill', '--head', branch], { cwd: wt.path, env: ENV }); pr = (r.out.match(/https?:\/\/\S+/) || [])[0] || null; if (!pr) note = 'pushed; open the PR in your host UI'; }
    } else if (passed) {
      note = 'committed on branch — checker passed; test it with Run locally, PR when ready';
    } else {
      note = `checker still failing after ${maxRetries} retr${maxRetries === 1 ? 'y' : 'ies'} — branch left for inspection: ${checker.formatNotes(lastCheck.notes)}`;
    }

    await finish(passed, { branch, pr, note, retries: attempt, notes: passed ? 'none' : checker.formatNotes(lastCheck.notes), files: changed });
  } catch (e) {
    await finish(false, { reason: e.message });
  }

  // ---- L2.4 teardown + L7 feedback + done ----
  async function finish(ok, o = {}) {
    if (wt && wt.ok) {
      const keep = !ok && loop.teardownOnFail === false;
      if (!keep) worktree.remove(repo, taskId);
      else emit({ type: 'status', message: `Worktree kept for inspection: ${wt.path}` });
    }
    try {
      feedback.recordRun({
        date: new Date().toISOString().slice(0, 19) + 'Z',
        title: (readTaskTitle() || taskId),
        result: ok ? 'PASS' : 'FAIL',
        retries: o.retries || 0,
        notes: o.notes || o.reason || 'none',
        files: o.files || [],
        lesson: ok && (o.retries ? `task "${readTaskTitle()}" passed after ${o.retries} checker retr${o.retries === 1 ? 'y' : 'ies'}` : null),
      });
    } catch (e) { emit({ type: 'status', message: `feedback write failed: ${e.message}` }); }
    emit({ type: 'done', ok, ...o });
  }
  function readTaskTitle() {
    try { return (JSON.parse(readFileSync(join(root, '.workloop', 'tasks.json'), 'utf8')).tasks || []).find((t) => t.id === taskId)?.title; } catch { return null; }
  }
})();

function verifierMap(r) {
  const rs = (cfg.repoSettings && cfg.repoSettings[r]) || {};
  return rs.verifier || cfg.verifier || {};
}
