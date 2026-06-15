#!/usr/bin/env node
// loop/babysitter.mjs <pr#|branch> — the CI Babysitter (Layer 6). After a PR is
// opened, watch its checks; on red, spawn a fix agent with the raw failure
// output as context, patch, re-push to the same branch, and loop until green —
// so no human ever sees a red check on an agent-opened PR (6.5).
//
// STATUS: the watch + failing-log fetch are implemented. The fix-agent spawn +
// re-push (6.2–6.4) is scaffolded with a clear TODO — it reuses loop/agent.mjs
// (runAgent) the same way the pipeline's writer does, but auto-pushing fixes to a
// PR branch is the riskiest action in the whole system, so it's deferred to a
// follow-up per the Layer 1/6 build order. For now it surfaces exactly what it
// WOULD feed a fix agent.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv } from '../env.mjs';
import { runArgs, tail } from './agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const cfg = JSON.parse(readFileSync(join(root, 'workloop.config.json'), 'utf8'));
const repo = cfg.repoPath;
const ENV = childEnv();
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const gh = (args) => runArgs('gh', args, { cwd: repo, env: ENV });

const MAX_ROUNDS = Number(process.env.WORKLOOP_BABYSIT_ROUNDS || 5);

function failingLogs(branch) {
  const list = gh(['run', 'list', '--branch', branch, '--json', 'databaseId,conclusion,status', '--limit', '5']);
  if (list.code !== 0) return null;
  let runs = []; try { runs = JSON.parse(list.out); } catch { return null; }
  const failed = runs.find((r) => r.conclusion === 'failure');
  if (!failed) return null;
  const log = gh(['run', 'view', String(failed.databaseId), '--log-failed']);
  return { runId: failed.databaseId, log: tail(log.out || log.err, 120) };
}

(async () => {
  try {
    if (!existsSync(repo)) return emit({ type: 'done', ok: false, reason: `repoPath not found: ${repo}` });
    const target = process.argv[2];
    if (!target) return emit({ type: 'done', ok: false, reason: 'usage: babysitter.mjs <pr#|branch>' });
    if (gh(['--version']).code !== 0) return emit({ type: 'done', ok: false, reason: 'gh CLI not found — install GitHub CLI to babysit CI' });

    // Resolve the branch behind the PR (so we can fetch run logs by branch).
    let branch = target;
    if (/^\d+$/.test(target)) {
      const v = gh(['pr', 'view', target, '--json', 'headRefName']);
      try { branch = JSON.parse(v.out).headRefName; } catch { /* fall back to raw arg */ }
    }
    emit({ type: 'status', message: `Babysitting CI for ${branch}` });

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      emit({ type: 'phase', phase: `ci-watch:${round}` });
      // gh pr checks --watch blocks until checks complete; exit 0 = all green.
      const checks = /^\d+$/.test(target) ? gh(['pr', 'checks', target, '--watch']) : gh(['pr', 'checks', branch, '--watch']);
      if (checks.code === 0) return emit({ type: 'done', ok: true, note: `all checks green for ${branch}` });

      emit({ type: 'status', message: `CI red on ${branch} (round ${round}) — fetching failing logs` });
      const failure = failingLogs(branch);
      if (!failure) { emit({ type: 'status', message: 'checks failed but no failing run log found — needs a human' }); break; }
      emit({ type: 'check', ok: false, notes: [{ stage: 'ci', ok: false, detail: failure.log }] });

      // TODO(L6.2–6.4): spawn a fix agent in a worktree off `branch` with
      //   failure.log as context (reuse loop/agent.mjs runAgent like the writer),
      //   commit the patch, `git push` to the SAME branch, then loop. Auto-pushing
      //   to a PR branch is gated until the loop pattern is proven end-to-end.
      emit({ type: 'status', message: 'fix-agent auto-patch not yet enabled — would feed the above log to a writer and re-push' });
      break;
    }
    emit({ type: 'done', ok: false, reason: `CI still red after watching ${branch} — handed back for a human (fix-agent loop is scaffolded, not yet enabled)` });
  } catch (e) {
    emit({ type: 'done', ok: false, reason: e.message });
  }
})();
