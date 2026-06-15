#!/usr/bin/env node
// loop/cli.mjs — one entry point for the loop-engineering tools, so each layer
// can be exercised standalone before trusting the automatic flow:
//
//   node loop/cli.mjs orchestrate [--ids a,b] [--dry-run]   # Layer 1
//   node loop/cli.mjs run <taskId>                           # full per-task loop
//   node loop/cli.mjs plan <taskId>                          # Layer 3 (plan only)
//   node loop/cli.mjs check [<taskId>] [--static] [--repo P] # Layer 5
//   node loop/cli.mjs worktree create|remove|list [--repo P] # Layer 2
//   node loop/cli.mjs babysit <pr#|branch>                   # Layer 6
//   node loop/cli.mjs memory recent [n]                      # Layer 7
//
// Subcommands with their own CLI (orchestrate/run/check/babysit) are spawned with
// inherited stdio so their NDJSON streams straight to your terminal.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv, resolveClaude, splitCommand } from '../env.mjs';
import * as worktree from './worktree.mjs';
import * as plan from './plan.mjs';
import * as memory from './memory.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = dirname(__dirname);
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const cfg = (() => { try { return JSON.parse(readFileSync(join(root, 'workloop.config.json'), 'utf8')); } catch { return {}; } })();
const flag = (name, def = null) => { const i = rest.indexOf(name); return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : def; };
const positional = rest.filter((a) => !a.startsWith('--') && rest[rest.indexOf(a) - 1]?.startsWith('--') !== true);

function delegate(modFile, args, forceLoop = false) {
  const env = forceLoop ? { ...childEnv(), WORKLOOP_LOOP_FORCE: '1' } : childEnv();
  const child = spawn(process.execPath, [join(__dirname, modFile), ...args], { cwd: root, env, stdio: 'inherit' });
  child.on('close', (c) => process.exit(c ?? 0));
}

function usage() {
  process.stdout.write(`loop — agent loop-engineering tools\n
  orchestrate [--ids a,b] [--dry-run]   plan + drive the whole board (Layer 1)
  run <taskId>                          one task through worktree→plan→write→check→merge (Layers 2-7)
  plan <taskId>                         produce the plan only (Layer 3)
  check [<taskId>] [--static] [--repo P] run the adversarial checker (Layer 5)
  worktree create|remove|list [--repo P] manage isolated worktrees (Layer 2)
  babysit <pr#|branch>                  watch CI and (scaffold) fix red checks (Layer 6)
  memory recent [n]                     show recent Run Log entries (Layer 7)\n`);
}

(async () => {
  switch (cmd) {
    case 'orchestrate': return delegate('orchestrator.mjs', rest, true);
    case 'run': case 'pipeline': return delegate('pipeline.mjs', rest, true);
    case 'check': return delegate('checker.mjs', rest);
    case 'babysit': return delegate('babysitter.mjs', rest);

    case 'worktree': {
      const sub = rest[0];
      const repo = flag('--repo') || cfg.repoPath || root;
      const id = rest.find((a, n) => n >= 1 && !a.startsWith('--') && rest[n - 1] !== '--repo') || 'cli';
      if (sub === 'create') {
        const branch = flag('--branch') || `${cfg.branchPrefix || 'workloop'}/cli-${id}`;
        const r = worktree.create(repo, id, { branch, linkDirs: cfg.loop?.linkDirs || ['node_modules'] });
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        return process.exit(r.ok ? 0 : 1);
      }
      if (sub === 'remove') { const r = worktree.remove(repo, id); process.stdout.write(JSON.stringify(r) + '\n'); return process.exit(r.ok ? 0 : 1); }
      if (sub === 'list') { process.stdout.write(JSON.stringify(worktree.list(repo), null, 2) + '\n'); return process.exit(0); }
      usage(); return process.exit(1);
    }

    case 'plan': {
      const taskId = rest.find((a) => !a.startsWith('--'));
      const task = (() => { try { return (JSON.parse(readFileSync(join(root, '.workloop', 'tasks.json'), 'utf8')).tasks || []).find((t) => t.id === taskId); } catch { return null; } })();
      if (!task) { process.stderr.write('task not found\n'); return process.exit(1); }
      const { bin, extraArgs } = splitCommand(cfg.agent?.command || 'claude');
      const claudeBin = resolveClaude(bin);
      if (!claudeBin) { process.stderr.write('engine not found\n'); return process.exit(1); }
      const r = await plan.makePlan({ task, repo: cfg.repoPath, cwd: cfg.repoPath, claudeBin, extraArgs, env: childEnv(), maxTurns: cfg.agent?.maxTurns || 12, emit: (e) => process.stdout.write(JSON.stringify(e) + '\n') });
      process.stdout.write(JSON.stringify({ ok: r.ok, path: r.path }) + '\n');
      return process.exit(r.ok ? 0 : 1);
    }

    case 'memory': {
      if (rest[0] === 'recent') {
        const n = Number(rest[1]) || 10;
        for (const run of memory.recentRuns(n)) process.stdout.write(`${run.date}  ${run.result}  (${run.retries}x)  ${run.title}\n`);
        return process.exit(0);
      }
      process.stdout.write(`CLAUDE.md: ${memory.CLAUDE_MD}\n`); return process.exit(0);
    }

    default: usage(); return process.exit(cmd ? 1 : 0);
  }
})();
