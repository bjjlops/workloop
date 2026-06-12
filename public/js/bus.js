/* bus.js — single EventSource on /api/events. Owns the client's run state:
   `state.running`, body.run-active, and the RepoViz runStarted/runEnded hooks
   are driven ONLY from here (board.js per-run streams just feed card logs).
   A reload mid-run re-syncs from the `hello` snapshot. */

const Bus = (() => {
  const subs = []; // [prefix, fn]
  let es = null, lastBootId = null;

  function on(prefix, fn) { subs.push([prefix, fn]); }
  function dispatch(ev) {
    for (const [p, fn] of subs) {
      if (ev.kind.startsWith(p)) { try { fn(ev); } catch (e) { console.error('bus handler', p, e); } }
    }
  }

  function syncRun(running, ok) {
    const was = !!state.running;
    state.running = running || null;
    document.body.classList.toggle('run-active', !!state.running);
    if (!was && state.running) { RepoViz.runStarted(); if (typeof Repo3D !== 'undefined') Repo3D.runStarted(); }
    else if (was && !state.running) { RepoViz.runEnded(ok); if (typeof Repo3D !== 'undefined') Repo3D.runEnded(ok); }
    if (typeof updateRunUI === 'function') updateRunUI();
  }

  function connect() {
    es = new EventSource('/api/events');
    es.addEventListener('hello', (e) => {
      let h; try { h = JSON.parse(e.data); } catch { return; }
      if (lastBootId && h.bootId !== lastBootId) {
        // server restarted — stale log rows are about to be replayed fresh
        if (typeof ActivityLog !== 'undefined') ActivityLog.clear();
      }
      lastBootId = h.bootId;
      if (!!h.running !== !!state.running) syncRun(h.running); // reload mid-run / missed end
      dispatch({ kind: 'bus.hello', ts: Date.now(), message: '', data: h });
    });
    es.onmessage = (e) => {
      let ev; try { ev = JSON.parse(e.data); } catch { return; }
      dispatch(ev);
    };
    // EventSource reconnects automatically (server sends retry: 3000)
  }

  on('run.start', (ev) => syncRun(ev.data || { taskId: '?' }));
  on('run.done', (ev) => syncRun(null, ev.data ? !!ev.data.ok : null));
  on('run.file', (ev) => { // live read/edit attribution for the galaxy trails
    if (!state.running || !ev.data?.path) return; // ring replays of finished runs stay inert
    RepoViz.fileActivity?.(ev.data.path, ev.data.op);
    if (typeof Repo3D !== 'undefined') Repo3D.fileActivity?.(ev.data.path, ev.data.op);
  });

  return { connect, on };
})();
