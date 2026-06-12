// bus.mjs — global activity event bus: in-memory ring buffer + SSE broadcast.
// Every meaningful thing the server does (scans, runs, git ops, dev output,
// commands, chat, handoffs) publishes here; the dashboard's activity log and
// galaxy triggers consume one stream: GET /api/events.
//
// Envelope: { id, ts, kind, message, data? }
//   id      monotonic per server process; doubles as the SSE `id:` field so
//           browsers resume via Last-Event-ID after a reconnect
//   kind    dot-namespaced (run.status, git.commit, dev.line, …) — clients
//           filter by prefix
//   message one human-readable line, <=500 chars
//
// Firehose kinds (run.agent / dev.line / cmd.line) broadcast live but are NOT
// stored in the ring — replay stays a meaningful event history, and the raw
// lines remain recoverable from the per-run log, /api/dev/status and
// /api/commands/status buffers.
//
// Ring events also persist to .workloop/events.jsonl (append-only NDJSON,
// shared by both Workloop instances): the activity panel and the copilot's
// "recent activity" snapshot survive a server restart, and the other
// instance live-tails our lines (see the events watcher in server.mjs).

import { appendFileSync, appendFile, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RING_MAX = 500;
const NO_RING = new Set(['run.agent', 'dev.line', 'cmd.line', 'chat.tool']);
const FLOOD_PER_SEC = 25; // per-kind line budget before coalescing kicks in

const ring = [];
const clients = new Set();
let nextId = 1;

export const bootId = Date.now().toString(36);

// ---------- persistence ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const EVENTS_FILE = join(__dirname, '.workloop', 'events.jsonl');
const SRC = String(process.env.PORT || 4317); // which instance wrote a line — the tail skips its own
const LOAD_MAX = 200;     // ring seed after a restart
const COMPACT_OVER = 4000; // boot-only compaction threshold (lines)
const COMPACT_KEEP = 500;

let pending = [];      // envelopes awaiting the next flush
let flushTimer = null;

function flushEvents() {
  flushTimer = null;
  if (!pending.length) return;
  const chunk = pending.map((e) => JSON.stringify(e) + '\n').join('');
  pending = [];
  appendFile(EVENTS_FILE, chunk, () => { /* best-effort — history, not truth */ });
}

// shutdown path: the async flush timer won't get to run — drain synchronously
export function flushEventsSync() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.length) return;
  const chunk = pending.map((e) => JSON.stringify(e) + '\n').join('');
  pending = [];
  try { appendFileSync(EVENTS_FILE, chunk); } catch { /* disk said no */ }
}

function persist(ev) {
  pending.push({ ts: ev.ts, kind: ev.kind, message: ev.message, ...(ev.data ? { data: ev.data } : {}), src: SRC });
  if (!flushTimer) flushTimer = setTimeout(flushEvents, 250);
}

// boot: compact an overgrown log, seed the ring with the recent tail, and
// repair a run that was cut off by the restart (its replayed run.start would
// otherwise wedge every client back into run-active state).
(() => {
  try { mkdirSync(join(__dirname, '.workloop'), { recursive: true }); } catch { /* exists */ }
  if (!existsSync(EVENTS_FILE)) return;
  let lines;
  try { lines = readFileSync(EVENTS_FILE, 'utf8').split('\n').filter((l) => l.trim()); } catch { return; }
  if (lines.length > COMPACT_OVER) {
    lines = lines.slice(-COMPACT_KEEP);
    try {
      writeFileSync(EVENTS_FILE + '.tmp', lines.join('\n') + '\n');
      renameSync(EVENTS_FILE + '.tmp', EVENTS_FILE);
    } catch { /* keep the long file */ }
  }
  const evs = [];
  for (const l of lines.slice(-LOAD_MAX)) {
    try {
      const e = JSON.parse(l);
      if (e && e.kind && !NO_RING.has(e.kind)) evs.push(e);
    } catch { /* torn final line from a crash — skip */ }
  }
  for (const e of evs) ring.push({ id: nextId++, ts: e.ts || Date.now(), kind: e.kind, message: e.message || '', ...(e.data ? { data: e.data } : {}) });
  const lastStart = ring.map((e) => e.kind).lastIndexOf('run.start');
  const lastDone = ring.map((e) => e.kind).lastIndexOf('run.done');
  if (lastStart >= 0 && lastDone < lastStart) {
    const ev = {
      id: nextId++, ts: Date.now(), kind: 'run.done',
      message: 'run interrupted — server restarted',
      data: { taskId: ring[lastStart].data?.taskId || null, ok: false, reason: 'server restarted mid-run' },
    };
    ring.push(ev);
    persist(ev);
  }
  while (ring.length > RING_MAX) ring.shift();
})();

