#!/usr/bin/env node
// runner.mjs <taskId> — run one task to completion via headless Claude Code.
// Emits newline-delimited JSON status to stdout for the server to stream as SSE.
// Safety: only ever creates a branch + local commit (+ optional PR). Never merges,
// deploys, or runs migrations.
//
// This is the CLASSIC single-agent run path. The loop-engineering pipeline
// (loop/pipeline.mjs) is the upgraded path; both share the headless-agent core in
// loop/agent.mjs so the stream parsing, file-event mapping, auth sniffing,
// subtree-kill and agent timeout live in exactly one place.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv, resolveClaude, splitCommand } from './env.mjs';
import { runAgent, runArgs, runShell, killAllAgents, tail } from './loop/agent.mjs';
import { BACKLOG_UNCHECKED_RE } from './cards.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'workloop.config.json'), 'utf8'));
const repo = cfg.repoPath;
const taskId = process.argv[2];
const ENV = childEnv();

const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
// When the server kills this runner (tab closed / shutdown), forward the signal
// to the headless agent (and its Bash grandchildren) so nothing keeps editing the
// tree as an orphan — killAllAgents uses killTree under the hood.
process.on('SIGTERM', () => { killAllAgents(); process.exit(143); });
process.on('SIGINT', () => { killAllAgents(); process.exit(130); });

