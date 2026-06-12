/* viz-mode.js — the 2D ⇄ 3D switch and the 3D drawer controls.
   The two galaxies live in sibling stage sections (#repoviz / #repoviz3d);
   flipping body[data-viz] swaps them and tells Repo3D to wake or sleep.
   The 3D tweak sliders (camera feel, atmosphere, layout shape, node sizing)
   build themselves into #g3d-tweaks using the drawer's existing .field/.qrow
   recipe, persist as one JSON blob, and push straight into Repo3D. */
const VizMode = (() => {
  const KEY = 'wl.viz', TWKEY = 'wl.g3d.tw';
  let mode = localStorage.getItem(KEY) || '3d';

  const fmt2 = (v) => String(Math.round(v * 100) / 100);
  const SLIDERS = [
    // key, label, min, max, step, format
    ['fov', 'FOV', 35, 85, 1, (v) => Math.round(v) + '°'],
    ['drift', 'drift speed', 0, 2, 0.05, fmt2],
    ['inertia', 'inertia', 0, 0.98, 0.02, fmt2],
    ['neb', 'nebula', 0, 2, 0.05, fmt2],
    ['stars', 'stars', 0, 2, 0.05, fmt2],
    ['bloom', 'bloom', 0, 2, 0.05, fmt2],
    ['twist', 'arm twist', 0.2, 2.6, 0.05, fmt2],
    ['spread', 'spread', 0.5, 1.8, 0.02, fmt2],
    ['thick', 'depth', 0, 2, 0.05, fmt2],
    ['nodeSize', 'node size', 0.4, 2.2, 0.05, fmt2],
    ['labels', 'labels', 0, 2, 0.05, fmt2],
  ];

  function apply(m, persist = true) {
    mode = m === '2d' ? '2d' : '3d';
    document.body.dataset.viz = mode;
    $('#view-2d')?.classList.toggle('on', mode === '2d');
    $('#view-3d')?.classList.toggle('on', mode === '3d');
    const crumb = $('#hud-crumb'), pop = $('#viz-pop');
    if (crumb) crumb.hidden = true; // shared overlays: don't carry stale state across the switch
    if (pop) pop.hidden = true;
    if (typeof Repo3D !== 'undefined') Repo3D.setVisible(mode === '3d');
    // a map revealed after booting hidden must re-measure (RO can miss the flip)
    if (mode === '2d' && typeof RepoViz !== 'undefined' && RepoViz.resize) requestAnimationFrame(() => RepoViz.resize());
    if (persist) localStorage.setItem(KEY, mode);
  }

  function loadTweaks() {
    try { return JSON.parse(localStorage.getItem(TWKEY) || '{}'); } catch { return {}; }
  }
  function buildControls() {
    const host = $('#g3d-tweaks');
    if (!host || typeof Repo3D === 'undefined') return;
    const saved = loadTweaks();
    const cur = { ...Repo3D.tweaks(), ...saved };
    for (const [k, v] of Object.entries(saved)) Repo3D.setTweak(k, v);
    for (const [key, label, min, max, step, fm] of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `<label for="f3-${key}">${label}</label>
        <div class="qrow"><input type="range" id="f3-${key}" min="${min}" max="${max}" step="${step}" /><span class="qname" id="f3v-${key}"></span></div>`;
      host.appendChild(row);
      const r = row.querySelector('input'), val = row.querySelector('.qname');
      r.value = String(cur[key]);
      val.textContent = fm(cur[key]);
      r.addEventListener('input', () => {
        const v = parseFloat(r.value);
        val.textContent = fm(v);
        Repo3D.setTweak(key, v);
        const s = loadTweaks(); s[key] = v;
        localStorage.setItem(TWKEY, JSON.stringify(s));
      });
    }
    // layout switcher
    const seg = $('#layseg');
    if (seg) {
      const sync = () => {
        const cur2 = Repo3D.layout();
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lay === cur2));
      };
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { Repo3D.setLayout(b.dataset.lay); sync(); }));
      sync();
    }
  }

  function init() {
    $('#view-2d')?.addEventListener('click', () => apply('2d'));
    $('#view-3d')?.addEventListener('click', () => apply('3d'));
    buildControls();
    apply(mode, false);
  }
  // deferred scripts: body exists — set the attribute before first paint
  document.body.dataset.viz = mode;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { apply, mode: () => mode };
})();

