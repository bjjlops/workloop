// watch.mjs — the connective tissue between two Workloop instances (and any
// outside editor) sharing .workloop/ state, the repo's backlog file and the
// config: atomic writes, content-hash self-write suppression, and debounced
// DIRECTORY watchers (a file-level fs.watch dies the moment an atomic rename
// replaces its inode; watching the parent dir survives).
//
// No app-module imports — server.mjs, scanner.mjs, handoffs.mjs and chat.mjs
// all import from here, so this file sits at the bottom of the dep graph.

import { readFileSync, writeFileSync, renameSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename } from 'node:path';

const sha1 = (s) => createHash('sha1').update(s).digest('hex');

// abs path -> sha1 of the bytes THIS process last wrote (or last reconciled).
// The dispatch pipeline compares against it to tell a self-write (drop) from
// an external change (handle) — fs.watch can't tell who wrote.
const lastHash = new Map();

export function recordWrite(absPath, content) {
  lastHash.set(resolve(absPath), sha1(String(content)));
}

// tmp + rename: a watcher in the other instance can never read a half-written
// file, and the rename lands as ONE clean fs event instead of truncate+write.
export function writeJsonAtomic(absPath, obj) {
  const body = JSON.stringify(obj, null, 2);
  writeFileSync(absPath + '.tmp', body);
  renameSync(absPath + '.tmp', absPath);
  recordWrite(absPath, body);
}

// ---------- watchers ----------
// registry: abs path -> { mode, fn }
//   'json' — content parsed; a parse failure re-checks once after 200ms (the
//            writer may be mid-write) then gives up until the next fs event
//   'text' — raw string content, hash-gated like json (BACKLOG.md)
//   'raw'  — fn(absPath) after the debounce, no read and no hash gate; the
//            handler owns its own read state (the events.jsonl offset tail)
const files = new Map();
const dirs = new Map(); // dir -> FSWatcher
const timers = new Map();
const DEBOUNCE = 300;   // macOS FSEvents double-fires; one dispatch per burst

function dispatch(absPath, retried) {
  const reg = files.get(absPath);
  if (!reg) return;
  // a handler that defers (again) clears the recorded hash, or the re-check
  // would see "already reconciled" and silently drop the change
  const again = (ms) => { lastHash.delete(absPath); setTimeout(() => dispatch(absPath, true), ms); };
  if (reg.mode === 'raw') {
    try { reg.fn(absPath, again); } catch (e) { console.error('watch handler', basename(absPath), e.message); }
    return;
  }
  let content;
  try { content = readFileSync(absPath, 'utf8'); } catch { return; } // ENOENT — deleted or mid-rename
  const h = sha1(content);
  if (lastHash.get(absPath) === h) return; // our own write (or a no-op) — drop
  let data = content;
  if (reg.mode === 'json') {
    try { data = JSON.parse(content); }
    catch { if (!retried) setTimeout(() => dispatch(absPath, true), 200); return; } // torn read — re-check once
  }
  lastHash.set(absPath, h); // reconciled — don't re-handle the same bytes
  try { reg.fn(data, again); } catch (e) { console.error('watch handler', basename(absPath), e.message); }
}

function schedule(absPath) {
  clearTimeout(timers.get(absPath));
  timers.set(absPath, setTimeout(() => { timers.delete(absPath); dispatch(absPath, false); }, DEBOUNCE));
}

function armDir(dir) {
  if (dirs.has(dir)) return;
  let w;
  try {
    w = watch(dir, (_event, fname) => {
      if (!fname) return;
      const abs = join(dir, fname);
      if (files.has(abs)) schedule(abs);
    });
  } catch { return; } // dir missing — nothing to watch (re-armed on next watchFile)
  w.on('error', () => { try { w.close(); } catch { /* gone */ } dirs.delete(dir); });
  dirs.set(dir, w);
}

export function watchFile(absPath, mode, fn) {
  absPath = resolve(absPath);
  files.set(absPath, { mode, fn });
  armDir(dirname(absPath));
}

// unwatch + close the dir handle when it was the last file there — used when
// the repo (and with it the backlog path) switches.
export function unwatchFile(absPath) {
  absPath = resolve(absPath);
  files.delete(absPath);
  const dir = dirname(absPath);
  if (![...files.keys()].some((p) => dirname(p) === dir)) {
    const w = dirs.get(dir);
    if (w) { try { w.close(); } catch { /* gone */ } dirs.delete(dir); }
  }
}
