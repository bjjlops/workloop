// findings.mjs — agent-fixable issues reported by the copilot (```fix fences)
// or the dev-server monitor. Unlike handoffs ("needs your hands", chat panel),
// findings land on the TASK BOARD under Needs work with a Run button: the
// scanner re-merges them on every scan (.workloop/findings.json is their
// source of truth, the way BACKLOG.md backs the queue column).
//
// Lifecycle: open → run succeeds = entry deleted (a later re-report re-creates
// it — evidently it wasn't fixed) · discarded = tombstone that blocks the same
// report from resurrecting a card the user explicitly killed.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './watch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '.workloop', 'findings.json');
const OPEN_CAP = 200;
const TOMB_CAP = 50;

let items = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
})();
const save = () => writeJsonAtomic(FILE, items);
const keyOf = (source, title) => 'fd_' + createHash('sha1').update(source + '\0' + title).digest('hex').slice(0, 8);

// open findings for the active repo; legacy items without a repo show everywhere
export function list(repo) {
  return items.filter((f) => f.status === 'open' && (!f.repo || f.repo === repo));
}

export function create({ source, title, detail, file, line, repo }) {
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!title) return null;
  const id = keyOf(source, title);
  // dedupe against ANY same-id item: an open twin means it's already on the
  // board; a discarded tombstone means the user killed it — stay dead
  if (items.some((f) => f.id === id)) return null;
  const f = {
    id, source,
    title,
    detail: String(detail || '').slice(0, 400) || null,
    file: file || null,
    line: Number(line) || null,
    repo: repo || null,
    ts: Date.now(),
    status: 'open', resolvedAt: null,
  };
  items.push(f);
  const open = items.filter((x) => x.status === 'open');
  if (open.length > OPEN_CAP) { // shed oldest open beyond the cap
    const drop = new Set(open.slice(0, open.length - OPEN_CAP).map((x) => x.id));
    items = items.filter((x) => !drop.has(x.id));
  }
  const tombs = items.filter((x) => x.status === 'discarded');
  if (tombs.length > TOMB_CAP) {
    const drop = new Set(tombs.slice(0, tombs.length - TOMB_CAP).map((x) => x.id));
    items = items.filter((x) => !drop.has(x.id));
  }
  save();
  return f;
}

// a run fixed it — delete outright so a future re-report can land again
export function resolve(id) {
  const i = items.findIndex((f) => f.id === id);
  if (i < 0) return null;
  const [f] = items.splice(i, 1);
  save();
  return f;
}

// the user killed the card — tombstone it so re-reports don't resurrect it
export function discard(id) {
  const f = items.find((x) => x.id === id);
  if (!f) return null;
  f.status = 'discarded';
  f.resolvedAt = Date.now();
  save();
  return f;
}

// the OTHER Workloop instance (sharing .workloop/) rewrote findings.json —
// adopt its list. The file watcher hands us the parsed data.
export function reload(next) {
  if (Array.isArray(next)) items = next;
}
