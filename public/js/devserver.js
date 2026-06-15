/* devserver.js — "Run locally" as a HUD chip: start/stop the repo's dev
   command and link the detected URL. Output streams to the Activity log
   (dev filter); launch-failure hints arrive as handoffs from the server. */

function renderDev(d) {
  const z = $('#devzone');
  if (!d) { z.innerHTML = ''; return; }
  state.devLast = d;
  const logBtn = d.last?.length ? ` <button class="linkbtn" id="devlog-btn" title="Show dev output in Activity">Log</button>` : '';
  if (d.running) {
    const link = d.url
      ? ` · <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url.replace(/^https?:\/\//, ''))}</a>`
      : ' · starting…';
    z.innerHTML = `<span class="dot ok"></span> app${link}${logBtn} <button class="linkbtn" id="devstop">Stop</button>`;
    $('#devstop').addEventListener('click', async () => { await fetch('/api/dev/stop', { method: 'POST' }); pollDev(); });
    if (!state.devTimer) state.devTimer = setInterval(pollDev, 3000);
  } else {
    if (state.devTimer) { clearInterval(state.devTimer); state.devTimer = null; }
    const failed = d.exitCode != null && d.last?.length;
    const head = failed ? `<span class="dot bad"></span> exited (${d.exitCode})${logBtn} ` : '';
    z.innerHTML = `${head}<button class="linkbtn" id="devstart">▶ ${failed ? 'Retry' : 'Run locally'}</button>`;
    $('#devstart').addEventListener('click', async () => {
      const r = await (await fetch('/api/dev/start', { method: 'POST' })).json();
      if (r.error) { note(r.error); if (/Settings/.test(r.error)) openPanel(); return; }
      pollDev();
      if (!state.devTimer) state.devTimer = setInterval(pollDev, 3000); // watch the boot, catch early deaths
    });
  }
  const lb = $('#devlog-btn');
  if (lb) lb.addEventListener('click', () => ActivityLog.showGroup('dev'));
}

async function pollDev() {
  try { renderDev(await (await fetch('/api/dev/status')).json()); } catch { /* server hiccup */ }
}

// dev start/exit events refresh the chip promptly (the 3s poll covers the gaps);
// replayed history (the ring persists across restarts) doesn't need a poll
Bus.on('dev.start', (ev) => { if (Bus.live(ev)) pollDev(); });
Bus.on('dev.exit', (ev) => { if (Bus.live(ev)) pollDev(); });