// SSE id is namespaced by boot epoch ("<bootId>.<n>"). A browser reconnecting
// after a server restart still holds the previous epoch's Last-Event-ID; the
// mismatch makes attach() replay the whole fresh ring instead of silently
// skipping every new event (whose small numeric id is < the stale id).
const sseId = (n) => `${bootId}.${n}`;

export function publish(kind, message, data) {
  const ev = {
    id: nextId++, ts: Date.now(), kind,
    message: String(message ?? '').slice(0, 500),
    ...(data ? { data } : {}),
  };
  if (!NO_RING.has(kind)) {
    ring.push(ev);
    if (ring.length > RING_MAX) ring.shift();
    persist(ev);
  }
  const frame = `id: ${sseId(ev.id)}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  return ev;
}

// publishForeign: an event tailed from the OTHER instance's appends to
// events.jsonl — ring + broadcast like publish(), but never re-persisted
// (that would ping-pong the same line between the two instances forever).
export function publishForeign(e) {
  if (!e || !e.kind) return null;
  const ev = {
    id: nextId++, ts: e.ts || Date.now(), kind: e.kind,
    message: String(e.message ?? '').slice(0, 500),
    ...(e.data ? { data: e.data } : {}),
  };
  if (!NO_RING.has(ev.kind)) {
    ring.push(ev);
    if (ring.length > RING_MAX) ring.shift();
  }
  const frame = `id: ${sseId(ev.id)}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  return ev;
}

// recent(): newest-last tail of the ring — the copilot's per-turn workspace
// snapshot reads the same event history the activity panel renders.
export function recent(n = 20) {
  return ring.slice(-n);
}

// publishLine: publish() with a per-kind 1s coalescer for line-rate kinds —
// a chatty dev server emits one "… +N lines" marker instead of flooding.
const flood = new Map(); // kind -> { winStart, n, suppressed }
export function publishLine(kind, message, data) {
  const now = Date.now();
  let f = flood.get(kind);
  if (!f || now - f.winStart >= 1000) {
    if (f && f.suppressed) publish(kind, `… +${f.suppressed} more lines`, data);
    f = { winStart: now, n: 0, suppressed: 0 };
    flood.set(kind, f);
  }
  f.n++;
  if (f.n > FLOOD_PER_SEC) { f.suppressed++; return null; }
  return publish(kind, message, data);
}

// attach: SSE subscription. Always opens with a synthetic (non-ring) `hello`
// event carrying a live state snapshot — a page that loads mid-run re-syncs
// from it — then replays the ring (full on fresh connect, partial after a
// reconnect via Last-Event-ID).
export function attach(req, res, url, snapshot) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const hello = { bootId, serverSeq: nextId - 1, ...(snapshot || {}) };
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  // Last-Event-ID is "<bootId>.<n>" — only resume from it when the epoch matches
  // this process; a stale epoch (or ?since=) replays the full ring from 0.
  const raw = String(req.headers['last-event-id'] || '');
  const [epoch, n] = raw.includes('.') ? raw.split('.') : [null, null];
  const since = epoch === bootId ? (Number(n) || 0) : (Number(url.searchParams.get('since')) || 0);
  for (const ev of ring) {
    if (ev.id > since) res.write(`id: ${sseId(ev.id)}\ndata: ${JSON.stringify(ev)}\n\n`);
  }
  clients.add(res);
  const hb = setInterval(() => {
    try { res.write(':hb\n\n'); } catch { /* dead — close handler cleans up */ }
  }, 25000);
  req.on('close', () => { clearInterval(hb); clients.delete(res); });
}
