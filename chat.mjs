// chat.mjs — the copilot chat: shells out to the same claude CLI the runner
// uses, streams the reply back as NDJSON over the POST response, and keeps
// session continuity via --resume (session id persisted in .workloop/chat.json
// so it survives server restarts). Read-only toolset by default, so chatting
// is safe even while an agent run is rewriting the repo.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, resolveClaude, splitCommand } from './env.mjs';
import { publish, publishLine } from './bus.mjs';
import { fromChatText } from './handoffs.mjs';
import { spawnTool, killTree, detachOpts } from './platform.mjs';
import { writeJsonAtomic } from './watch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '.workloop', 'chat.json');
const MSG_CAP = 200;

let sess = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { sessionId: null, startedAt: 0, messages: [] }; }
})();
const save = () => writeJsonAtomic(FILE, sess);

let child = null;       // single-flight
let writingNow = false; // true while a write-capable chat turn is in flight
export const busy = () => !!child;
export const busyWriting = () => writingNow; // a write-tool chat holds the single-writer slot

export function shutdown() { if (child) killTree(child, 'SIGTERM'); }

export function history() {
  return { sessionId: sess.sessionId, startedAt: sess.startedAt, messages: sess.messages };
}

export function reset() {
  if (child) killTree(child, 'SIGTERM');
  sess = { sessionId: null, startedAt: Date.now(), messages: [] };
  save();
  return { ok: true };
}

// reload: the OTHER instance (sharing .workloop/chat.json) advanced the
// conversation — adopt its session. The server's watcher defers this while a
// turn is in flight here, so an active stream is never clobbered.
export function reload(next) {
  if (next && typeof next === 'object') {
    sess = { sessionId: next.sessionId ?? null, startedAt: next.startedAt || 0, messages: Array.isArray(next.messages) ? next.messages : [] };
  }
}

const hasWriteTools = (tools) => /\b(Edit|Write|Bash|NotebookEdit)\b/i.test(tools || '');
export { hasWriteTools };

function preamble(tools) {
  const ro = !hasWriteTools(tools);
  return 'You are the copilot chat inside Workloop, a local dashboard for this repository. '
    + 'Be concise and concrete; reference files by path. '
    + (ro
      ? `Your tool access is read-only (${tools}) — you cannot edit files or run commands; the dashboard's Run buttons do that.`
      : `Your tools: ${tools}.`)
    + ' A live WORKSPACE STATE snapshot (task board, queue, agent run, dev server, recent activity, open handoffs, git) is appended to these instructions and regenerated every turn — trust it over anything older in the conversation when answering questions about tasks, runs, activity, or handoffs.'
    + ' Route actionable items to the right place — chat is for conversation; work belongs on the task board:'
    + ' (1) handoff fence — STRICTLY for steps only the user themselves can do: sign-ins and auth, secrets or API keys, external dashboards (Cloudflare, Vercel, Supabase, App Store Connect, DNS registrars), purchases, physical devices, or decisions only they can make. First line a short imperative title, following lines numbered steps, each runnable command wrapped in backticks. NEVER use a handoff for anything fixable by editing code or running commands in this repo.'
    + ' (2) fix fence — when you identify a concrete repo problem an agent could fix (a bug, broken config, failing command, bad import, version misalignment), emit a fenced code block whose info string is exactly fix: one issue per line, short and imperative, optionally prefixed with its location as path/to/file:LINE followed by " — ". Workloop puts each under Needs work on the task board with a Run button; do not also describe it as a handoff.'
    + ' (3) queue fence — when the user asks you to queue, add, or track work for later (or accepts your offer to queue it), emit a fenced code block whose info string is exactly queue: one goal per line, short and imperative — Workloop appends each to the backlog and it appears under Queue on the task board.';
}

