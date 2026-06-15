/* main.js — boot. Loaded last; everything it calls is defined by earlier scripts. */

(async function init() {
  Drawers.init();          // restore open/width/rows before anything paints into them
  ActivityLog.init();      // subscribe before the bus connects so replay is captured
  if (typeof Chat !== 'undefined') Chat.init?.();
  if (typeof Commands !== 'undefined') Commands.init?.();
  if (typeof Themes !== 'undefined') Themes.init?.();
  if (typeof Search !== 'undefined') Search.init?.();
  Bus.connect();           // hello + ring replay populate the log and run state

  await loadStatus(false);
  await loadGit();
  await loadSettings();    // control-center fields reflect config on first open
  const data = await loadTasks();
  pollDev();
  RepoViz.init();
  if (typeof Repo3D !== 'undefined') Repo3D.init(); // 3D galaxy shares the same repotree
  Drawers.pushInsets(false); // initial camera fit accounts for open drawers

  // bus-driven refreshes. The ring now PERSISTS across restarts and replays
  // on every reconnect — every fetch-triggering handler must ignore stale
  // replayed events (Bus.live) or a reconnect becomes a fetch storm.
  const live = Bus.live;
  Bus.on('scan.done', async (ev) => {
    if (!live(ev)) return;
    if (state.batch || state.running) return; // board re-renders after the batch settles
    render(await (await fetch('/api/tasks')).json());
  });
  // queued/discarded goals change the board WITHOUT a scan — refetch so the
  // tasks panel and galaxy marks stay in step with the copilot and activity
  // (debounced: the bus replays its ring on every reconnect)
  let taskSync = null;
  const syncBoard = () => {
    clearTimeout(taskSync);
    taskSync = setTimeout(async () => {
      render(await (await fetch('/api/tasks')).json());
      refreshRepo(); // queueing dirties the backlog file — keep the ±n chip honest
    }, 150);
  };
  Bus.on('task.', (ev) => {
    if (!live(ev) || state.batch || state.running) return;
    syncBoard();
  });
  Bus.on('git.', (ev) => { if (live(ev)) refreshRepo(); });
  // a finished run moved the repo onto a new branch and may have checked off
  // a backlog goal — reflect both right away, before the post-run scan lands
  Bus.on('run.done', (ev) => {
    if (!live(ev) || state.batch) return;
    syncBoard();
  });
  // settings changed externally (the other Workloop instance, or a hand-edit)
  Bus.on('config.changed', (ev) => {
    if (!live(ev)) return;
    loadSettings();
    refreshRepo();
  });
  // a resolved handoff often means its blocker is gone — re-check the thing
  // it was blocking instead of waiting for the user to hit Recheck
  Bus.on('handoff.resolved', (ev) => {
    if (!live(ev)) return;
    const h = ev.data?.handoff;
    if (h?.context?.tag === 'signin') loadStatus(true);
    else if (h?.context?.tag === 'dirty') refreshRepo();
    const tid = h?.context?.taskId;
    if (tid) {
      const card = document.querySelector(`.card[data-id="${CSS.escape(tid)}"]`);
      const v = card?.querySelector('.result .v');
      if (card && v) {
        if (!/\b(ok|warn|fail)\b/.test(card.className)) card.classList.add('warn');
        v.textContent = 'handoff resolved — Retry when ready';
      }
    }
  });

  const repoOk = state.status?.repo?.exists && state.status.repo.git;
  if (repoOk && !(data.tasks || []).length) await scan(); // auto-scan on first load
})();
