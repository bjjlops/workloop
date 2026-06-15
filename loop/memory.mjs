// loop/memory.mjs — the shared-memory engine (Layer 0 + Layer 7).
//
// The repo-root CLAUDE.md is the loop's persistent memory: the conventions every
// agent reads before writing, plus the Run Log / Known Mistakes / Lessons that
// each run appends to so the next run is smarter. This module owns reading it,
// appending to a named section without clobbering the rest, and parsing the Run
// Log back out for the orchestrator's ordering decisions.
//
// Writes are atomic (tmp + rename, so a reader — including the other Workloop
// instance — never sees a half-written file) and serialized by an advisory lock.
// True cross-process append safety also leans on the single-writer run lock:
// only one run holds run.lock at a time, so concurrent run-driven appends can't
// race; the lock here just guards against a human editing during a run.

import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordWrite } from '../watch.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export const CLAUDE_MD = join(repoRoot, 'CLAUDE.md');

export const SECTION = { RUN_LOG: 'Run Log', KNOWN_MISTAKES: 'Known Mistakes', LESSONS: 'Lessons Learned' };

export function read(path = CLAUDE_MD) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

// ---------- advisory lock (best-effort) ----------
function withLock(fn) {
  const lock = CLAUDE_MD + '.lock';
  let fd = null;
  for (let i = 0; i < 50 && fd === null; i++) {
    try { fd = openSync(lock, 'wx'); }       // O_EXCL — fails if another writer holds it
    catch { const until = Date.now() + 20; while (Date.now() < until) { /* brief spin */ } } // ~1s max total
  }
  try { return fn(); }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* */ } try { unlinkSync(lock); } catch { /* */ } } }
}

function writeAtomic(body) {
  writeFileSync(CLAUDE_MD + '.tmp', body);
  renameSync(CLAUDE_MD + '.tmp', CLAUDE_MD);
  recordWrite(CLAUDE_MD, body); // so a future CLAUDE.md watcher treats our own write as self, not external
}

// Append `text` under `## {section}` (creating the section at EOF if absent),
// inserting it just before the NEXT `## ` heading so sections stay grouped.
export function append(section, text) {
  return withLock(() => {
    let body = read();
    const block = String(text).trimEnd() + '\n';
    const lines = body.split('\n');
    const head = lines.findIndex((l) => l.trim() === `## ${section}`);
    if (head < 0) {
      const sep = body.endsWith('\n\n') ? '' : body.endsWith('\n') ? '\n' : '\n\n';
      body = body + sep + `## ${section}\n\n` + block;
    } else {
      let next = lines.length;
      for (let i = head + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i])) { next = i; break; } }
      // trim trailing blank lines inside the section, then insert with a blank gap
      let end = next; while (end > head + 1 && lines[end - 1].trim() === '') end--;
      const before = lines.slice(0, end);
      const after = lines.slice(next);
      body = [...before, '', block.trimEnd(), '', ...after].join('\n');
    }
    if (!body.endsWith('\n')) body += '\n';
    writeAtomic(body);
    return true;
  });
}

// ---------- Run Log (Layer 7.1 format) ----------
export function appendRun({ date, title, result, retries = 0, notes = 'none', files = [] }) {
  const filesStr = Array.isArray(files) ? (files.join(', ') || 'none') : (files || 'none');
  const entry = [
    `### Run — ${date} — ${String(title).slice(0, 120)}`,
    `Result: ${result}`,
    `Retries: ${retries}`,
    `Checker notes: ${String(notes || 'none').replace(/\s+/g, ' ').trim().slice(0, 500)}`,
    `Files changed: ${filesStr}`,
  ].join('\n');
  return append(SECTION.RUN_LOG, entry);
}

// Parse the Run Log back into entries (file order = oldest-first).
export function recentRuns(n = 50) {
  const body = read();
  const lines = body.split('\n');
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^###\s+Run\s+—\s+(.+?)\s+—\s+(.+)$/);
    if (!m) continue;
    const run = { date: m[1].trim(), title: m[2].trim(), result: null, retries: 0, notes: null, files: null };
    for (let j = i + 1; j < lines.length && !/^###?\s/.test(lines[j]); j++) {
      const r = lines[j].match(/^Result:\s*(.+)$/); if (r) run.result = r[1].trim();
      const rt = lines[j].match(/^Retries:\s*(\d+)/); if (rt) run.retries = Number(rt[1]);
      const cn = lines[j].match(/^Checker notes:\s*(.+)$/); if (cn) run.notes = cn[1].trim();
      const fc = lines[j].match(/^Files changed:\s*(.+)$/); if (fc) run.files = fc[1].trim();
    }
    runs.push(run);
  }
  return runs.slice(-n);
}

// Count consecutive recent FAILs per task title — the orchestrator deprioritizes
// tasks that keep failing until a human looks (Layer 7.2).
export function failureStreaks() {
  const byTitle = new Map();
  for (const r of recentRuns(200)) {
    const fail = /FAIL/i.test(r.result || '');
    const cur = byTitle.get(r.title) || 0;
    byTitle.set(r.title, fail ? cur + 1 : 0); // a PASS resets the streak
  }
  return byTitle;
}

// ---------- conventions for prompt injection ----------
// Everything ABOVE the Run Log — the engineering rules a writer/checker should
// follow — capped so it doesn't blow the prompt budget.
export function conventions(max = 9000) {
  const body = read();
  if (!body) return '';
  const cut = body.indexOf('\n## Run Log');
  const text = cut >= 0 ? body.slice(0, cut) : body;
  return text.trim().slice(0, max);
}

// The TARGET repo's own CLAUDE.md, if it has one — the writer should respect the
// conventions of the project it's editing, not just workloop's.
export function readTargetConventions(repo, max = 6000) {
  if (!repo) return '';
  const p = join(repo, 'CLAUDE.md');
  if (p === CLAUDE_MD || !existsSync(p)) return '';
  try { return readFileSync(p, 'utf8').trim().slice(0, max); } catch { return ''; }
}

export { repoRoot, basename };
