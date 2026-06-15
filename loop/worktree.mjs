// loop/worktree.mjs — isolated execution environments (Layer 2).
//
// Each task runs in its own throwaway git worktree under the OS temp dir, off a
// fresh branch. Two tasks can never corrupt each other's tree, and the user's
// main checkout (and any dev server pointed at it) is untouched while an agent
// writes. The worktree shares the repo's .git, so the branch + commit the writer
// makes are immediately visible in the main checkout — no copy-back needed.
//
// The catch a fresh worktree introduces: it has only TRACKED files, so gitignored
// dependency dirs (node_modules, where the verifier's tools live) are absent. We
// link them in from the main checkout (see platform.linkDir); on link failure
// the caller falls back to verifying post-merge in the main checkout.

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childEnv } from '../env.mjs';
import { linkDir } from '../platform.mjs';
import { runArgs } from './agent.mjs';

export const worktreePath = (id) => join(tmpdir(), `workloop-wt-${id}`);

const git = (repo, args) => runArgs('git', args, { cwd: repo, env: childEnv() });

/**
 * Create an isolated worktree for a task.
 * @returns {{ ok:true, path, branch, realpath, linked:Array<{dir,ok?,existed?,error?}> }
 *          | { ok:false, reason }}
 */
export function create(repo, id, { base = 'HEAD', branch, linkDirs = ['node_modules'] } = {}) {
  if (!branch) return { ok: false, reason: 'create() needs a branch name' };
  const path = worktreePath(id);

  // Idempotent re-runs: clear any lingering worktree/branch from a prior attempt.
  git(repo, ['worktree', 'prune']);
  let r = git(repo, ['worktree', 'add', path, '-b', branch, base]);
  if (r.code !== 0) {
    git(repo, ['worktree', 'remove', '--force', path]); // path may have lingered
    git(repo, ['branch', '-D', branch]);                // branch may already exist
    git(repo, ['worktree', 'prune']);
    r = git(repo, ['worktree', 'add', path, '-b', branch, base]);
    if (r.code !== 0) return { ok: false, reason: `git worktree add failed: ${(r.err || r.out).trim().slice(0, 200)}` };
  }

  // Link dependency dirs so in-worktree verifiers can find their tools.
  const linked = [];
  for (const dir of linkDirs) {
    if (!dir || dir.includes('..') || dir.startsWith('/')) continue; // only repo-relative names
    const res = linkDir(join(repo, dir), join(path, dir));
    linked.push({ dir, ...res });
  }

  let real = path;
  try { real = realpathSync(path); } catch { /* just created — should exist */ }
  return { ok: true, path, branch, realpath: real, linked };
}

/** Remove a worktree and prune. Best-effort — a leftover worktree is harmless. */
export function remove(repo, id) {
  const path = worktreePath(id);
  const r = git(repo, ['worktree', 'remove', '--force', path]);
  git(repo, ['worktree', 'prune']);
  return { ok: r.code === 0, reason: r.code === 0 ? null : (r.err || r.out).trim().slice(0, 200) };
}

/** Parse `git worktree list --porcelain` into [{ path, branch, head }]. */
export function list(repo) {
  const r = git(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) return [];
  const out = [];
  let cur = null;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('worktree ')) { cur = { path: line.slice(9).trim(), branch: null, head: null }; out.push(cur); }
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5).trim();
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace('refs/heads/', '');
  }
  return out;
}
