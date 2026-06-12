// chat.mjs — the copilot chat: shells out to the same claude CLI the runner
// uses, streams the reply back as NDJSON over the POST response, and keeps
// session continuity via --resume (session id persisted in .workloop/chat.json
// so it survives server restarts). Read-only toolset by default, so chatting
// is safe even while an agent run is rewriting the repo.

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv, resolveClaude, splitCommand } from './env.mjs';
import { publish } from './bus.mjs';
import { fromChatText } from './handoffs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = join(__dirname, '.workloop', 'chat.json');
const MSG_CAP = 200;

let sess = (() => {
  try { return JSON.parse(readFileSync(FILE, 'utf8')); } catch { return { sessionId: null, startedAt: 0, messages: [] }; }
})();
const save = () => writeFileSync(FILE, JSON.stringify(sess, null, 2));

let child = null;       // single-flight
let writingNow = false; // true while a write-capable chat turn is in flight
export const busy = () => !!child;
export const busyWriting = () => writingNow; // a write-tool chat holds the single-writer slot

const killGroup = (proc, sig) => {
  try { process.kill(-proc.pid, sig); }
  catch { try { proc.kill(sig); } catch { /* gone */ } }
};

export function shutdown() { if (child) killGroup(child, 'SIGTERM'); }

export function history() {
  return { sessionId: sess.sessionId, startedAt: sess.startedAt, messages: sess.messages };
}

export function reset() {
  if (child) killGroup(child, 'SIGTERM');
  sess = { sessionId: null, startedAt: Date.now(), messages: [] };
  save();
  return { ok: true };
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
    + ' When the user must do something you cannot reach — steps in external dashboards (Cloudflare, Vercel, Supabase, App Store Connect, DNS registrars), secrets or API keys, sign-ins, purchases, physical devices — emit a fenced code block whose info string is exactly handoff: first line a short imperative title, following lines numbered steps, each runnable command wrapped in backticks.';
}

// send(): streams {type:'delta'|'tool'|'handoff'|'error'|'done'} NDJSON lines.
// The fetch connection IS the cancel mechanism — client aborts, we kill.
export function send(req, res, { text, cfg }) {
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
      '--append-system-prompt', preamble(tools),
      ...extraArgs,
    ];
    let c;
    try { c = spawn(claude, args, { cwd: cfg.repoPath, env: childEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
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
      killGroup(c, 'SIGTERM');
      setTimeout(() => killGroup(c, 'SIGKILL'), 1500);
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
        for (const h of fromChatText(reply, { sessionId: sess.sessionId })) write({ type: 'handoff', handoff: h });
        publish('chat.done', reply.slice(0, 160), { durationMs: Date.now() - t0 });
      } else if (!ok) {
        const signIn = /not logged in|please run \/login|\/login/i.test(errBuf);
        const message = signIn
          ? 'Claude Code is not signed in — use Sign in under Engine & agent'
          : (errBuf.trim().split('\n').pop() || `chat exited (${code})`).slice(0, 300);
        write({ type: 'error', message, signIn });
        publish('chat.error', message, { signIn });
      }
      write({ type: 'done', ok });
      res.end();
    });

    req.on('close', () => { if (child === c) { killGroup(c, 'SIGTERM'); } });
  };

  turn(true);
}
