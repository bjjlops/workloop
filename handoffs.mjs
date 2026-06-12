// handoffs.mjs — "needs your hands" items. When a run fails, the chat agent
// hits something only a human can do (Cloudflare/Vercel/DNS/secrets), or the
// dev server trips a known launch blocker, a handoff with numbered steps is
// created here, persisted to .workloop/handoffs.json, and surfaced in the
// dashboard's chat panel.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from './bus.mjs';
import { writeJsonAtomic } from './watch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '.workloop', 'handoffs.json');

let items = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
})();
const save = () => writeJsonAtomic(FILE, items);
const keyOf = (source, title) => createHash('sha1').update(source + '\0' + title).digest('hex').slice(0, 8);

// repo-scoped: handoffs belong to the repo they were created in; items
// without a repo (legacy, pre-scoping) show everywhere until tagged
const inRepo = (i, repo) => !i.repo || !repo || i.repo === repo;

export function list(repo) {
  const open = items.filter((i) => i.status === 'open' && inRepo(i, repo));
  const closed = items.filter((i) => i.status !== 'open' && inRepo(i, repo)).slice(-20);
  return [...open, ...closed];
}

export const openCount = (repo) => items.filter((i) => i.status === 'open' && inRepo(i, repo)).length;

// reload: the OTHER Workloop instance (sharing .workloop/) rewrote
// handoffs.json — adopt its list. The file watcher hands us the parsed data.
export function reload(next) {
  if (Array.isArray(next)) items = next;
  return openCount();
}

export function create(source, title, steps, context, repo) {
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!title) return null;
  const id = 'hf_' + keyOf(source, title);
  if (items.some((i) => i.id === id && i.status === 'open')) return null; // dedupe repeats
  const h = {
    id, ts: Date.now(), source,
    title,
    steps: (steps || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
    context: context || {},
    repo: repo || null,
    status: 'open', resolvedAt: null,
  };
  items.push(h);
  if (items.length > 200) items = items.slice(-200);
  save();
  publish('handoff.new', `needs you — ${title}`, { handoff: h });
  return h;
}

export function setStatus(id, status) {
  // prefer the OPEN match: create() only dedupes against open items, so a
  // closed twin with the same id can shadow the open one and make it
  // unreachable from the resolve/dismiss API
  const h = items.find((i) => i.id === id && i.status === 'open') || items.find((i) => i.id === id);
  if (!h) return null;
  h.status = status;
  h.resolvedAt = Date.now();
  save();
  publish(status === 'done' ? 'handoff.resolved' : 'handoff.dismissed',
    `${status === 'done' ? 'resolved' : 'dismissed'} — ${h.title}`, { id, handoff: h });
  return h;
}

/* ---- detection: dev-server launch blockers (single source of truth —
   matched live against each dev output line, not just on exit).
   kind 'handoff' = truly hands-on (system setup, account logins) → chat card.
   kind 'fix' = an agent can run the fix → returned to the server, which lands
   it under Needs work on the board instead. ---- */
const DEV_HINTS = [
  [/Xcode must be fully installed|xcode-select|xcrun simctl/i, 'handoff',
    'Finish Xcode setup for the iOS simulator',
    ['Run in Terminal: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`',
      'Then: `sudo xcodebuild -runFirstLaunch`',
      'Hit Run locally again']],
  [/port .*(in use|busy)|EADDRINUSE/i, 'handoff',
    'Free the dev-server port',
    ['Another dev server is holding the port — stop it or free the port',
      'Find it with: `lsof -nP -iTCP -sTCP:LISTEN`',
      'Hit Run locally again']],
  [/EXPO_TOKEN|expo.*non-interactive mode/i, 'handoff',
    'Expo wants an account login to sign the manifest',
    ['Add `--offline` to the dev command in the control center (anonymous local dev)',
      'Or run `npx expo login` once in Terminal']],
  [/should be updated for best compatibility/i, 'fix',
    'Run `npx expo install --fix` to align package versions', null],
];

// returns { handoff } when a chat card was created, { fix: {title, detail} }
// when the caller (server.mjs) should land a board finding, or null
export function checkDevLine(line, repo) {
  for (const [re, kind, title, steps] of DEV_HINTS) {
    if (!re.test(line)) continue;
    if (kind === 'fix') return { fix: { title, detail: `dev output: ${line.slice(0, 200)}` } };
    const h = create('dev', title, steps, { line: line.slice(0, 200) }, repo);
    return h ? { handoff: h } : null;
  }
  return null;
}

/* ---- detection: failed agent runs ----
   Only truly hands-on blockers become chat cards (sign-in, dirty tree).
   Verifier failures and other agent-addressable reasons stay on the BOARD:
   the task card keeps its Retry button, and the reason rides run.done in the
   activity log plus lastRun in the copilot's snapshot. */
export function fromRunFailure(taskId, title, reason, branch, logTail, repo) {
  reason = reason || '';
  if (/another run is already active/i.test(reason)) return null;
  if (/logged in|\/login/i.test(reason)) {
    return create('run', 'Sign in to Claude Code', [
      'Open Connections in the control center and click Sign in (or run `claude /login` in Terminal)',
      `Then Retry the task: ${title}`,
    ], { taskId, tag: 'signin' }, repo);
  }
  if (/uncommitted changes/i.test(reason)) {
    return create('run', 'Commit or discard loose changes before running', [
      'Open Branches in the control center',
      'Commit (writes an AI-summarized message) or Discard the changes',
      `Then Retry the task: ${title}`,
    ], { taskId, tag: 'dirty' }, repo);
  }
  return null;
}

/* ---- detection: chat ```handoff fences ---- */
export function fromChatText(text, context, repo) {
  const out = [];
  const re = /```handoff\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || ''))) {
    const lines = m[1].split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const title = lines[0].replace(/^#+\s*/, '');
    const steps = lines.slice(1).map((s) => s.replace(/^(\d+[.)]|[-*])\s*/, ''));
    const h = create('chat', title, steps, context, repo);
    if (h) out.push(h);
  }
  return out;
}
