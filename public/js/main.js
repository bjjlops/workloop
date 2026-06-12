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

  // bus-driven refreshes
  Bus.on('scan.done', async () => {
    if (state.batch || state.running) return; // board re-renders after the batch settles
    render(await (await fetch('/api/tasks')).json());
  });
  // queued/discarded goals change the board WITHOUT a scan — refetch so the
  // tasks panel and galaxy marks stay in step with the copilot and activity
  // (debounced: the bus replays its ring on every reconnect)
  let taskSync = null;
  Bus.on('task.', () => {
    if (state.batch || state.running) return;
    clearTimeout(taskSync);
    taskSync = setTimeout(async () => {
      render(await (await fetch('/api/tasks')).json());
      refreshRepo(); // queueing dirties the backlog file — keep the ±n chip honest
    }, 150);
  });
  Bus.on('git.', () => refreshRepo());

  const repoOk = state.status?.repo?.exists && state.status.repo.git;
  if (repoOk && !(data.tasks || []).length) await scan(); // auto-scan on first load
})();