// shArgs: argv form, no shell — use whenever an argument carries user text
// (task titles, branch names) so shell metacharacters can't be interpreted.
const shArgs = (file, args) => runArgs(file, args, { cwd: repo, env: ENV });
// sh: user-authored verify commands ONLY — internal git/gh go through shArgs.
const sh = (cmd, timeout) => runShell(cmd, { cwd: repo, env: ENV, timeout });
const slug = (s) => ((s || 'task').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task');

// Wall-clock budgets so a hung agent or verifier can't hold the one-writer lock
// forever (it only releases when this process exits).
const AGENT_TIMEOUT = cfg.agent?.timeoutMs || 20 * 60 * 1000;
const VERIFY_TIMEOUT = cfg.agent?.verifyTimeoutMs || 10 * 60 * 1000;
// Discard the agent's partial edits so a failed/aborted run doesn't leave the
// tree dirty and block every subsequent run (the start guard refuses a dirty
// tree). Safe: the run refused to start unless the tree was clean, so everything
// here is this run's own work, isolated on the work branch.
const discardTree = () => { try { shArgs('git', ['reset', '--hard']); shArgs('git', ['clean', '-fd']); } catch { /* best effort */ } };

(async () => {
  try {
    const state = JSON.parse(readFileSync(join(__dirname, '.workloop', 'tasks.json'), 'utf8'));
    const task = (state.tasks || []).find((t) => t.id === taskId);
    if (!task) return emit({ type: 'done', ok: false, reason: 'task not found — Rescan and try again' });
    if (!existsSync(repo)) return emit({ type: 'done', ok: false, reason: `repoPath not found: ${repo}` });
    if (shArgs('git', ['rev-parse', '--is-inside-work-tree']).code !== 0)
      return emit({ type: 'done', ok: false, reason: 'repoPath is not a git repository' });

    // Guard: a dirty tree means this run's commit would scoop up unrelated edits.
    if (shArgs('git', ['status', '--porcelain']).out.trim())
      return emit({
        type: 'done', ok: false,
        reason: 'working tree has uncommitted changes — commit or stash them first (if a previous run left edits behind, `git checkout .` discards them)',
      });

    // Find the engine before doing anything else.
    const { bin: engineBin, extraArgs } = splitCommand(cfg.agent.command || 'claude');
    const claudeBin = resolveClaude(engineBin);
    if (!claudeBin)
      return emit({
        type: 'done', ok: false,
        reason: 'Claude Code CLI not found. I searched your login PATH and common installs (~/.claude/local, Homebrew, npm-global, nvm, ~/.local/bin). If it lives somewhere custom, set the full path in Settings → Engine command, then Recheck.',
      });
    emit({ type: 'status', message: `Engine: ${claudeBin}${extraArgs.length ? ' ' + extraArgs.join(' ') : ''}` });

    const branch = `${cfg.branchPrefix}/${task.source}-${slug(task.title)}-${task.id.slice(0, 4)}`;
    emit({ type: 'status', message: `Branch: ${branch}` });
    if (shArgs('git', ['switch', '-c', branch]).code !== 0) shArgs('git', ['switch', branch]);
    // Never run the agent on the wrong branch (e.g. main) — if neither create nor
    // switch landed us on the work branch, abort before a single edit is made.
    const onBranch = (shArgs('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out || '').trim();
    if (onBranch !== branch)
      return emit({ type: 'done', ok: false, reason: `could not create or switch to the work branch ${branch} (still on ${onBranch || 'unknown'})` });

    const dod = task.verifiable
      ? `DEFINITION OF DONE: the command \`${task.verifyCmd}\` exits 0 with no errors.`
      : task.source === 'finding'
        ? `DEFINITION OF DONE: the reported issue above is fixed. There is no automated check for this one, so make the complete fix and clearly summarize what you changed.`
        : `DEFINITION OF DONE: implement the task above. There is no automated check for this one, so make your best, complete change and clearly summarize what (if anything) remains.`;
    const loopRule = task.verifiable
      ? `- After editing, run \`${task.verifyCmd}\` yourself and read the output.\n- If it still fails, fix and re-run. Do not stop until it passes.`
      : `- Make the change carefully and keep it tightly scoped to this task.`;
    const todoRule = task.source === 'todo'
      ? `\n- When the work is done, delete the TODO/FIXME/HACK comment itself at the location above so it stops showing up in scans.`
      : '';
    const loc = task.file ? `LOCATION: ${task.file}${task.line ? ':' + task.line : ''}\n` : '';
    const ctx = task.detail ? `CONTEXT:\n${task.detail}\n` : '';
    const prompt =
`You are an autonomous fix loop working inside this repository.

TASK: ${task.title}
${loc}${ctx}
${dod}

RULES:
${loopRule}${todoRule}
- Change only what this task needs. Do not touch unrelated files.
- Do NOT commit, push, merge, deploy, or run database migrations — the operator handles git.
- When finished, give a one-paragraph summary of what you changed.`;

    emit({ type: 'status', message: 'Starting agent...' });
    const r = await runAgent({
      claudeBin, extraArgs, prompt,
      allowedTools: cfg.agent.allowedTools, permissionMode: cfg.agent.permissionMode,
      maxTurns: cfg.agent.maxTurns, stream: cfg.agent.stream !== false,
      cwd: repo, root: repo, env: ENV, emit, timeoutMs: AGENT_TIMEOUT,
    });
    if (r.timedOut) {
      discardTree(); // a SIGKILL mid-Edit can leave a half-written file — reset it
      return emit({ type: 'done', ok: false, reason: `agent exceeded the ${Math.round(AGENT_TIMEOUT / 60000)}-minute time budget — stopped and discarded partial changes`, branch });
    }
    if (r.error) return emit({ type: 'done', ok: false, reason: r.error });

    if (r.sawAuthError)
      return emit({
        type: 'done', ok: false,
        reason: 'engine is not logged in — open Terminal, run `claude`, type /login, sign in, then Retry here',
        branch,
      });

    emit({ type: 'status', message: `Agent finished (exit ${r.code}).` });

    if (task.verifiable) {
      emit({ type: 'status', message: `Verifying: ${task.verifyCmd}` });
      const v = sh(task.verifyCmd, VERIFY_TIMEOUT);
      if (v.code !== 0) {
        discardTree(); // don't leave the failed attempt's edits — they'd block the next run
        const why = v.timedOut ? `verifier timed out after ${Math.round(VERIFY_TIMEOUT / 60000)} min` : 'the verifier is still failing';
        return emit({ type: 'done', ok: false, reason: `agent finished but ${why} — discarded the partial changes so the next run can start`, branch, log: tail(`${v.out}\n${v.err}`) });
      }
      emit({ type: 'status', message: 'Verifier passed.' });
    }

    if (!shArgs('git', ['status', '--porcelain']).out.trim())
      return emit({ type: 'done', ok: false, reason: 'no file changes were made', branch });

    // Backlog tasks: deterministically check off the implemented item so the
    // next scan drops it from the board (the agent only writes code).
    if (task.source === 'backlog') {
      try {
        const blFile = join(repo, cfg.sources?.backlog || 'BACKLOG.md');
        const lines = readFileSync(blFile, 'utf8').split('\n');
        const matches = (l) => { const m = (l || '').match(BACKLOG_UNCHECKED_RE); return !!m && m[1].trim() === task.title; };
        const i = (task.line && matches(lines[task.line - 1])) ? task.line - 1 : lines.findIndex(matches);
        if (i >= 0) {
          lines[i] = lines[i].replace('[ ]', '[x]');
          writeFileSync(blFile, lines.join('\n'));
          emit({ type: 'status', message: `Checked off in ${cfg.sources?.backlog || 'BACKLOG.md'}` });
        }
      } catch { /* backlog file missing — nothing to tick */ }
    }

    const type = ({ typescript: 'fix', test: 'fix', lint: 'style', build: 'fix', todo: 'chore', backlog: 'feat', finding: 'fix' })[task.source] || 'chore';
    const subject = `${type}: ${task.title.slice(0, 72)}`;
    shArgs('git', ['add', '-A']);
    // argv form — the title is user/scan text and must never reach a shell string
    const c = shArgs('git', ['commit', '-m', subject, '-m', `[workloop] task ${task.id}`]);
    if (c.code !== 0) return emit({ type: 'done', ok: false, reason: 'commit failed', branch, log: tail(c.err) });
    emit({ type: 'status', message: `Committed: ${subject}` });

    // verified=true only when an independent verifier gate actually ran. For
    // finding/todo/backlog cards there is no automated check, so we must NOT
    // imply the change was validated — the UI/note say "not independently verified".
    const verified = !!task.verifiable;
    if (cfg.openPR) {
      emit({ type: 'status', message: 'Pushing and opening PR...' });
      const p = shArgs('git', ['push', '-u', 'origin', branch]);
      if (p.code !== 0) return emit({ type: 'done', ok: true, verified, branch, pr: null, note: 'committed locally; push failed: ' + tail(p.err, 4) });
      const pr = shArgs('gh', ['pr', 'create', '--fill', '--head', branch]);
      const url = (pr.out.match(/https?:\/\/\S+/) || [])[0] || null;
      return emit({ type: 'done', ok: true, verified, branch, pr: url, note: url ? null : 'pushed; open the PR in your host UI' });
    }
    const note = verified
      ? 'committed on branch — verifier passed; Run locally to double-check, PR when ready'
      : 'committed on branch — NOT independently verified (no check configured); review it, then PR when ready';
    return emit({ type: 'done', ok: true, verified, branch, pr: null, note });
  } catch (e) {
    emit({ type: 'done', ok: false, reason: e.message });
  }
})();