/* Viz — one door for everything outside the galaxies (nav, board, drawers).
   State ops fan out to BOTH views so they stay in sync across the 2D ⇄ 3D
   switch; reads and navigation go to the ACTIVE view, falling back to the
   other when it has no data yet (both are built from the same payload). */
const Viz = (() => {
  const has3D = () => typeof Repo3D !== 'undefined';
  const is3D = () => document.body.dataset.viz === '3d' && has3D();
  const active = () => (is3D() ? Repo3D : RepoViz);
  const other = () => (is3D() ? RepoViz : (has3D() ? Repo3D : null));
  const each = (fn) => { fn(RepoViz); if (has3D()) fn(Repo3D); };
  return {
    active,
    reload: () => each((v) => v.reload && v.reload()),
    allPaths: () => {
      const a = (active().allPaths && active().allPaths()) || [];
      if (a.length) return a;
      const o = other();
      return (o && o.allPaths && o.allPaths()) || [];
    },
    langStats: () => {
      const a = (active().langStats && active().langStats()) || {};
      if (Object.keys(a).length) return a;
      const o = other();
      return (o && o.langStats && o.langStats()) || {};
    },
    flyTo: (p) => !!(active().flyTo && active().flyTo(p)),
    spotlight: (p) => each((v) => v.spotlight && v.spotlight(p)),
    setExtFilter: (s) => each((v) => v.setExtFilter && v.setExtFilter(s)),
    setPathFilter: (p) => each((v) => v.setPathFilter && v.setPathFilter(p)),
    setTaskMarks: (l) => each((v) => v.setTaskMarks && v.setTaskMarks(l)),
    setPins: (s) => each((v) => v.setPins && v.setPins(s)),
    setDirty: (l) => each((v) => v.setDirty && v.setDirty(l)),
    onNodeMenu: (fn) => each((v) => v.onNodeMenu && v.onNodeMenu(fn)),
    onHoverChange: (fn) => each((v) => v.onHoverChange && v.onHoverChange(fn)),
    onFileClick: (fn) => each((v) => v.onFileClick && v.onFileClick(fn)),
    setHeat: (on) => {
      localStorage.setItem('wl.heat', on ? '1' : '0');
      each((v) => v.setHeat && v.setHeat(on));
    },
    toggleHeat: () => Viz.setHeat(localStorage.getItem('wl.heat') !== '1'),
  };
})();

/* Ping — the uncommitted-file shockwave's personality, user-tunable from the
   Appearance section. Both galaxies read Ping.cfg live each frame; sliders
   persist as one JSON blob (wl.ping), same recipe as the 3D tweaks. */
const Ping = (() => {
  const DEF = { on: true, every: 7, sweep: 3.6, width: 1, power: 1 };
  const cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('wl.ping') || '{}')); } catch { /* fresh */ }
  cfg.on = cfg.on !== false;
  const fmtS = (v) => v.toFixed(1) + 's';
  const fmtX = (v) => '×' + v.toFixed(2);
  const SLIDERS = [
    // key, label, min, max, step, format
    ['every', 'fires every', 3, 20, 0.5, fmtS],
    ['sweep', 'sweep time', 1.2, 8, 0.2, fmtS],
    ['width', 'front width', 0.4, 2.5, 0.05, fmtX],
    ['power', 'strength', 0.2, 2, 0.05, fmtX],
  ];
  const save = () => localStorage.setItem('wl.ping', JSON.stringify(cfg));
  function build() {
    const host = $('#ping-tweaks');
    if (!host) return;
    for (const [key, label, min, max, step, fm] of SLIDERS) {
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `<label for="fp-${key}">${label}</label>
        <div class="qrow"><input type="range" id="fp-${key}" min="${min}" max="${max}" step="${step}" /><span class="qname" id="fpv-${key}"></span></div>`;
      host.appendChild(row);
      const r = row.querySelector('input'), val = row.querySelector('.qname');
      r.value = String(cfg[key]);
      val.textContent = fm(cfg[key]);
      r.addEventListener('input', () => {
        cfg[key] = parseFloat(r.value);
        val.textContent = fm(cfg[key]);
        save();
      });
    }
    const box = $('#p-on');
    if (box) {
      box.checked = cfg.on;
      box.addEventListener('change', () => { cfg.on = box.checked; save(); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  return { cfg };
})();
