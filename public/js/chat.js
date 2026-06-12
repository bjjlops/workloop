/* chat.js — the copilot panel: streaming replies from POST /api/chat (NDJSON
   over fetch; aborting the fetch kills the server-side claude child), plus
   handoff cards — the "needs your hands" instructions — inline in the flow. */

const Chat = (() => {
  let msgs, input, sendBtn, aborter = null;
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60;
  const stick = (force) => { if (force || nearBottom()) msgs.scrollTop = msgs.scrollHeight; };

  /* backtick spans become <code> with a copy button */
  function richText(t) {
    let html = '';
    const parts = String(t).split(/(`[^`\n]+`)/g);
    for (const p of parts) {
      if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
        const cmd = p.slice(1, -1);
        html += `<code>${esc(cmd)}</code><button class="copy" data-copy="${esc(cmd)}" title="Copy">⧉</button>`;
      } else html += esc(p);
    }
    return html;
  }

  function addMsg(role, text) {
    const empty = msgs.querySelector('.chat-empty');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.innerHTML = '<div class="mb"></div>';
    el.querySelector('.mb').textContent = text;
    msgs.appendChild(el);
    stick(true);
    return el;
  }
  const appendText = (el, t) => {
    const pin = nearBottom();
    el.querySelector('.mb').textContent += t;
    stick(pin);
  };
  function appendTool(el, name, detail) {
    const d = document.createElement('div');
    d.className = 'tooluse';
    d.textContent = `› ${name}${detail ? ': ' + detail : ''}`;
    el.appendChild(d);
    stick(false);
  }

  /* strip ```handoff fences from a finished bubble — the card replaces them */
  function finalizeBubble(el) {
    const mb = el.querySelector('.mb');
    const cleaned = mb.textContent.replace(/```handoff\n[\s\S]*?```/g, '').replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned) mb.innerHTML = richText(cleaned);
    else if (!el.querySelector('.tooluse')) el.remove(); // reply was only a handoff
    else mb.remove();
  }

  function renderHandoff(h, prepend) {
    if (!h || document.getElementById('hf-' + h.id)) return;
    const el = document.createElement('div');
    el.id = 'hf-' + h.id;
    el.className = 'handoff' + (h.status !== 'open' ? ' resolved' : '');
    const steps = (h.steps || []).map((s) => `<li>${richText(s)}</li>`).join('');
    el.innerHTML = `
      <div class="ht"><span>${h.status === 'open' ? '⚠' : '✓'} ${esc(h.title)}</span><span class="src">${esc(h.source)}</span></div>
      ${steps ? `<ol>${steps}</ol>` : ''}
      ${h.status === 'open' ? '<div class="hact"><button class="linkbtn act-done">Mark done</button><button class="linkbtn act-dismiss">Dismiss</button></div>' : ''}`;
    const close = async (kind) => {
      const r = await post('/api/handoffs/' + kind, { id: h.id });
      if (r.error) { note(r.error); return; }
      el.classList.add('resolved');
      el.querySelector('.ht span').textContent = (kind === 'resolve' ? '✓ ' : '— ') + h.title;
      el.querySelector('.hact')?.remove();
    };
    el.querySelector('.act-done')?.addEventListener('click', () => close('resolve'));
    el.querySelector('.act-dismiss')?.addEventListener('click', () => close('dismiss'));
    const empty = msgs.querySelector('.chat-empty');
    if (empty) empty.remove();
    if (prepend && msgs.firstChild) msgs.insertBefore(el, msgs.firstChild);
    else { msgs.appendChild(el); stick(true); }
  }

  function emptyState() {
    if (msgs.children.length) return;
    const d = document.createElement('div');
    d.className = 'chat-empty';
    d.innerHTML = 'Ask about this repo — the copilot can read it.';
    for (const s of ['What changed in the last run?', 'Where is the dev-server URL detected?', 'Summarize the open handoffs']) {
      const b = document.createElement('button');
      b.className = 'starter';
      b.textContent = s;
      b.addEventListener('click', () => { input.value = s; send(); });
      d.appendChild(b);
    }
    msgs.appendChild(d);
  }

  async function send() {
    const text = input.value.trim();
    if (!text || aborter) return;
    addMsg('user', text);
    input.value = '';
    autosize();
    const asst = addMsg('assistant', '');
    sendBtn.textContent = 'Stop';
    aborter = new AbortController();
    try {
      const r = await fetch('/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: aborter.signal,
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        asst.querySelector('.mb').textContent = e.error || `chat failed (${r.status})`;
        asst.querySelector('.mb').style.color = 'var(--danger)';
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.type === 'delta') appendText(asst, o.text);
          else if (o.type === 'tool') appendTool(asst, o.name, o.detail);
          else if (o.type === 'handoff') renderHandoff(o.handoff);
          else if (o.type === 'error') {
            appendText(asst, (asst.querySelector('.mb').textContent ? '\n\n' : '') + o.message);
            asst.querySelector('.mb').style.color = 'var(--danger)';
            if (o.signIn) {
              const sb = document.createElement('button');
              sb.className = 'linkbtn';
              sb.textContent = 'Sign in';
              sb.addEventListener('click', () => $('#btn-login').click());
              asst.appendChild(sb);
            }
          }
        }
      }
      finalizeBubble(asst);
    } catch (e) {
      if (e.name === 'AbortError') appendText(asst, ' ⏹ stopped');
      else appendText(asst, '\nconnection lost');
    } finally {
      aborter = null;
      sendBtn.textContent = 'Send';
      stick(false);
    }
  }

  function stop() { if (aborter) aborter.abort(); }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(130, input.scrollHeight) + 'px';
  }

  async function loadHistory() {
    try {
      const [h, hf] = await Promise.all([
        (await fetch('/api/chat/history')).json(),
        (await fetch('/api/handoffs')).json(),
      ]);
      msgs.innerHTML = '';
      for (const item of (hf.handoffs || []).filter((x) => x.status === 'open')) renderHandoff(item, true);
      for (const m of (h.messages || []).slice(-30)) {
        const el = addMsg(m.role, '');
        const mb = el.querySelector('.mb');
        mb.innerHTML = richText(String(m.text).replace(/```handoff\n[\s\S]*?```/g, '').trim());
      }
      emptyState();
      stick(true);
    } catch { /* server hiccup */ }
  }

  function init() {
    msgs = $('#chat-msgs'); input = $('#chat-input'); sendBtn = $('#chat-send');
    sendBtn.addEventListener('click', () => (aborter ? stop() : send()));
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
    $('#chat-new').addEventListener('click', async () => {
      stop();
      await post('/api/chat/reset', {});
      msgs.innerHTML = '';
      emptyState();
      note('new conversation started');
    });
    document.addEventListener('click', (e) => { // copy buttons (delegated)
      const b = e.target.closest('.copy');
      if (!b) return;
      navigator.clipboard?.writeText(b.dataset.copy);
      b.textContent = '✓';
      setTimeout(() => { b.textContent = '⧉'; }, 900);
    });
    Bus.on('handoff.new', (ev) => {
      renderHandoff(ev.data?.handoff);
      if (!Drawers.isOpen('r')) {
        const badge = $('#hud-badge');
        badge.hidden = false;
        badge.textContent = String(Number(badge.textContent || 0) + 1);
      }
    });
    // repo switch resets the session server-side — REFETCH, never clear:
    // the bus replays its event ring on reconnect, and a clear-on-replay
    // would eat real messages on every page load
    Bus.on('chat.reset', () => loadHistory());
    loadHistory();
  }

  return { init };
})();
