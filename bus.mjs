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

const RING_MAX = 500;
const NO_RING = new Set(['run.agent', 'dev.line', 'cmd.line']);
const FLOOD_PER_SEC = 25; // per-kind line budget before coalescing kicks in

const ring = [];
const clients = new Set();
let nextId = 1;

export const bootId = Date.now().toString(36);

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
  }
  const frame = `id: ${sseId(ev.id)}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
  return ev;
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
