// handoffs.mjs — "needs your hands" items. When a run fails, the chat agent
// hits something only a human can do (Cloudflare/Vercel/DNS/secrets), or the
// dev server trips a known launch blocker, a handoff with numbered steps is
// created here, persisted to .workloop/handoffs.json, and surfaced in the
// dashboard's chat panel.

import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publish } from './bus.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '.workloop', 'handoffs.json');

let items = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return []; }
})();
const save = () => writeFileSync(FILE, JSON.stringify(items, null, 2));
const keyOf = (source, title) => createHash('sha1').update(source + '\0' + title).digest('hex').slice(0, 8);

export function list() {
  const open = items.filter((i) => i.status === 'open');
  const closed = items.filter((i) => i.status !== 'open').slice(-20);
  return [...open, ...closed];
}

export const openCount = () => items.filter((i) => i.status === 'open').length;

export function create(source, title, steps, context) {
  title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!title) return null;
  const id = 'hf_' + keyOf(source, title);
  if (items.some((i) => i.id === id && i.status === 'open')) return null; // dedupe repeats
  const h = {
    id, ts: Date.now(), source,
    title,
    steps: (steps || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12),
    context: context || {},
    status: 'open', resolvedAt: null,
  };
  items.push(h);
  if (items.length > 200) items = items.slice(-200);
  save();
  publish('handoff.new', `needs you — ${title}`, { handoff: h });
  return h;
}

export function setStatus(id, status) {
  const h = items.find((i) => i.id === id);
  if (!h) return null;
  h.status = status;
  h.resolvedAt = Date.now();
  save();
  publish(status === 'done' ? 'handoff.resolved' : 'handoff.dismissed',
    `${status === 'done' ? 'resolved' : 'dismissed'} — ${h.title}`, { id });
  return h;
}

/* ---- detection: dev-server launch blockers (single source of truth —
   matched live against each dev output line, not just on exit) ---- */
const DEV_HINTS = [
  [/Xcode must be fully installed|xcode-select|xcrun simctl/i,
    'Finish Xcode setup for the iOS simulator',
    ['Run in Terminal: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`',
      'Then: `sudo xcodebuild -runFirstLaunch`',
      'Hit Run locally again']],
  [/port .*(in use|busy)|EADDRINUSE/i,
    'Free the dev-server port',
    ['Another dev server is holding the port — stop it or free the port',
      'Find it with: `lsof -nP -iTCP -sTCP:LISTEN`',
      'Hit Run locally again']],
  [/EXPO_TOKEN|expo.*non-interactive mode/i,
    'Expo wants an account login to sign the manifest',
    ['Add `--offline` to the dev command in the control center (anonymous local dev)',
      'Or run `npx expo login` once in Terminal']],
  [/should be updated for best compatibility/i,
    'Align package versions (warnings only)',
    ['When convenient, run: `npx expo install --fix`']],
];

export function checkDevLine(line) {
  for (const [re, title, steps] of DEV_HINTS) {
    if (re.test(line)) return create('dev', title, steps, { line: line.slice(0, 200) });
  }
  return null;
}

/* ---- detection: failed agent runs ---- */
export function fromRunFailure(taskId, title, reason, branch, logTail) {
  reason = reason || '';
  if (/another run is already active/i.test(reason)) return null;
  if (/logged in|\/login/i.test(reason)) {
    return create('run', 'Sign in to Claude Code', [
      'Open Engine & agent in the control center and click Sign in (or run `claude /login` in Terminal)',
      `Then Retry the task: ${title}`,
    ], { taskId });
  }
  if (/uncommitted changes/i.test(reason)) {
    return create('run', 'Commit or discard loose changes before running', [
      'Open Branches in the control center',
      'Commit (writes an AI-summarized message) or Discard the changes',
      `Then Retry the task: ${title}`,
    ], { taskId });
  }
  if (/verifier/i.test(reason)) {
    return create('run', `Verifier still failing — ${title}`, [
      branch ? `The partial work is on branch \`${branch}\`` : 'The partial work is on the run branch',
      'Hit Run locally to test it, or open the branch in your editor',
      'Fix what remains, or Retry to let the agent take another pass',
    ], { taskId, branch, log: (logTail || '').slice(-1200) });
  }
  return create('run', `Run needs you — ${reason.slice(0, 120)}`, [
    branch ? `Inspect branch \`${branch}\`` : `Re-run the task after addressing: ${reason.slice(0, 160)}`,
    'Retry from the Tasks panel when ready',
  ], { taskId, branch });
}

/* ---- detection: chat ```handoff fences ---- */
export function fromChatText(text, context) {
  const out = [];
  const re = /```handoff\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || ''))) {
    const lines = m[1].split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    const title = lines[0].replace(/^#+\s*/, '');
    const steps = lines.slice(1).map((s) => s.replace(/^(\d+[.)]|[-*])\s*/, ''));
    const h = create('chat', title, steps, context);
    if (h) out.push(h);
  }
  return out;
}
