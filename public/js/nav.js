/* nav.js — galaxy navigation chrome: fuzzy file search with fly-to, the
   hovered-path breadcrumb, extension filter chips, pinned files, the focused
   subtree chip, and the node menu (peek, history, open/reveal/copy, pin,
   focus, queue-a-goal, ask-copilot, show-task) for both galaxy views. */

const Search = (() => {
  let box, drop, crumb, chipsEl, pop;
  let results = [], sel = 0, filterSet = new Set();
  let pins = new Set(), focusPath = null, focusChip = null, menuXY = null;
  try { pins = new Set(JSON.parse(localStorage.getItem('wl.pins') || '[]')); } catch { pins = new Set(); }
  const savePins = () => { localStorage.setItem('wl.pins', JSON.stringify([...pins])); Viz.setPins(new Set(pins)); };

  const fmtB = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B';
  const ago = (t) => { const d = Date.now() / 1000 - t;
    return d < 3600 ? Math.max(1, Math.floor(d / 60)) + 'm ago' : d < 86400 ? Math.floor(d / 3600) + 'h ago' : Math.floor(d / 86400) + 'd ago'; };

  /* subsequence scorer: consecutive runs and segment starts win, length loses */
  function score(q, p) {
    const lp = p.toLowerCase();
    let qi = 0, s = 0, run = 0;
    for (let i = 0; i < lp.length && qi < q.length; i++) {
      if (lp[i] === q[qi]) {
        run++;
        s += 1 + run * 2 + (i === 0 || lp[i - 1] === '/' || lp[i - 1] === '.' || lp[i - 1] === '-' || lp[i - 1] === '_' ? 2 : 0);
        qi++;
      } else run = 0;
    }
    if (qi < q.length) return -1;
    return s - p.length * 0.01;
  }

  function update() {
    const q = box.value.trim().toLowerCase();
    if (!q) { renderPinDrop(); return; } // empty box doubles as the pin list
    results = [];
    for (const p of Viz.allPaths()) {
      const s = score(q, p);
      if (s >= 0) results.push([s, p]);
    }
    results.sort((a, b) => b[0] - a[0]);
    results = results.slice(0, 12).map(([, p]) => p);
    sel = 0;
    renderDrop();
  }

  function renderDrop() {
    if (!results.length) { drop.hidden = true; return; }
    drop.innerHTML = results.map((p, i) => {
      const base = p.slice(p.lastIndexOf('/') + 1);
      const dir = p.slice(0, p.lastIndexOf('/') + 1);
      return `<div class="sr${i === sel ? ' on' : ''}" role="option" aria-selected="${i === sel}" data-p="${esc(p)}">
        <span class="srb">${esc(base)}</span><span class="srd">${esc(dir)}</span></div>`;
    }).join('');
    drop.hidden = false;
    drop.querySelectorAll('.sr').forEach((el) => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); go(el.dataset.p); });
    });
  }

  function go(path) {
    close();
    box.blur();
    if (!Viz.flyTo(path)) {
      if (pins.has(path)) { pins.delete(path); savePins(); note('pinned file is gone — unpinned'); }
      else note('not on the map right now — rescan?');
    }
  }

  function renderPinDrop() { // ★ pinned files when the search box is empty
    const list = [...pins];
    if (!list.length) { close(); return; }
    results = list;
    sel = 0;
    drop.innerHTML = list.map((p, i) => {
      const base = p.slice(p.lastIndexOf('/') + 1);
      const dir = p.slice(0, p.lastIndexOf('/') + 1);
      return `<div class="sr${i === sel ? ' on' : ''}" role="option" aria-selected="${i === sel}" data-p="${esc(p)}">
        <span class="srb">★ ${esc(base)}</span><span class="srd">${esc(dir)}</span><button class="srx" title="Unpin">✕</button></div>`;
    }).join('');
    drop.hidden = false;
    drop.querySelectorAll('.sr').forEach((el) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        if (e.target.closest('.srx')) { pins.delete(el.dataset.p); savePins(); renderPinDrop(); return; }
        go(el.dataset.p);
      });
    });
  }

  function close() { drop.hidden = true; results = []; }
  const closeIfOpen = () => { if (!drop.hidden) { close(); return true; } return false; };

  /* ----- breadcrumb ----- */
  function renderCrumb(info) {
    if (!info) { crumb.hidden = true; return; }
    const parts = info.path.split('/');
    let acc = '';
    crumb.innerHTML = parts.map((seg, i) => {
      acc = acc ? acc + '/' + seg : seg;
      const last = i === parts.length - 1;
      return `<button class="cseg${last ? ' last' : ''}" data-p="${esc(acc)}">${esc(seg)}${last && info.isDir ? '/' : ''}</button>`;
    }).join('<span class="csep">/</span>');
    crumb.hidden = false;
    crumb.querySelectorAll('.cseg').forEach((b) => {
      b.addEventListener('click', () => Viz.flyTo(b.dataset.p));
    });
  }

  /* ----- extension chips ----- */
  function renderChips() {
    const langs = Object.entries(Viz.langStats()).filter(([e]) => e).sort((a, b) => b[1] - a[1]).slice(0, 8);
    chipsEl.innerHTML = '';
    for (const [ext, n] of langs) {
      const b = document.createElement('button');
      b.className = 'extchip' + (filterSet.has(ext) ? ' on' : '');
      b.textContent = ext;
      b.title = `${n} files — click to spotlight .${ext}`;
      b.addEventListener('click', () => {
        if (filterSet.has(ext)) filterSet.delete(ext); else filterSet.add(ext);
        b.classList.toggle('on', filterSet.has(ext));
        Viz.setExtFilter(new Set(filterSet));
      });
      chipsEl.appendChild(b);
    }
  }

  /* ----- focused subtree ----- */
  function setFocus(p) {
    focusPath = p || null;
    Viz.setPathFilter(focusPath);
    if (!focusChip) return;
    focusChip.hidden = !focusPath;
    if (focusPath) {
      focusChip.textContent = '⌖ ' + (focusPath.split('/').pop() || focusPath) + ' ✕';
      focusChip.title = 'focused on ' + focusPath + ' — click to clear';
    }
  }

  /* ----- node menu (left-click a file or right-click anything, both views) ----- */
  function closeMenu() {
    pop.hidden = true;
    pop.classList.remove('wide');
    Viz.setSelected(null); // selection trail follows the menu's lifetime
  }
  function place(sx, sy) {
    const shell = $('#stage').getBoundingClientRect(); // pop lives in #stage — covers both views
    pop.style.left = Math.max(8, Math.min(sx + 14, shell.width - pop.offsetWidth - 12)) + 'px';
    pop.style.top = Math.max(8, Math.min(sy + 14, shell.height - pop.offsetHeight - 12)) + 'px';
  }
  function showMenu(info, sx, sy) {
    if (!info) { closeMenu(); return; }
    menuXY = [sx, sy];
    Viz.setSelected(info.path); // blue trail while this node owns the menu
    const tasks = (state.tasks || []).filter((t) => t.file === info.path);
    let meta, acts;
    if (info.isDir) {
      meta = `${(info.leaf || 0).toLocaleString()} files · ${fmtB(info.bytes)}` +
        (info.isAgg ? ` · +${info.aggCount.toLocaleString()} folded` : '') +
        (info.topExts || []).map(([e, c]) => ` · ${esc(e)} ${c}`).join('');
      acts = `
        <button class="linkbtn" data-act="focus">${focusPath === info.path ? 'Unfocus' : 'Focus subtree'}</button>
        <button class="linkbtn" data-act="finder">Reveal in Finder</button>
        <button class="linkbtn" data-act="copy">Copy path</button>`;
    } else {
      meta = `${fmtB(info.size)}${info.ext ? ' · ' + esc(info.ext) : ''}${info.t ? ' · edited ' + ago(info.t) : ''}`;
      acts = `
        <button class="linkbtn" data-act="peek">Peek</button>
        <button class="linkbtn" data-act="history">History</button>
        <button class="linkbtn" data-act="editor">Open in editor</button>
        <button class="linkbtn" data-act="finder">Reveal in Finder</button>
        <button class="linkbtn" data-act="copy">Copy path</button>
        <button class="linkbtn" data-act="pin">${pins.has(info.path) ? 'Unpin' : 'Pin'}</button>`;
    }
    pop.innerHTML = `
      <div class="pp">${esc(info.path || info.name)}${info.isDir ? '/' : ''}</div>
      <div class="pmeta">${meta}</div>
      <div class="pa">${acts}</div>
      <div class="pa psec">
        <button class="linkbtn" data-act="goal">Queue a goal</button>
        <button class="linkbtn" data-act="chat">Ask Copilot</button>
      </div>` +
      (tasks.length ? `<div class="pa psec"><span class="pmeta" style="margin:0">${tasks.length} open task${tasks.length > 1 ? 's' : ''}</span>
        <button class="linkbtn" data-act="task">Show</button></div>` : '') +
      `<div class="peek" hidden></div>`;
    pop.classList.remove('wide');
    pop.hidden = false;
    place(sx, sy);
    pop.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, info, tasks)));
  }

  async function act(a, info, tasks) {
    const path = info.path;
    if (a === 'copy') { navigator.clipboard?.writeText(path); note('path copied'); closeMenu(); }
    else if (a === 'editor' || a === 'finder') {
      const r = await post('/api/open', { path, mode: a });
      if (r.error) note(r.error);
      closeMenu();
    }
    else if (a === 'pin') {
      if (pins.has(path)) { pins.delete(path); note('unpinned'); }
      else { pins.add(path); note('pinned — it lives in the search box now'); }
      savePins();
      closeMenu();
    }
    else if (a === 'focus') { setFocus(focusPath === path ? null : path); closeMenu(); }
    else if (a === 'goal') {
      Drawers.setOpen('r', true);
      Drawers.setFolded('tasks', false);
      const g = $('#goal');
      g.value = path + ': ';
      g.focus();
      g.setSelectionRange(g.value.length, g.value.length);
      closeMenu();
    }
    else if (a === 'chat') {
      Drawers.setOpen('r', true);
      Drawers.setFolded('chat', false);
      const i = $('#chat-input');
      i.value = 'About `' + path + '`: ';
      i.dispatchEvent(new Event('input')); // composer autosizes on input
      i.focus();
      i.setSelectionRange(i.value.length, i.value.length);
      closeMenu();
    }
    else if (a === 'task') {
      Drawers.setOpen('r', true);
      Drawers.setFolded('tasks', false);
      let first = null;
      for (const t of tasks) {
        const card = document.querySelector('.card[data-id="' + CSS.escape(t.id) + '"]');
        if (!card) continue;
        if (!first) first = card;
        card.classList.add('flash');
        card.addEventListener('animationend', () => card.classList.remove('flash'), { once: true });
      }
      if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else note('task card not on the board right now');
      closeMenu();
    }
    else if (a === 'peek' || a === 'history') {
      const panel = pop.querySelector('.peek');
      if (!panel) return;
      if (panel.dataset.mode === a && !panel.hidden) { // second press folds it back up
        panel.hidden = true;
        pop.classList.remove('wide');
        place(...menuXY);
        return;
      }
      panel.dataset.mode = a;
      panel.hidden = false;
      panel.innerHTML = '<pre>…</pre>';
      pop.classList.add('wide');
      if (a === 'peek') {
        let r;
        try { r = await (await fetch('/api/file?path=' + encodeURIComponent(path) + '&n=120')).json(); }
        catch { r = { error: 'server unreachable' }; }
        panel.innerHTML = r.error ? `<pre>${esc(r.error)}</pre>`
          : r.binary ? `<pre>binary file · ${fmtB(r.size)}</pre>`
            : `<pre>${esc(r.text)}</pre>` + (r.truncated ? `<div class="pmeta">first 120 lines${r.total ? ' of ' + r.total : ''} — Open in editor for the rest</div>` : '');
      } else {
        let r;
        try { r = await (await fetch('/api/git/log?path=' + encodeURIComponent(path) + '&n=8')).json(); }
        catch { r = { commits: [] }; }
        panel.innerHTML = (r.commits && r.commits.length)
          ? `<pre>${r.commits.map((c) => esc(`${ago(c.ts)} · ${c.an} · ${c.s}`)).join('\n')}</pre>`
          : '<pre>no commits touch this file</pre>';
      }
      place(...menuXY);
    }
  }

  function init() {
    box = $('#searchbox'); drop = $('#search-drop'); crumb = $('#hud-crumb'); chipsEl = $('#extchips'); pop = $('#viz-pop');

    // focus chip lives BESIDE #extchips — renderChips() rewrites that element wholesale
    focusChip = document.createElement('button');
    focusChip.id = 'focus-chip';
    focusChip.className = 'extchip focuschip';
    focusChip.hidden = true;
    chipsEl.insertAdjacentElement('afterend', focusChip);
    focusChip.addEventListener('click', () => setFocus(null));

    box.addEventListener('input', update);
    box.addEventListener('focus', () => { if (!box.value.trim()) renderPinDrop(); });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { sel = Math.min(results.length - 1, sel + 1); renderDrop(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderDrop(); e.preventDefault(); }
      else if (e.key === 'Enter' && results.length) { go(results[sel]); e.preventDefault(); }
      else if (e.key === 'Escape') { close(); box.blur(); e.stopPropagation(); }
    });
    box.addEventListener('blur', () => setTimeout(close, 150));

    addEventListener('keydown', (e) => {
      const inField = e.target.closest('input, textarea, select') || e.target.isContentEditable;
      if ((e.key === '/' && !inField) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        box.focus();
        box.select();
      }
    });

    Viz.onHoverChange(renderCrumb);
    Viz.onNodeMenu(showMenu);
    Viz.onFileClick((p) => { if (!p) closeMenu(); }); // empty-canvas clicks close the menu
    Viz.setPins(new Set(pins));
    addEventListener('pointerdown', (e) => { // click-away closes the menu
      if (!pop.hidden && !e.target.closest('#viz-pop')) closeMenu();
    });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closeMenu(); });

    Bus.on('scan.done', () => setTimeout(() => { // langs refresh after reload
      renderChips();
      if (focusPath && !Viz.allPaths().some((p) => p === focusPath || p.startsWith(focusPath + '/'))) {
        setFocus(null);
        note('focused folder is gone — filter cleared');
      }
    }, 500));
    setTimeout(renderChips, 2500); // first load
  }

  return { init, closeIfOpen };
})();
