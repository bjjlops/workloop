/* viz-mode.js — the view switcher and the 3D drawer controls.
   Views live in sibling stage sections (#repoviz / #repoviz3d / #repoviz-<id>);
   flipping body[data-viz] swaps which one shows and wakes/sleeps each module.
   The galaxies (RepoViz, Repo3D) register as built-ins at boot; the flat modes
   (pack/heartwood/metro/treemap, built on viz2d.js) self-register on load. The
   3D tweak sliders build themselves into #g3d-tweaks and push into Repo3D. */
const VizMode = (() => {
  const KEY = 'wl.viz', TWKEY = 'wl.g3d.tw';
  let mode = localStorage.getItem(KEY) || '3d';
  let booted = false;
  const VIEWS = []; // { id, mod, label, builtin }

  const fmt2 = (v) => String(Math.round(v * 100) / 100);
  const SLIDERS = [
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

  function register(id, mod, label, builtin = false) {
    if (VIEWS.some((v) => v.id === id)) return;
    VIEWS.push({ id, mod, label, builtin });
    if (booted) { addButton(id, label); if (id === mode) apply(mode, false); }
  }

  function addButton(id, label) {
    const seg = document.getElementById('viewseg');
    if (!seg || seg.querySelector(`[data-view="${id}"]`)) return;
    const b = document.createElement('button');
    b.dataset.view = id; b.id = 'view-' + id; b.textContent = label;
    b.setAttribute('role', 'tab'); b.title = label;
    b.classList.toggle('on', id === mode);
    b.addEventListener('click', () => apply(id));
    seg.appendChild(b);
  }
  function buildPicker() {
    const seg = document.getElementById('viewseg');
    if (!seg) return;
    seg.innerHTML = '';
    for (const v of VIEWS) addButton(v.id, v.label);
  }

  function apply(m, persist = true) {
    if (!VIEWS.some((v) => v.id === m)) m = VIEWS.some((v) => v.id === '3d') ? '3d' : (VIEWS[0] && VIEWS[0].id) || '2d';
    mode = m;
    document.body.dataset.viz = mode;
    const seg = document.getElementById('viewseg');
    seg?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === mode));
    const crumb = document.getElementById('hud-crumb'), pop = document.getElementById('viz-pop');
    if (crumb) crumb.hidden = true; // shared overlays: don't carry stale state across the switch
    if (pop) pop.hidden = true;
    for (const v of VIEWS) {
      const on = v.id === mode;
      if (v.mod.setVisible) v.mod.setVisible(on);
      if (on && v.mod.resize) requestAnimationFrame(() => v.mod.resize());
    }
    if (persist) localStorage.setItem(KEY, mode);
  }

  function loadTweaks() { try { return JSON.parse(localStorage.getItem(TWKEY) || '{}'); } catch { return {}; } }
  function buildControls() {
    const host = document.getElementById('g3d-tweaks');
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
    const seg = document.getElementById('layseg');
    if (seg) {
      const sync = () => {
        const cur2 = Repo3D.layout();
        seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.lay === cur2));
      };
      seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { Repo3D.setLayout(b.dataset.lay); sync(); }));
      sync();
    }
  }

  // Called from main.js after the galaxies are inited. Registers the built-ins,
  // builds the picker from the full registry (flat modes self-registered already),
  // inits the flat modes, and shows the persisted view.
  function boot() {
    if (typeof RepoViz !== 'undefined') register('2d', RepoViz, 'Galaxy', true);
    if (typeof Repo3D !== 'undefined') register('3d', Repo3D, '3D', true);
    const ORDER = ['2d', '3d', 'pack', 'tree', 'metro', 'treemap'];
    VIEWS.sort((a, b) => { const ai = ORDER.indexOf(a.id), bi = ORDER.indexOf(b.id); return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi); });
    booted = true;
    buildPicker();
    buildControls();
    for (const v of VIEWS) if (!v.builtin && v.mod.init) v.mod.init();
    apply(mode, false);
  }

  // deferred scripts: body exists — set the attribute before first paint
  document.body.dataset.viz = mode;

  return { register: (id, mod, label) => register(id, mod, label, false), boot, apply, mode: () => mode, views: () => VIEWS };
})();

/* Viz — one door for everything outside the views (nav, board, drawers).
   State ops fan out to ALL registered views so they stay in sync across switches;
   reads/navigation go to the ACTIVE view, falling back to any other that has data
   (all are built from the same /api/repotree payload). */
