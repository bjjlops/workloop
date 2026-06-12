/* drawers.js — slide-out panels. Overlay (never push: pushing would resize
   the galaxy canvases every animation frame). Open state + widths + right-
   drawer row sizes persist in localStorage under wl.* keys. Camera insets
   are handed to the galaxy so fit/fly keep targets in the visible gap. */

const Drawers = (() => {
  const NARROW = () => matchMedia('(max-width: 760px)').matches;
  const body = document.body;
  const right = $('#drawer-right'), left = $('#drawer-left'), scrim = $('#scrim');
  const grid = $('#dr-grid');
  let order = []; // most recently opened last — Esc closes the topmost

  const st = {
    rOpen: localStorage.getItem('wl.drawerR.open') !== '0', // default open
    lOpen: localStorage.getItem('wl.drawerL.open') === '1',
    rW: Number(localStorage.getItem('wl.drawerR.w')) || 0,
    lW: Number(localStorage.getItem('wl.drawerL.w')) || 0,
    rows: JSON.parse(localStorage.getItem('wl.drawer.rows') || 'null') || { tasks: 38, log: 30 },
    folded: JSON.parse(localStorage.getItem('wl.drawer.folded') || '{}'),
  };

  function widthOf(side) {
    const el = side === 'r' ? right : left;
    return el.getBoundingClientRect().width;
  }

  function pushInsets(animate = true) {
    const ins = {
      top: 0, bottom: 0, // stage already starts below the HUD
      right: !NARROW() && body.classList.contains('drawer-r-open') ? widthOf('r') : 0,
      left: !NARROW() && body.classList.contains('drawer-l-open') ? widthOf('l') : 0,
    };
    // stage overlays (viz toolbar, ticker, legend) shift out from under the drawers
    document.documentElement.style.setProperty('--inset-r', ins.right + 'px');
    document.documentElement.style.setProperty('--inset-l', ins.left + 'px');
    if (RepoViz.setInsets) RepoViz.setInsets(ins, animate);
    if (typeof Repo3D !== 'undefined') Repo3D.setInsets(ins);
  }

  function apply(save = true, animate = true) {
    body.classList.toggle('drawer-r-open', st.rOpen);
    body.classList.toggle('drawer-l-open', st.lOpen);
    $('#toggle-right').setAttribute('aria-expanded', String(st.rOpen));
    $('#toggle-left').setAttribute('aria-expanded', String(st.lOpen));
    scrim.hidden = !(NARROW() && (st.rOpen || st.lOpen));
    if (save) {
      localStorage.setItem('wl.drawerR.open', st.rOpen ? '1' : '0');
      localStorage.setItem('wl.drawerL.open', st.lOpen ? '1' : '0');
    }
    // after the slide transition the width is stable; push insets then too
    pushInsets(animate);
  }

  function setOpen(side, open) {
    const key = side === 'r' ? 'rOpen' : 'lOpen';
    if (st[key] === open) return;
    st[key] = open;
    order = order.filter((s) => s !== side);
    if (open) order.push(side);
    if (open && NARROW()) { // sheets are mutually exclusive on narrow screens
      const other = side === 'r' ? 'lOpen' : 'rOpen';
      st[other] = false;
    }
    apply();
    if (open) {
      if (side === 'r') { const b = $('#hud-badge'); b.hidden = true; b.textContent = ''; }
      const el = side === 'r' ? right : left;
      const f = el.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (f) f.focus({ preventScroll: true });
    } else {
      $(side === 'r' ? '#toggle-right' : '#toggle-left').focus();
    }
  }
  const toggle = (side) => setOpen(side, !(side === 'r' ? st.rOpen : st.lOpen));

  function openLeft(sectionId) {
    setOpen('l', true);
    if (sectionId) {
      const sec = document.getElementById(sectionId);
      if (sec) { sec.open = true; sec.scrollIntoView({ block: 'nearest' }); }
    }
  }

  /* ----- widths ----- */
  function applyWidths() {
    if (st.rW) right.style.width = st.rW + 'px';
    if (st.lW) left.style.width = st.lW + 'px';
  }
  function bindGrip(gripEl, side) {
    gripEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gripEl.setPointerCapture(e.pointerId);
      gripEl.classList.add('dragging');
      const el = side === 'r' ? right : left;
      const startW = el.getBoundingClientRect().width, startX = e.clientX;
      const move = (ev) => {
        const dx = ev.clientX - startX;
        const w = Math.max(300, Math.min(680, side === 'r' ? startW - dx : startW + dx));
        el.style.width = w + 'px';
        st[side === 'r' ? 'rW' : 'lW'] = w;
      };
      const up = () => {
        gripEl.classList.remove('dragging');
        gripEl.removeEventListener('pointermove', move);
        localStorage.setItem(side === 'r' ? 'wl.drawerR.w' : 'wl.drawerL.w', String(st[side === 'r' ? 'rW' : 'lW']));
        pushInsets();
      };
      gripEl.addEventListener('pointermove', move);
      gripEl.addEventListener('pointerup', up, { once: true });
      gripEl.addEventListener('pointercancel', up, { once: true });
    });
  }

  /* ----- right-drawer rows ----- */
  function applyRows() {
    const f = st.folded;
    const rows = [
      f.tasks ? '34px' : `minmax(120px, ${st.rows.tasks}fr)`,
      '6px',
      f.log ? '34px' : `minmax(90px, ${st.rows.log}fr)`,
      '6px',
      f.chat ? '34px' : `minmax(160px, ${Math.max(8, 100 - st.rows.tasks - st.rows.log)}fr)`,
    ];
    grid.style.gridTemplateRows = rows.join(' ');
    for (const sec of ['tasks', 'log', 'chat']) {
      const el = $('#sec-' + sec);
      el.classList.toggle('collapsed', !!f[sec]);
      el.querySelector('.dsec-fold').setAttribute('aria-expanded', String(!f[sec]));
    }
  }
  function saveRows() {
    localStorage.setItem('wl.drawer.rows', JSON.stringify(st.rows));
    localStorage.setItem('wl.drawer.folded', JSON.stringify(st.folded));
  }
  function bindRowDiv(div) {
    const which = div.dataset.div; // 1: tasks/log, 2: log/chat
    const step = (d) => {
      const key = which === '1' ? 'tasks' : 'log';
      st.rows[key] = Math.max(8, Math.min(80, st.rows[key] + d));
      applyRows(); saveRows();
    };
    div.addEventListener('dblclick', () => { st.rows = { tasks: 38, log: 30 }; applyRows(); saveRows(); });
    div.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { step(-2); e.preventDefault(); }
      if (e.key === 'ArrowDown') { step(2); e.preventDefault(); }
    });
    div.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      div.setPointerCapture(e.pointerId);
      div.classList.add('dragging');
      const gh = grid.getBoundingClientRect().height;
      const startY = e.clientY, start = { ...st.rows };
      const move = (ev) => {
        const dPct = ((ev.clientY - startY) / gh) * 100;
        if (which === '1') st.rows.tasks = Math.max(8, Math.min(80, start.tasks + dPct));
        else st.rows.log = Math.max(8, Math.min(80, start.log + dPct));
        applyRows();
      };
      const up = () => { div.classList.remove('dragging'); div.removeEventListener('pointermove', move); saveRows(); };
      div.addEventListener('pointermove', move);
      div.addEventListener('pointerup', up, { once: true });
      div.addEventListener('pointercancel', up, { once: true });
    });
  }

  /* ----- keyboard ----- */
  const inField = (e) => e.target.closest('input, textarea, select') || e.target.isContentEditable;
  function bindKeys() {
    addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        // galaxy handles its pinned tip itself; we close the topmost drawer
        if (inField(e)) { e.target.blur(); return; }
        const top = order[order.length - 1];
        if (top && (top === 'r' ? st.rOpen : st.lOpen)) setOpen(top, false);
        return;
      }
      if (inField(e)) return;
      const v3 = document.body.dataset.viz === '3d'; // hotkeys steer the view you can see
      if (e.key === ']') { toggle('r'); e.preventDefault(); }
      else if (e.key === '[') { toggle('l'); e.preventDefault(); }
      else if (e.key === 'f') $(v3 ? '#v3-fit' : '#viz-fit')?.click();
      else if (e.key === 'h') Viz.toggleHeat();
      else if (e.key === '+' || e.key === '=') $(v3 ? '#v3-zin' : '#viz-zin')?.click();
      else if (e.key === '-') $(v3 ? '#v3-zout' : '#viz-zout')?.click();
    });
  }

  function init() {
    body.classList.add('no-anim'); // restore without a slide animation
    applyWidths();
    applyRows();
    if (st.rOpen) order.push('r');
    if (st.lOpen) order.push('l');
    apply(false, false);
    requestAnimationFrame(() => requestAnimationFrame(() => body.classList.remove('no-anim')));

    $('#toggle-right').addEventListener('click', () => toggle('r'));
    $('#toggle-left').addEventListener('click', () => toggle('l'));
    $('#hud-branch').addEventListener('click', () => openLeft('sec-branches'));
    $('#hud-engine').addEventListener('click', () => openLeft('sec-engine'));
    scrim.addEventListener('click', () => { setOpen('r', false); setOpen('l', false); });
    bindGrip($('#grip-r'), 'r');
    bindGrip($('#grip-l'), 'l');
    document.querySelectorAll('.rowdiv').forEach(bindRowDiv);
    document.querySelectorAll('.dsec-fold').forEach((b) => {
      b.addEventListener('click', () => {
        const sec = b.dataset.sec;
        st.folded[sec] = !st.folded[sec];
        applyRows(); saveRows();
      });
    });
    // drawer transitions change the visible rect — re-fit after the slide
    right.addEventListener('transitionend', (e) => { if (e.propertyName === 'transform') pushInsets(); });
    left.addEventListener('transitionend', (e) => { if (e.propertyName === 'transform') pushInsets(); });
    addEventListener('resize', () => { apply(false, false); });
    bindKeys();
  }

  function setFolded(sec, folded) { // programmatic fold control: 'tasks' | 'log' | 'chat'
    if (!['tasks', 'log', 'chat'].includes(sec)) return;
    if (!!st.folded[sec] === !!folded) return;
    st.folded[sec] = !!folded;
    applyRows();
    saveRows();
  }

  return { init, toggle, setOpen, openLeft, setFolded, pushInsets, isOpen: (s) => (s === 'r' ? st.rOpen : st.lOpen) };
})();
