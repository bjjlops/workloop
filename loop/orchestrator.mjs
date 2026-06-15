#!/usr/bin/env node
// loop/orchestrator.mjs — the Orchestrator (Layer 1). Given the board's tasks it
// runs FIRST, before any worker: it reads repo state and prior runs, decides the
// execution order, generates an enriched prompt per task, and writes a run
// manifest BEFORE a single worker fires (1.6). Then it drives the per-task
// pipeline.
//
// STATUS: the manifest, ordering, and SERIAL drive are implemented. Parallel
// fan-out across file-disjoint tasks is scaffolded (see the TODO in drive()) —
// it's now SAFE thanks to worktree isolation, but interacts with the cross-
// instance run lock and the dev server, so it's deferred to a follow-up per the
// build order (Layers 1/6 scaffold now, complete later).

import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv } from '../env.mjs';
import { runArgs } from './agent.mjs';
import * as memory from './memory.mjs';
import * as feedback from './feedback.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const cfg = JSON.parse(readFileSync(join(root, 'workloop.config.json'), 'utf8'));
const repo = cfg.repoPath;
const ENV = childEnv();
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const git = (args) => runArgs('git', args, { cwd: repo, env: ENV });

function readTasks() {
  try { return JSON.parse(readFileSync(join(root, '.workloop', 'tasks.json'), 'utf8')).tasks || []; } catch { return []; }
}

// Snapshot of repo state the orchestrator reasons over (1.3).
function repoState() {
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).out || '').trim();
  const recentCommits = (git(['log', '--oneline', '-10']).out || '').trim().split('\n').filter(Boolean);
  const recentFiles = (git(['log', '--name-only', '--pretty=format:', '-20']).out || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const dirty = !!git(['status', '--porcelain']).out.trim();
  let openPRs = [];
  const pr = runArgs('gh', ['pr', 'list', '--json', 'number,title,headRefName', '--limit', '20'], { cwd: repo, env: ENV });
  if (pr.code === 0) { try { openPRs = JSON.parse(pr.out); } catch { /* gh not authed / not JSON */ } }
  return { branch, recentCommits, recentFiles: [...new Set(recentFiles)], dirty, openPRs };
}

// Ordering (1.4): independent tasks first; tasks sharing a file are kept adjacent
// so they serialize; tasks that keep FAILing are deferred until a human looks
// (7.2). Returns { order:[task...], deferred:[{task,reason}...] }.
function order(tasks, streaks) {
  const live = [], deferred = [];
  for (const t of tasks) {
    const streak = streaks.get(t.title) || 0;
    if (streak >= 2) { deferred.push({ task: t, reason: `failed ${streak}× in a row — needs a human` }); continue; }
    live.push(t);
  }
  // group by file so same-file tasks run back-to-back (never in parallel); fileless last
  live.sort((a, b) => {
    const fa = a.file || '￿', fb = b.file || '￿';
    return fa < fb ? -1 : fa > fb ? 1 : 0;
  });
  return { order: live, deferred };
}

// Generate the enriched worker prompt the orchestrator would hand a writer (1.5):
// repo context + relevant file paths + prior-run notes. Recorded in the manifest.
function enrichedPrompt(task, state, priorRuns) {
  const prior = priorRuns.filter((r) => r.title === task.title).slice(-2);
  const priorNote = prior.length ? `\nPRIOR RUNS OF THIS TASK:\n${prior.map((r) => `- ${r.date}: ${r.result}${r.notes && r.notes !== 'none' ? ' — ' + r.notes : ''}`).join('\n')}` : '';
  const related = task.file ? state.recentFiles.filter((f) => f !== task.file && f.split('/')[0] === task.file.split('/')[0]).slice(0, 5) : [];
  const relNote = related.length ? `\nRECENTLY-CHANGED NEARBY FILES (watch for regressions):\n${related.map((f) => '- ' + f).join('\n')}` : '';
  return `TASK: ${task.title}\n${task.file ? `LOCATION: ${task.file}${task.line ? ':' + task.line : ''}\n` : ''}${task.detail ? `CONTEXT: ${task.detail}\n` : ''}REPO: on branch ${state.branch}.${priorNote}${relNote}`.trim();
}

