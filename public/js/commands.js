/* commands.js — saved commands in the control center: a name + shell command
   list stored in config, run one-at-a-time in the repo with output streaming
   to the Activity log. */

const Commands = (() => {
  let listEl;
  const cmds = () => state.config?.commands || [];

  async function saveAll(next) {
    const c = await post('/api/config', { commands: next }); // arrays replace wholesale
    if (c.error) { note(c.error); return; }
    state.config = c;
    renderList(c.commands || []);
  }

  function renderList(commands) {
    if (!listEl) return;
    listEl.innerHTML = commands.length ? '' : '<p class="hint">Save the commands you reach for — they run in the repo and stream to Activity.</p>';
    for (const c of commands) {
      const row = document.createElement('div');
      row.className = 'cmdrow';
      row.innerHTML = `
        <span class="cname" title="${esc(c.name)}">${esc(c.name)}</span>
        <span class="ccmd" title="${esc(c.cmd)}">${esc(c.cmd)}</span>
        <button class="linkbtn crun">▶ Run</button>
        <button class="linkbtn cdel" title="Remove">✕</button>`;
      row.querySelector('.crun').addEventListener('click', async () => {
        if (state.batch || state.running) { note('a run is active — commands after it finishes'); return; }
        const r = await post('/api/commands/run', { id: c.id });
        if (r.error) { note(r.error); return; }
        ActivityLog.showGroup('cmd');
      });
      row.querySelector('.cdel').addEventListener('click', () => {
        if (!confirm(`Remove saved command “${c.name}”?`)) return;
        saveAll(cmds().filter((x) => x.id !== c.id));
      });
      listEl.appendChild(row);
    }
    if (commands.length) {
      const stopRow = document.createElement('div');
      stopRow.className = 'row';
      stopRow.style.marginTop = '6px';
      stopRow.innerHTML = '<button class="linkbtn" id="cmd-stop" hidden>⏹ Stop running command</button>';
      listEl.appendChild(stopRow);
      stopRow.querySelector('#cmd-stop').addEventListener('click', async () => {
        await post('/api/commands/stop', {});
      });
    }
  }

  function setRunningUI(on) {
    const b = $('#cmd-stop');
    if (b) b.hidden = !on;
  }

  function init() {
    listEl = $('#commands-list');
    $('#cmd-add').addEventListener('click', () => {
      const name = $('#cmd-name').value.trim();
      const cmd = $('#cmd-cmd').value.trim();
      if (!name || !cmd) { note('name and command are both needed'); return; }
      $('#cmd-name').value = ''; $('#cmd-cmd').value = '';
      saveAll([...cmds(), { id: 'c_' + Math.random().toString(36).slice(2, 8), name: name.slice(0, 40), cmd: cmd.slice(0, 300) }]);
    });
    Bus.on('cmd.start', () => setRunningUI(true));
    Bus.on('cmd.exit', () => setRunningUI(false));
  }

  return { init, renderList };
})();