const Viz = (() => {
  const mods = () => VizMode.views().map((v) => v.mod).filter(Boolean);
  const active = () => {
    const id = document.body.dataset.viz;
    const hit = VizMode.views().find((v) => v.id === id);
    return (hit && hit.mod) || mods()[0] || null;
  };
  const each = (fn) => { for (const m of mods()) fn(m); };
  return {
    active,
    reload: () => each((v) => v.reload && v.reload()),
    retheme: (t) => each((v) => v.retheme && v.retheme(t)),
    setInsets: (n, a) => each((v) => v.setInsets && v.setInsets(n, a)),
    resize: () => each((v) => v.resize && v.resize()),
    allPaths: () => {
      const a = (active() && active().allPaths && active().allPaths()) || [];
      if (a.length) return a;
      for (const m of mods()) { const o = m.allPaths && m.allPaths(); if (o && o.length) return o; }
      return [];
    },
    langStats: () => {
      const a = (active() && active().langStats && active().langStats()) || {};
      if (Object.keys(a).length) return a;
      for (const m of mods()) { const o = m.langStats && m.langStats(); if (o && Object.keys(o).length) return o; }
      return {};
    },
    flyTo: (p) => !!(active() && active().flyTo && active().flyTo(p)),
    spotlight: (p) => each((v) => v.spotlight && v.spotlight(p)),
    setSelected: (p) => each((v) => v.setSelected && v.setSelected(p)),
    setExtFilter: (s) => each((v) => v.setExtFilter && v.setExtFilter(s)),
    setPathFilter: (p) => each((v) => v.setPathFilter && v.setPathFilter(p)),
    setTaskMarks: (l) => each((v) => v.setTaskMarks && v.setTaskMarks(l)),
    setPins: (s) => each((v) => v.setPins && v.setPins(s)),
    setDirty: (l) => each((v) => v.setDirty && v.setDirty(l)),
    runStarted: () => each((v) => v.runStarted && v.runStarted()),
    runEnded: (ok) => each((v) => v.runEnded && v.runEnded(ok)),
    fileActivity: (p, op) => each((v) => v.fileActivity && v.fileActivity(p, op)),
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

/* Trails — what the path-lighting MEANS, user-tunable from Appearance.
   hover/selected trails + the agent's read/edit/done stream colors.
   Both galaxies read Trails.cfg live; persists as one blob (wl.trails). */
const Trails = (() => {
  const DEF = { hover: '#3b82f6', selected: '#3b82f6', read: '#ff9f43', edit: '#ff4d4d', done: '#22c55e', holdMs: 2000 };
  const cfg = { ...DEF };
  try { Object.assign(cfg, JSON.parse(localStorage.getItem('wl.trails') || '{}')); } catch { /* fresh */ }
  const COLORS = [
    ['hover', 'hover trail'],
    ['selected', 'selected trail'],
    ['read', 'agent reading'],
    ['edit', 'agent editing'],
    ['done', 'finished flash'],
  ];
  const save = () => localStorage.setItem('wl.trails', JSON.stringify(cfg));
  const c3 = (key) => {
    const h = cfg[key] || DEF[key];
    return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  };
  function build() {
    const host = $('#trail-tweaks');
    if (!host) return;
    for (const [key, label] of COLORS) {
      const row = document.createElement('div');
      row.className = 'field';
      row.innerHTML = `<label for="ft-${key}">${label}</label>
        <div class="qrow"><input type="color" id="ft-${key}" /><span class="qname" id="ftv-${key}"></span></div>`;
      host.appendChild(row);
      const r = row.querySelector('input'), val = row.querySelector('.qname');
      r.value = cfg[key] || DEF[key];
      val.textContent = r.value;
      r.addEventListener('input', () => {
        cfg[key] = r.value;
        val.textContent = r.value;
        save();
      });
    }
    const row = document.createElement('div');
    row.className = 'field';
    row.innerHTML = `<label for="ft-hold">finished hold</label>
      <div class="qrow"><input type="range" id="ft-hold" min="500" max="5000" step="100" /><span class="qname" id="ftv-hold"></span></div>`;
    host.appendChild(row);
    const hr = row.querySelector('input'), hv = row.querySelector('.qname');
    hr.value = String(cfg.holdMs);
    hv.textContent = (cfg.holdMs / 1000).toFixed(1) + 's';
    hr.addEventListener('input', () => {
      cfg.holdMs = parseFloat(hr.value);
      hv.textContent = (cfg.holdMs / 1000).toFixed(1) + 's';
      save();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  return { cfg, c3 };
})();