function drive(order) {
  // Serial v1: one worker at a time under the single-writer lock.
  // TODO(parallel): file-disjoint tasks can run concurrently in their own
  // worktrees — fan out up to cfg.loop.parallel children, ensuring no two
  // in-flight tasks share a file (and coordinating with foreignRunLock + the
  // dev server). Deferred per the Layer 1/6 build order.
  return new Promise((resolve) => {
    const results = [];
    let i = 0;
    const next = () => {
      if (i >= order.length) return resolve(results);
      const task = order[i++];
      emit({ type: 'status', message: `Orchestrator → worker ${i}/${order.length}: ${task.title}` });
      const child = spawn(process.execPath, [join(__dirname, 'pipeline.mjs'), task.id], {
        cwd: root, env: { ...ENV, WORKLOOP_LOOP_FORCE: '1' }, // invoking the orchestrator IS opting into loop mode
      });
      let buf = '';
      child.stdout.on('data', (d) => {
        buf += d.toString();
        let j; while ((j = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, j); buf = buf.slice(j + 1);
          if (!line.trim()) continue;
          let o = null; try { o = JSON.parse(line); } catch { /* non-JSON worker line */ }
          if (o && o.type === 'done') {
            // a worker's terminal line is NOT the batch terminal — relabel it so
            // the server treats only the orchestrator's own final 'done' as the end.
            results.push({ id: task.id, title: task.title, ok: !!o.ok, reason: o.reason });
            process.stdout.write(JSON.stringify({ type: 'task-done', id: task.id, title: task.title, findingId: task.findingId || null, ok: !!o.ok, reason: o.reason }) + '\n');
          } else {
            process.stdout.write(line + '\n'); // forward worker NDJSON upstream
          }
        }
      });
      child.stderr.on('data', (d) => emit({ type: 'agent', message: String(d).trim().slice(0, 300) }));
      child.on('close', () => next());
    };
    next();
  });
}

(async () => {
  try {
    if (!existsSync(repo)) return emit({ type: 'done', ok: false, reason: `repoPath not found: ${repo}` });
    const idsArg = (() => { const k = process.argv.indexOf('--ids'); return k >= 0 ? (process.argv[k + 1] || '').split(',').filter(Boolean) : null; })();
    const dryRun = process.argv.includes('--dry-run');

    let tasks = readTasks().filter((t) => t.column === 'needs-work'); // actionable work; review-only stays on the board
    if (idsArg) tasks = tasks.filter((t) => idsArg.includes(t.id));
    if (!tasks.length) return emit({ type: 'done', ok: true, reason: 'no actionable tasks', summary: { total: 0 } });

    const state = repoState();
    const priorRuns = memory.recentRuns(200);
    const streaks = memory.failureStreaks();
    const { order: ordered, deferred } = order(tasks, streaks);

    // Manifest BEFORE any worker fires (1.6).
    const manifest = {
      generatedAt: null, // stamped by the caller (Date.now is unavailable to keep runs reproducible)
      repo, branch: state.branch, openPRs: state.openPRs.map((p) => `#${p.number} ${p.title}`),
      order: ordered.map((t, n) => ({ seq: n + 1, id: t.id, title: t.title, file: t.file, source: t.source, prompt: enrichedPrompt(t, state, priorRuns) })),
      deferred: deferred.map((d) => ({ id: d.task.id, title: d.task.title, reason: d.reason })),
    };
    feedback.writeManifest(manifest);
    emit({ type: 'manifest', count: ordered.length, deferred: manifest.deferred, path: feedback.manifestPath });
    for (const d of manifest.deferred) emit({ type: 'status', message: `Deferred: ${d.title} (${d.reason})` });

    if (dryRun) return emit({ type: 'done', ok: true, reason: 'dry-run — manifest written, no workers fired', summary: { planned: ordered.length, deferred: deferred.length } });

    const results = await drive(ordered);
    const passed = results.filter((r) => r.ok).length;
    emit({ type: 'done', ok: results.every((r) => r.ok), summary: { total: results.length, passed, failed: results.length - passed, deferred: deferred.length } });
  } catch (e) {
    emit({ type: 'done', ok: false, reason: e.message });
  }
})();
