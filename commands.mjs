// commands.mjs — saved shell commands, run one-at-a-time in the connected
// repo with output streamed to the activity bus. Mirrors the dev-server
// pattern: single slot, detached group, SIGTERM→SIGKILL escalation.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { childEnv } from './env.mjs';
import { publish, publishLine } from './bus.mjs';
import { userShell, killTree, detachOpts } from './platform.mjs';

let cur = { proc: null, id: null, name: null, lines: [], exited: true, code: null, startedAt: 0, stopped: false };

export const running = () => !!(cur.proc && !cur.exited);

export function status() {
  return {
    running: running(), id: cur.id, name: cur.name,
    startedAt: cur.startedAt || null,
    exitCode: cur.exited && !cur.stopped ? cur.code : null,
    last: cur.lines.slice(-200),
  };
}

export function run(cfg, id) {
  if (running()) return { error: `“${cur.name}” is still running — stop it first` };
  const cmd = (cfg.commands || []).find((c) => c.id === id);
  if (!cmd) return { error: 'command not found — it may have been edited; reopen the control center' };
  if (!cfg.repoPath || !existsSync(cfg.repoPath)) return { error: 'repoPath not set' };
  cur = { proc: null, id: cmd.id, name: cmd.name, lines: [], exited: false, code: null, startedAt: Date.now(), stopped: false };
  const sh = userShell(cmd.cmd);
  const p = spawn(sh.bin, sh.args, { ...sh.opts, cwd: cfg.repoPath, env: childEnv(), ...detachOpts() });
  cur.proc = p;
  publish('cmd.start', `${cmd.name} — ${cmd.cmd}`, { cmdId: cmd.id, name: cmd.name });
  const onData = (d) => {
    for (const raw of d.toString().split('\n')) {
      const s = raw.trim();
      if (!s) continue;
      cur.lines.push(s.slice(0, 200));
      if (cur.lines.length > 200) cur.lines.shift();
      publishLine('cmd.line', s.slice(0, 200), { cmdId: cmd.id });
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('exit', (code) => {
    if (cur.proc !== p) return;
    cur.exited = true; cur.code = code ?? -1;
    publish('cmd.exit', cur.stopped ? `${cmd.name} stopped` : `${cmd.name} exited (code ${cur.code})`, { cmdId: cmd.id, code: cur.code, stopped: cur.stopped });
  });
  p.on('error', () => {
    if (cur.proc !== p) return;
    cur.exited = true; cur.code = -1;
    publish('cmd.exit', `${cmd.name} failed to start`, { cmdId: cmd.id, code: -1, stopped: false });
  });
  return status();
}

export function stop() {
  if (running()) {
    const p = cur.proc;
    killTree(p, 'SIGTERM');
    setTimeout(() => { if (cur.proc === p && !cur.exited) killTree(p, 'SIGKILL'); }, 1500);
    cur.exited = true;
    cur.stopped = true;
  }
  return { running: false };
}

export const shutdown = stop;