// ```queue fences — the copilot's way to push goals onto the task board.
// Parsed from the finished reply; the server decides whether they may land
// (never mid-run) and answers with what was actually queued.
function goalsFromText(text) {
  const out = [];
  const re = /```queue\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || ''))) {
    for (const raw of m[1].split('\n')) {
      const s = raw.trim().replace(/^(\d+[.)]|[-*])\s*/, '');
      if (s) out.push(s);
    }
  }
  return out;
}

// ```fix fences — agent-fixable issues that belong under Needs work on the
// board, NOT in the chat. One issue per line, optional "path/to/file:123 — "
// location prefix. Safe to land mid-run: findings live in .workloop/, outside
// the repo the agent is editing. Exported for testability.
export function fixesFromText(text) {
  const out = [];
  const re = /```fix\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || ''))) {
    for (const raw of m[1].split('\n')) {
      const s = raw.trim().replace(/^(\d+[.)]|[-*])\s*/, '');
      if (!s) continue;
      const sep = s.includes(' — ') ? ' — ' : s.includes(' - ') ? ' - ' : null;
      if (sep) {
        const loc = s.slice(0, s.indexOf(sep)).trim();
        const lm = loc.match(/^([\w@./-]+?)(?::(\d+))?$/);
        if (lm && (loc.includes('/') || loc.includes('.'))) {
          out.push({ title: s.slice(s.indexOf(sep) + sep.length).trim(), file: lm[1], line: lm[2] ? Number(lm[2]) : null, detail: s });
          continue;
        }
      }
      out.push({ title: s, file: null, line: null, detail: s });
    }
  }
  return out;
}

// send(): streams {type:'delta'|'tool'|'handoff'|'queued'|'queue_blocked'|'finding'|'error'|'done'}
// NDJSON lines. The fetch connection IS the cancel mechanism — client aborts, we kill.
// context: the server's live workspace snapshot, appended to the system prompt
// each turn. onGoals: the server's queue hook for ```queue fences.
// onFixes: the server's Needs-work hook for ```fix fences.
export function send(req, res, { text, cfg, context, onGoals, onFixes }) {
  if (child) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'a chat reply is already streaming — stop it first' }));
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache' });
  const write = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch { /* client gone */ } };
  writingNow = hasWriteTools(cfg.chat?.allowedTools); // holds the writer slot if so
  const release = () => { writingNow = false; };
  res.on('close', release);

  sess.messages.push({ role: 'user', text, ts: Date.now() });
  if (sess.messages.length > MSG_CAP) sess.messages = sess.messages.slice(-MSG_CAP);
  save();
  publish('chat.user', text.slice(0, 200));

  const turn = (allowResumeRetry) => {
    const { bin, extraArgs } = splitCommand(cfg.agent?.command || 'claude');
    const claude = resolveClaude(bin);
    if (!claude) {
      write({ type: 'error', message: 'Claude Code CLI not found — set the engine path in the control center' });
      write({ type: 'done', ok: false });
      publish('chat.error', 'claude CLI not found');
      return res.end();
    }
    const tools = cfg.chat?.allowedTools || 'Read,Glob,Grep';
    const args = [
      '-p', text,
      '--output-format', 'stream-json', '--verbose',
      '--allowedTools', tools,
      '--max-turns', String(cfg.chat?.maxTurns ?? 15),
      ...(sess.sessionId ? ['--resume', sess.sessionId] : []),
      '--append-system-prompt', preamble(tools) + (context ? `\n\n${context}` : ''),
      ...extraArgs,
    ];
    let c;
    try { c = spawnTool(claude, args, { cwd: cfg.repoPath, env: childEnv(), ...detachOpts(), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) {
      write({ type: 'error', message: `could not start engine: ${e.message}` });
      write({ type: 'done', ok: false });
      publish('chat.error', 'engine failed to start');
      return res.end();
    }
    child = c;
    let finalText = '', streamedText = '', errBuf = '', sawInit = false, settled = false;
    const t0 = Date.now();
    // spawn() reports failures (EACCES on a non-exec engine path, etc.) via an
    // async 'error' event — without this handler Node would crash the server.
    c.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (child === c) child = null;
      const msg = `engine failed to launch (${e.code || e.message}) — check the engine path under Engine & agent`;
      write({ type: 'error', message: msg });
      write({ type: 'done', ok: false });
      publish('chat.error', msg);
      res.end();
    });
    const timer = setTimeout(() => {
      killTree(c, 'SIGTERM');
      setTimeout(() => killTree(c, 'SIGKILL'), 1500);
      errBuf += '\n[timed out]';
    }, cfg.chat?.timeoutMs ?? 180000);

    let buf = '';
    c.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.type === 'system' && o.subtype === 'init' && o.session_id) {
          sawInit = true;
          if (sess.sessionId !== o.session_id) { sess.sessionId = o.session_id; sess.startedAt = sess.startedAt || Date.now(); save(); }
        } else if (o.type === 'assistant') {
          for (const block of o.message?.content || []) {
            if (block.type === 'text' && block.text) { streamedText += block.text; write({ type: 'delta', text: block.text }); }
            else if (block.type === 'tool_use') {
              const detail = block.input?.file_path || block.input?.path || block.input?.pattern || block.input?.command || '';
              write({ type: 'tool', name: block.name, detail: String(detail).slice(0, 160) });
              // mirror onto the bus so the activity log's verbose view shows the
              // copilot working, same as run.agent / dev.line / cmd.line
              publishLine('chat.tool', `${block.name}${detail ? ' — ' + String(detail).slice(0, 120) : ''}`);
            }
          }
        } else if (o.type === 'result') {
          if (typeof o.result === 'string' && o.result) finalText = o.result;
        }
      }
    });
    c.stderr.on('data', (d) => { errBuf += d.toString(); });

    c.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return; // an 'error' already finished this turn
      settled = true;
      if (child !== c) return;
      child = null;
      // --resume pointing at a vanished session: retry once, fresh
      if (code !== 0 && allowResumeRetry && sess.sessionId && /no conversation|session.*not found|not.*resumed/i.test(errBuf)) {
        sess.sessionId = null;
        save();
        return turn(false);
      }
      const ok = code === 0;
      const reply = finalText || streamedText;
      if (ok && reply) {
        sess.messages.push({ role: 'assistant', text: reply, ts: Date.now() });
        if (sess.messages.length > MSG_CAP) sess.messages = sess.messages.slice(-MSG_CAP);
        save();
        for (const h of fromChatText(reply, { sessionId: sess.sessionId }, cfg.repoPath)) write({ type: 'handoff', handoff: h });
        const goals = goalsFromText(reply);
        if (goals.length && onGoals) {
          let r = {};
          try { r = onGoals(goals) || {}; } catch { /* queueing failed — the reply still stands */ }
          for (const t of r.queued || []) write({ type: 'queued', title: t });
          if (r.blocked) write({ type: 'queue_blocked', count: goals.length });
        }
        const fixes = fixesFromText(reply);
        if (fixes.length && onFixes) {
          let r = {};
          try { r = onFixes(fixes) || {}; } catch { /* landing failed — the reply still stands */ }
          for (const t of r.landed || []) write({ type: 'finding', title: t });
        }
        publish('chat.done', reply.slice(0, 160), { durationMs: Date.now() - t0 });
      } else if (!ok) {
        const signIn = /not logged in|please run \/login|\/login/i.test(errBuf);
        const message = signIn
          ? 'Claude Code is not signed in — use Sign in under Connections'
          : (errBuf.trim().split('\n').pop() || `chat exited (${code})`).slice(0, 300);
        write({ type: 'error', message, signIn });
        publish('chat.error', message, { signIn });
      }
      write({ type: 'done', ok });
      res.end();
    });

    req.on('close', () => { if (child === c) { killTree(c, 'SIGTERM'); } });
  };

  turn(true);
}
