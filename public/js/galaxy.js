/* galaxy.js — repo map (galaxy view)
   A radial sector tree of the connected repo on two canvas layers:
   #viz-base = links/nodes/labels (redrawn on a dirty flag),
   #viz-fx   = glows/comets/particles (redrawn only while effects live).
   World units are fixed; the camera {x,y,k} does all fitting/zooming.

   Every color the canvas paints comes from the THEME table below — the theme
   engine swaps it wholesale via RepoViz.retheme(); geometry never changes. */
const RepoViz = (() => {
  const NODE_CAP = 2500, CHILD_CAP = 64, LABEL_CAP = 220, RING0 = 90, RING = 105, GRID = 64;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----- theme ----- */
  // Extension → palette-group map. The 15 group colors (one per --pal-* CSS
  // token) expand to the per-extension table the draw code reads.
  const EXT_GROUPS = {
    dir: ['dir'], ts: ['ts'], tsx: ['tsx'], js: ['js'], jsx: ['jsx'],
    script: ['mjs', 'cjs', 'sh', 'zsh', 'bash'], data: ['json'],
    style: ['css', 'scss', 'sass', 'less'], markup: ['html'],
    docs: ['md', 'mdx', 'txt'], sql: ['sql'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'],
    config: ['yml', 'yaml', 'toml', 'lock', 'env', 'plist', 'gradle', 'properties', 'config'],
    native: ['swift', 'kt', 'java', 'm', 'h', 'mm'],
    other: ['other'],
  };
  function expandPal(groups) {
    const pal = {};
    for (const [group, exts] of Object.entries(EXT_GROUPS)) for (const e of exts) pal[e] = groups[group];
    return pal;
  }
  const THEME = {
    pal: expandPal({
      dir: '#4fd1c5', ts: '#8ab4ff', tsx: '#5e8fe6', js: '#e6cf6f', jsx: '#cdb45c',
      script: '#3fb66e', data: '#e0a33e', style: '#c08bff', markup: '#e0614b',
      docs: '#8c95a3', sql: '#d678b6', image: '#5dbb8f', config: '#7d8aa0',
      native: '#d98a68', other: '#5c6470',
    }),
    heatStops: ['#ecb24c', '#c48642', '#786a58', '#4a5260', '#343b47'], // recent → old
    heatEmpty: '#3a4150',
    link: '#565f6e',
    accent: '#4fd1c5',
    changed: '#e0a33e', deleted: '#e0614b',
    success: '#3fb66e', successBright: '#7ee2a8',
    comet: '#e0a33e', cometHead: '#e8c069',
    labelDir: '#c7d2d0', labelFile: 'rgba(150,159,173,0.95)', labelHalo: 'rgba(20,23,28,0.85)',
    fxComposite: 'lighter', fxAlpha: 1, // light themes: 'source-over' at reduced alpha
    mono: 'ui-monospace,"SF Mono",Menlo,monospace',
    /* scenery tokens — handed to VizScenery on retheme() */
    neb1: '#5e8fe6', neb2: '#4fd1c5', neb3: '#2b3a6e', nebAlpha: 0.16,
    star1: '#cdd6e4', star2: '#7f8aa0', starDensity: 1,
    spike: '#dff7f4', spikeAlpha: 0.5, ring: '#4fd1c5', ringAlpha: 0.07,
    core: '#ffffff', shape: 'circle',
    wave: '#ff7a5c', // shockwave front — theme.js hands over the accent's complement
  };
  const sceneryQ = () => (typeof VizScenery !== 'undefined' ? VizScenery.q() : 0);
  const CONFIG_RE = /^(package(-lock)?\.json|app\.json|eas\.json|tsconfig[^/]*|babel\.config\.[^/]+|metro\.config\.[^/]+|\.[^/]*rc[^/]*|[^/]+\.config\.(js|ts|mjs|cjs))$/i;

  function buildHeat(stopsHex) { // 32-step ramp lerped between the 5 stops
    const stops = stopsHex.map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
    return Array.from({ length: 32 }, (_, i) => {
      const t = (i / 31) * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(t)), f = t - a;
      return '#' + stops[a].map((v, j) => Math.round(v + (stops[a + 1][j] - v) * f).toString(16).padStart(2, '0')).join('');
    });
  }
  let HEAT = buildHeat(THEME.heatStops);

  const withAlpha = (hex, a) =>
    `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  const ga = (a) => a * THEME.fxAlpha; // fx alpha scale — light themes paint softer

  const linkTints = new Map(); // (theme link + child color) -> tinted stroke, for the colored filaments
  function linkTint(col) {
    const key = THEME.link + col;
    let s = linkTints.get(key);
    if (s) return s;
    const mix = (i) => Math.round(parseInt(THEME.link.slice(i, i + 2), 16) * 0.58 + parseInt(col.slice(i, i + 2), 16) * 0.42);
    s = `rgba(${mix(1)},${mix(3)},${mix(5)},0.55)`;
    linkTints.set(key, s);
    return s;
  }

  let shell, baseC, fxC, bctx, fctx, tip, tickerEl, legendEl, W = 0, H = 0, dpr = 1;
  let tree = null, byPath = new Map(), stats = null, heatOn = localStorage.getItem('wl.heat') === '1', hasHeat = false;
  let loading = false, queued = false, firstLoad = true;
  let vis = [], visRoot = null, vByPath = new Map(), expanded = new Set(), grid = new Map();
  const cam = { x: 0, y: 0, k: 1 };
  let camAnim = null, fitK = 0.2, running = false, lastT = 0, lastFx = 0, dirtyBase = true;
  let introT0 = 0, layoutT0 = 0, autoXTimer = null;
  let hoverV = null, pinned = false, drag = null, userView = false;
  const pointers = new Map();
  let active = 0, pollTimer = null, lastHead = null;
  const snapshots = [], touched = new Set(), changedMap = new Map(), completed = new Set();
  let flickSet = null, flickT0 = 0;
  const sprites = new Map();
  const particles = [], comets = [], cometQueue = [], pendingComets = [], pulses = [];
  let spotPath = null, spotChain = null, extFilter = null, hoverCb = null, fileClickCb = null;
  let selPath = null, selChain = null; // node-menu selection — blue trail
  const activity = new Map(); // path -> { op: 'read'|'edit', t } — live agent tool attribution
  const TRAILS_DEF = { hover: '#3b82f6', selected: '#3b82f6', read: '#ff9f43', edit: '#ff4d4d', done: '#22c55e', holdMs: 2000 };
  const trailsCfg = () => (typeof Trails !== 'undefined' ? Trails.cfg : TRAILS_DEF);
  let menuCb = null, pathFilter = null, pathAnc = null, taskMarks = new Map(), pinSet = new Set();
  let dirtySet = new Set(); // uncommitted files — slow alert ring
  const waves = []; // light-bending shockwaves rippling out from dirty nodes
  let lastWaveCyc = -1;
  const PING_DEF = { on: true, every: 7, sweep: 3.6, width: 1, power: 1 };
  const pingCfg = () => (typeof Ping !== 'undefined' ? Ping.cfg : PING_DEF); // Appearance sliders

  const resolveV = (p) => { // folded files mark their nearest visible ancestor
    let n = byPath.get(p);
    while (n && !vByPath.has(n.path)) n = n.parent;
    return n ? vByPath.get(n.path) : null;
  };
  const streams = new Map(), brights = new Map(); // filePath -> work-stream; path keys survive relayouts
  const ST_MAX = 20, PKT_MAX = 24, DASH = [0, 0], NODASH = [];
  let geomGen = 0;
  let maxDepth = 1;

  /* ----- small helpers ----- */
  const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const fmtB = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B';
  const ago = (t) => { const d = Date.now() / 1000 - t;
    return d < 3600 ? Math.max(1, Math.floor(d / 60)) + 'm ago' : d < 86400 ? Math.floor(d / 3600) + 'h ago' : Math.floor(d / 86400) + 'd ago'; };
  const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const easeOB = (p) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
  const ringR = (d) => (d <= 0 ? 0 : RING0 + RING * (d - 1));
  const keyOfV = (v) => (v.isAgg ? v.host.path + '/*' : v.n.path);

  function sprite(color) { // soft radial glow, pre-rendered once per color
    let s = sprites.get(color);
    if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = 64;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, color + 'ff'); g.addColorStop(0.3, color + '66'); g.addColorStop(1, color + '00');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    sprites.set(color, s);
    return s;
  }

  function colorOf(v) {
    if (v.isAgg) return THEME.pal.dir;
    const n = v.n;
    if (heatOn) {
      const t = n.type === 'dir' ? n.maxT : n.t;
      if (!t) return THEME.heatEmpty;
      const age = (Date.now() / 1000 - t) / (90 * 86400);
      return HEAT[Math.min(31, Math.round(Math.sqrt(Math.max(0, Math.min(1, age))) * 31))];
    }
    if (n.type === 'dir') return THEME.pal.dir;
    if (CONFIG_RE.test(n.name)) return THEME.pal.config;
    return THEME.pal[n.ext] || THEME.pal.other;
  }

  /* ----- data: flat payload -> nested tree ----- */
  function buildTree(data) {
    const name = (data.repo || 'repo').split('/').filter(Boolean).pop() || 'repo';
    const root = { name, path: '', type: 'dir', kids: new Map() };
    const dirAt = (parts) => {
      let n = root;
      for (const part of parts) {
        let c = n.kids.get(part);
        if (!c) { c = { name: part, path: n.path ? n.path + '/' + part : part, type: 'dir', kids: new Map() }; n.kids.set(part, c); }
        n = c;
      }
      return n;
    };
    for (const f of data.files || []) {
      const parts = f.p.split('/'), base = parts.pop();
      dirAt(parts).kids.set(base, { name: base, path: f.p, type: 'file', size: f.s, t: f.t || 0, ext: extOf(base) });
    }
    for (const d of data.dirs || []) { // server-aggregated overflow on truncated repos
      const dir = d.p === '.' ? root : dirAt(d.p.split('/'));
      dir.aggN = (dir.aggN || 0) + d.n;
      dir.aggS = (dir.aggS || 0) + d.s;
    }
    return root;
  }

  function annotate(n, parent, depth) {
    n.parent = parent; n.depth = depth;
    byPath.set(n.path, n);
    if (n.type === 'file') { n.leaf = 1; n.total = n.size; n.maxT = n.t || 0; return; }
    n.children = [...n.kids.values()].sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
    n.kids = null;
    let leaf = 0, total = 0, maxT = 0;
    for (const c of n.children) { annotate(c, n, depth + 1); leaf += c.leaf; total += c.total; maxT = Math.max(maxT, c.maxT); }
    if (n.aggN) { leaf += n.aggN; total += n.aggS || 0; }
    n.leaf = Math.max(1, leaf); n.total = total; n.maxT = maxT; n.size = total;
  }

  /* ----- LOD: which dirs are open ----- */
  const visChildCount = (d) => Math.min(d.children.length, CHILD_CAP) + (d.children.length > CHILD_CAP || d.aggN ? 1 : 0);

  function defaultExpansion() { // greedily open the biggest dirs until the node budget is spent
    expanded = new Set([tree]);
    let count = 1 + visChildCount(tree);
    const cand = (tree.children || []).filter((c) => c.type === 'dir');
    while (cand.length) {
      let bi = 0;
      for (let i = 1; i < cand.length; i++) if (cand[i].leaf > cand[bi].leaf) bi = i;
      const d = cand.splice(bi, 1)[0];
      if (!d.children.length) continue;
      if (count + visChildCount(d) > NODE_CAP) continue;
      expanded.add(d);
      count += visChildCount(d);
      for (const c of d.children) if (c.type === 'dir') cand.push(c);
    }
  }

  function evictFor(target) { // keep the budget when a click opens one more dir
    let count = vis.length;
    if (count <= NODE_CAP) return;
    const protect = new Set();
    for (let u = target; u; u = u.parent) protect.add(u);
    const ev = [...expanded].filter((d) => d !== tree && !protect.has(d)).sort((a, b) => b.depth - a.depth);
    while (count > NODE_CAP && ev.length) {
      const d = ev.shift();
      expanded.delete(d);
      count -= visChildCount(d);
    }
  }

  /* ----- scene graph ----- */
  function radiusOf(v) {
    if (v.isAgg) return Math.min(15, 5 + Math.log2(1 + v.aggCount));
    if (v.n.type === 'dir') return Math.min(15, 4.5 + Math.log2(1 + v.n.leaf));
    return Math.min(9, 2 + 1.15 * Math.log2(1 + v.n.size / 1024));
  }

  function buildVis() {
    vis = []; vByPath = new Map();
    const mk = (n, parentV, agg) => {
      const v = {
        n, parentV, kids: [], isAgg: !!agg, aggCount: agg ? agg.n : 0, aggSize: agg ? agg.s : 0, host: agg ? agg.host : null,
        depth: parentV ? parentV.depth + 1 : 0,
        a0: 0, a1: 0, angle: 0, tx: 0, ty: 0, x: 0, y: 0, sx: 0, sy: 0, r: 0, grow: 1, delay: 0, isNew: false,
      };
      v.r = radiusOf(v);
      vis.push(v);
      if (n) vByPath.set(n.path, v);
      if (parentV) parentV.kids.push(v);
      return v;
    };
    const rec = (n, parentV) => {
      const v = mk(n, parentV, null);
      if (n.type !== 'dir' || !expanded.has(n)) return v;
      let cs = n.children, extraN = n.aggN || 0, extraS = n.aggS || 0;
      if (cs.length > CHILD_CAP) { // fold the long tail of a huge dir into one "+N" hub
        const keep = new Set([...cs].sort((a, b) => b.total - a.total).slice(0, CHILD_CAP - 1));
        cs = n.children.filter((c) => keep.has(c));
        for (const c of n.children) if (!keep.has(c)) { extraN += c.leaf; extraS += c.total; }
      }
      for (const c of cs) rec(c, v);
      if (extraN) mk(null, v, { n: extraN, s: extraS, host: n });
      return v;
    };
    visRoot = rec(tree, null);
  }

  /* ----- radial sector layout ----- */
  const weight = (v) => (v.isAgg ? Math.max(1, Math.sqrt(v.aggCount)) : v.n.type === 'dir' ? Math.max(1, v.n.leaf) : 1);

  function assignSectors(v, a0, a1) {
    v.a0 = a0; v.a1 = a1; v.angle = (a0 + a1) / 2;
    const R = ringR(v.depth);
    v.tx = R * Math.cos(v.angle); v.ty = R * Math.sin(v.angle);
    if (!v.kids.length) return;
    let Wt = 0;
    for (const k of v.kids) Wt += weight(k);
    let a = a0;
    for (const k of v.kids) {
      const span = (a1 - a0) * (weight(k) / Wt);
      assignSectors(k, a, a + span);
      a += span;
    }
  }

  function fanPass() { // leaves squeezed below their own diameter fan onto two sub-rings
    for (const v of vis) {
      v.kids.forEach((k, i) => {
        if (k.kids.length) return;
        const R = ringR(k.depth);
        if ((k.a1 - k.a0) * R < 2 * k.r + 2) {
          const rr = R + (i % 2 ? 13 : -13);
          k.tx = rr * Math.cos(k.angle); k.ty = rr * Math.sin(k.angle);
        }
      });
    }
  }

  function buildGrid() {
    grid = new Map();
    for (const v of vis) {
      const key = Math.floor(v.tx / GRID) + ',' + Math.floor(v.ty / GRID);
      let a = grid.get(key);
      if (!a) grid.set(key, (a = []));
      a.push(v);
    }
  }

  function relayout(opts = {}) {
    const prev = new Map();
    for (const v of vis) prev.set(keyOfV(v), [v.x, v.y]);
    buildVis();
    assignSectors(visRoot, -Math.PI / 2, Math.PI * 1.5);
    fanPass();
    buildGrid();
    maxDepth = 1;
    for (const v of vis) if (v.depth > maxDepth) maxDepth = v.depth;
    geomGen++;
    if (streams.size || changedMap.size) rebuildStreams(); // re-resolve chains against fresh vByPath
    if (spotPath) spotChain = chainOf(spotPath);           // spotlight survives relayouts too
    if (selPath) selChain = chainOf(selPath);              // selection trail too
    const now = performance.now();
    if (opts.intro && !REDUCED) {
      introT0 = now;
      vis.forEach((v, i) => {
        v.delay = v.depth * 90 + (i % 7) * 18;
        v.grow = 0;
        v.x = v.parentV ? v.parentV.tx : 0;
        v.y = v.parentV ? v.parentV.ty : 0;
      });
    } else if (opts.tween && !REDUCED && !firstLoad) {
      layoutT0 = now;
      for (const v of vis) {
        const p = prev.get(keyOfV(v));
        v.isNew = !p;
        v.sx = p ? p[0] : v.parentV ? v.parentV.tx : 0;
        v.sy = p ? p[1] : v.parentV ? v.parentV.ty : 0;
        v.x = v.sx; v.y = v.sy;
        v.grow = v.isNew ? 0 : 1;
      }
    } else {
      for (const v of vis) { v.x = v.tx; v.y = v.ty; v.grow = 1; }
    }
    for (const p of pendingComets.splice(0)) { const v = vByPath.get(p); if (v) spawnComet(v); }
    dirtyBase = true;
    wake();
  }

  /* ----- camera ----- */
  const screenOf = (wx, wy) => [(wx - cam.x) * cam.k + W / 2, (wy - cam.y) * cam.k + H / 2];
  const worldOf = (sx, sy) => [(sx - W / 2) / cam.k + cam.x, (sy - H / 2) / cam.k + cam.y];
  const setWorld = (ctx) => ctx.setTransform(cam.k * dpr, 0, 0, cam.k * dpr, (W / 2 - cam.x * cam.k) * dpr, (H / 2 - cam.y * cam.k) * dpr);

  function subtreeBounds(v) {
    let x0 = v.tx, x1 = v.tx, y0 = v.ty, y1 = v.ty;
    const rec = (u) => {
      x0 = Math.min(x0, u.tx - u.r); x1 = Math.max(x1, u.tx + u.r);
      y0 = Math.min(y0, u.ty - u.r); y1 = Math.max(y1, u.ty + u.r);
      u.kids.forEach(rec);
    };
    rec(v);
    return { x0, x1, y0, y1 };
  }

  // drawers overlay the stage — fits aim at the rect they leave visible
  let insets = { left: 0, right: 0, top: 0, bottom: 0 };

  function fitParams(v) {
    const b = subtreeBounds(v);
    const availW = Math.max(120, W - insets.left - insets.right);
    const availH = Math.max(120, H - insets.top - insets.bottom);
    const k = Math.min(2.4, Math.min(availW / Math.max(60, b.x1 - b.x0 + 90), availH / Math.max(60, b.y1 - b.y0 + 90)));
    // world center such that the bounds center lands on the visible rect's center
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return {
      x: cx - (insets.left + availW / 2 - W / 2) / k,
      y: cy - (insets.top + availH / 2 - H / 2) / k,
      k,
    };
  }

  function setInsets(next, animate = true) {
    const n = { ...insets, ...next };
    if (n.left === insets.left && n.right === insets.right && n.top === insets.top && n.bottom === insets.bottom) return;
    insets = n;
    if (!visRoot || introT0) return;
    if (userView) return; // never fight a framing the user chose
    if (animate && !REDUCED) zoomToFitV(visRoot, 300);
    else {
      const f = fitParams(visRoot);
      fitK = f.k;
      cam.x = f.x; cam.y = f.y; cam.k = f.k;
      camAnim = null;
      dirtyBase = true;
      wake();
    }
  }

  function zoomToFitV(v, ms = 500) {
    if (!visRoot) return;
    v = v || visRoot;
    const f = fitParams(v);
    if (v === visRoot) fitK = f.k;
    animateCam(f.x, f.y, f.k, ms);
  }

  function animateCam(x, y, k, ms) {
    if (REDUCED) ms = Math.min(ms, 120);
    if (ms <= 0) { cam.x = x; cam.y = y; cam.k = k; dirtyBase = true; wake(); return; }
    camAnim = { x0: cam.x, y0: cam.y, l0: Math.log(cam.k), x1: x, y1: y, l1: Math.log(k), t0: performance.now(), dur: ms };
    wake();
  }

  function zoomAt(sx, sy, f) { // zoom anchored at the cursor
    userView = true;
    const k2 = Math.max(fitK * 0.4, Math.min(40, cam.k * f));
    const [wx, wy] = worldOf(sx, sy);
    cam.x = wx - (sx - W / 2) / k2;
    cam.y = wy - (sy - H / 2) / k2;
    cam.k = k2;
    dirtyBase = true;
    wake();
    scheduleAutoExpand();
  }

  function scheduleAutoExpand() {
    clearTimeout(autoXTimer);
    autoXTimer = setTimeout(autoExpand, 200);
  }

  function autoExpand() { // zooming in opens collapsed dirs once their sector has room
    if (!tree) return;
    let count = vis.length, added = false;
    for (const v of vis) {
      if (v.isAgg || v.n.type !== 'dir' || expanded.has(v.n) || !v.n.children || !v.n.children.length) continue;
      const [sx, sy] = screenOf(v.tx, v.ty);
      if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
      const cn = Math.min(v.n.children.length, CHILD_CAP);
      if (((v.a1 - v.a0) * ringR(v.depth + 1) * cam.k) / cn < 9) continue;
      if (count + cn > NODE_CAP) continue;
      expanded.add(v.n);
      count += cn;
      added = true;
    }
    if (added) relayout({ tween: true });
  }

  /* ----- hit testing / tooltip ----- */
  function pick(sx, sy) {
    if (!visRoot) return null;
    const [wx, wy] = worldOf(sx, sy);
    const cx = Math.floor(wx / GRID), cy = Math.floor(wy / GRID);
    let best = null, bd = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const cell = grid.get((cx + i) + ',' + (cy + j));
        if (!cell) continue;
        for (const v of cell) {
          const d = Math.hypot(wx - v.tx, wy - v.ty);
          if (d <= v.r + 8 / cam.k && d < bd) { bd = d; best = v; }
        }
      }
    }
    return best;
  }

  function tipHTML(v) {
    if (v.isAgg)
      return `<div>${esc(v.host.path || v.host.name)}/</div><div class="dim">+${v.aggCount.toLocaleString()} more files · ${fmtB(v.aggSize)}</div>`;
    const n = v.n;
    if (n.type === 'dir')
      return `<div>${esc(n.path || n.name)}/</div><div class="dim">${n.leaf.toLocaleString()} files · ${fmtB(n.total)}${expanded.has(n) || !n.children.length ? '' : ' · click to open'}</div>`;
    const mark = changedMap.has(n.path) ? ' · ✎ changing' : completed.has(n.path) ? ' · ✓ updated' : '';
    return `<div>${esc(n.path)}</div><div class="dim">${fmtB(n.size)}${n.ext ? ' · ' + esc(n.ext) : ''}${n.t ? ' · ' + ago(n.t) : ''}${mark}</div>`;
  }

  function showTip(v, x, y) {
    tip.innerHTML = tipHTML(v);
    tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(x + 14, W - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(4, Math.min(y + 14, H - tip.offsetHeight - 8)) + 'px';
  }
  const hideTip = () => { tip.hidden = true; };

  /* ----- node context info (feeds the nav.js menu) ----- */
  function topExts(n) { // top-3 extension counts under a dir, walk budgeted for huge trees
    const c = new Map();
    let budget = 3000;
    const rec = (d) => {
      for (const k of d.children || []) {
        if (budget-- <= 0) return;
        if (k.type === 'dir') rec(k);
        else { const e = k.ext || 'other'; c.set(e, (c.get(e) || 0) + 1); }
      }
    };
    rec(n);
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }
  function nodeInfo(v) {
    if (v.isAgg) {
      const h = v.host;
      return { path: h.path, name: h.name, isDir: true, isAgg: true, aggCount: v.aggCount, leaf: h.leaf, bytes: h.total, t: h.maxT || 0, topExts: topExts(h) };
    }
    const n = v.n;
    if (n.type === 'dir') return { path: n.path, name: n.name, isDir: true, leaf: n.leaf, bytes: n.total, t: n.maxT || 0, topExts: topExts(n) };
    return { path: n.path, name: n.name, isDir: false, size: n.size, ext: n.ext, t: n.t || 0 };
  }

  /* ----- dimming: ext filter + focused subtree share one predicate ----- */
  const pfKeep = (p) => p === pathFilter || p.startsWith(pathFilter + '/') || pathAnc.has(p);
  function dimOf(v) {
    if (extFilter && !v.isAgg && v.n.type !== 'dir' && !extFilter.has(v.n.ext)) return true;
    if (pathFilter) { // focus: keep the subtree + its ancestor chain, dim the rest
      if (v.isAgg) { const h = v.host.path; if (h !== pathFilter && !h.startsWith(pathFilter + '/')) return true; }
      else if (!pfKeep(v.n.path)) return true;
    }
    return false;
  }

  /* ----- drawing: base layer ----- */
  function linkPath(ctx, p, c) { // organic curl along the radial direction
    if (p.depth === 0) {
      const r = RING0 * 0.45;
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo(r * Math.cos(c.angle), r * Math.sin(c.angle), c.x, c.y);
      return;
    }
    const Rp = Math.hypot(p.x, p.y), Rc = Math.hypot(c.x, c.y), m = 0.42;
    const R1 = Rp + m * (Rc - Rp), R2 = Rc - m * (Rc - Rp);
    ctx.moveTo(p.x, p.y);
    ctx.bezierCurveTo(R1 * Math.cos(p.angle), R1 * Math.sin(p.angle), R2 * Math.cos(c.angle), R2 * Math.sin(c.angle), c.x, c.y);
  }

  function drawBase() {
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, W, H);
    if (!visRoot) return;
    VizScenery.drawBack(bctx, cam, W, H); // parallax starfield + nebula gas (screen space)
    setWorld(bctx);
    VizScenery.drawOrbits(bctx, cam, RING0, RING, maxDepth, W, H);
    VizScenery.drawCore(bctx, colorOf(visRoot));
    const mw = W / 2 / cam.k + 30, mh = H / 2 / cam.k + 30;
    const inView = (v) => Math.abs(v.x - cam.x) < mw && Math.abs(v.y - cam.y) < mh;

    bctx.lineWidth = 1 / cam.k;
    if (sceneryQ() >= 2) { // settled links tinted toward the child's color — colored filaments
      const linkGroups = new Map(); // dimmed children stroke in their own faint batch
      for (const v of vis) {
        if (!v.parentV || v.grow < 1) continue;
        if (!inView(v) && !inView(v.parentV)) continue;
        const col = colorOf(v);
        const key = (dimOf(v) ? 'd' : 'n') + col;
        let g = linkGroups.get(key);
        if (!g) linkGroups.set(key, (g = { col, dim: dimOf(v), arr: [] }));
        g.arr.push(v);
      }
      for (const g of linkGroups.values()) {
        bctx.strokeStyle = linkTint(g.col);
        bctx.globalAlpha = g.dim ? 0.15 : 1;
        bctx.beginPath();
        for (const v of g.arr) linkPath(bctx, v.parentV, v);
        bctx.stroke();
      }
      bctx.globalAlpha = 1;
    } else {
      bctx.strokeStyle = withAlpha(THEME.link, 0.5);
      for (const dimPass of [false, true]) {
        bctx.globalAlpha = dimPass ? 0.15 : 1;
        bctx.beginPath();
        let any = false;
        for (const v of vis) { // settled links: one batched stroke per dim state
          if (!v.parentV || v.grow < 1) continue;
          if (!inView(v) && !inView(v.parentV)) continue;
          if (dimOf(v) !== dimPass) continue;
          linkPath(bctx, v.parentV, v);
          any = true;
        }
        if (any) bctx.stroke();
      }
      bctx.globalAlpha = 1;
    }
    bctx.strokeStyle = withAlpha(THEME.link, 0.5);
    for (const v of vis) { // growing links fade in individually
      if (!v.parentV || v.grow >= 1 || v.grow <= 0) continue;
      bctx.globalAlpha = Math.min(1, v.grow) * (dimOf(v) ? 0.15 : 1);
      bctx.beginPath();
      linkPath(bctx, v.parentV, v);
      bctx.stroke();
    }
    bctx.globalAlpha = 1;

    if (hoverV && (REDUCED || sceneryQ() === 0)) { // static fallback — the animated trail lives on the fx layer
      bctx.strokeStyle = withAlpha(trailsCfg().hover, 0.85);
      bctx.lineWidth = 1.6 / cam.k;
      bctx.beginPath();
      for (let v = hoverV; v.parentV; v = v.parentV) linkPath(bctx, v.parentV, v);
      bctx.stroke();
    }
    if (selChain && selChain.length > 1 && (REDUCED || sceneryQ() === 0)) { // selection fallback
      bctx.strokeStyle = withAlpha(trailsCfg().selected, 0.9);
      bctx.lineWidth = 1.8 / cam.k;
      bctx.beginPath();
      for (let i = 1; i < selChain.length; i++) linkPath(bctx, selChain[i - 1], selChain[i]);
      bctx.stroke();
    }

    if (spotChain && spotChain.length > 1) { // run-target spotlight from a hovered task card
      bctx.strokeStyle = THEME.changed;
      bctx.lineWidth = 1.8 / cam.k;
      bctx.globalAlpha = 0.8;
      bctx.beginPath();
      for (let i = 1; i < spotChain.length; i++) linkPath(bctx, spotChain[i - 1], spotChain[i]);
      bctx.stroke();
      bctx.globalAlpha = 1;
      const end = spotChain[spotChain.length - 1];
      bctx.beginPath();
      bctx.arc(end.x, end.y, end.r + 4 / cam.k, 0, 6.2832);
      bctx.stroke();
    }

    for (const v of vis) { // directory hub glow
      if (!inView(v) || (!v.isAgg && v.n.type !== 'dir') || dimOf(v)) continue;
      const s = v.r * 3.1 * Math.max(0, Math.min(1, v.grow));
      if (s <= 0) continue;
      const hubCol = colorOf(v);
      VizScenery.clusterGas(bctx, v, hubCol); // soft gas pocket behind the whole cluster
      bctx.globalAlpha = 0.15;
      bctx.drawImage(sprite(hubCol), v.x - s, v.y - s, s * 2, s * 2);
    }
    bctx.globalAlpha = 1;

    if (sceneryQ() >= 3) { // Ultra: big files get faint halos too — the whole map breathes
      bctx.globalAlpha = 0.09;
      for (const v of vis) {
        if (!inView(v) || v.isAgg || v.n.type !== 'file' || v.grow < 1 || dimOf(v)) continue;
        if (v.r * cam.k < 4) continue;
        const s = v.r * 2.6;
        bctx.drawImage(sprite(colorOf(v)), v.x - s, v.y - s, s * 2, s * 2);
      }
      bctx.globalAlpha = 1;
    }

    const groups = new Map(); // nodes batched per fill color (dimmed nodes batch separately)
    for (const v of vis) {
      if (!inView(v) || v.grow <= 0) continue;
      const ch = v.isAgg ? null : changedMap.get(v.n.path);
      const col = ch ? (ch.kind === 'deleted' ? THEME.deleted : THEME.changed) : colorOf(v);
      const dim = dimOf(v);
      const key = (dim ? 'd' : 'n') + col;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { col, dim, arr: [] }));
      g.arr.push(v);
    }
    const shape = sceneryQ() >= 2 ? VizScenery.shape() : 'circle';
    const shaped = (v, r) => shape !== 'circle' && !v.isAgg && v.n.type === 'file' && r * cam.k > 3.4;
    for (const g of groups.values()) {
      bctx.fillStyle = g.col;
      bctx.globalAlpha = g.dim ? 0.12 : 1;
      bctx.beginPath();
      for (const v of g.arr) {
        const r = v.r * Math.min(1.25, Math.max(0, v.grow));
        if (!g.dim && shaped(v, r)) continue; // drawn as a themed sprite below
        bctx.moveTo(v.x + r, v.y);
        bctx.arc(v.x, v.y, r, 0, 6.2832);
      }
      bctx.fill();
      if (!g.dim && shape !== 'circle') { // themed node shapes: flakes, glyphs, gems, petals…
        for (const v of g.arr) {
          const r = v.r * Math.min(1.25, Math.max(0, v.grow));
          if (!shaped(v, r)) continue;
          const s = r * 1.5;
          bctx.drawImage(VizScenery.nodeSprite(shape, g.col, v.n.path.length), v.x - s, v.y - s, s * 2, s * 2);
        }
      }
    }
    bctx.globalAlpha = 1;

    if (sceneryQ() >= 2) { // white-hot cores — round nodes read as stars, not dots
      bctx.fillStyle = THEME.core;
      bctx.globalAlpha = 0.55;
      bctx.beginPath();
      for (const v of vis) {
        if (!inView(v) || v.grow <= 0 || dimOf(v)) continue;
        const r = v.r * Math.min(1.25, Math.max(0, v.grow));
        if (r * cam.k < 4.5 || shaped(v, r)) continue;
        const cr = r * 0.32;
        bctx.moveTo(v.x + cr, v.y);
        bctx.arc(v.x, v.y, cr, 0, 6.2832);
      }
      bctx.fill();
      bctx.globalAlpha = 1;
    }

    if (sceneryQ() >= 1) { // diffraction spikes on the big bodies
      const dirOnly = sceneryQ() < 3;
      for (const v of vis) {
        if (!inView(v) || v.grow < 0.9 || dimOf(v)) continue;
        const isDir = v.isAgg || v.n.type === 'dir';
        if (dirOnly && !isDir) continue;
        if (v.r * cam.k < (isDir ? 7 : 8.5)) continue;
        VizScenery.drawSpike(bctx, v, colorOf(v));
      }
    }

    bctx.setLineDash([3 / cam.k, 3 / cam.k]); // "+N files" hubs get a dashed ring
    bctx.strokeStyle = withAlpha(THEME.accent, 0.7);
    bctx.lineWidth = 1 / cam.k;
    for (const v of vis) {
      if (!v.isAgg || !inView(v)) continue;
      bctx.beginPath();
      bctx.arc(v.x, v.y, v.r + 2.5, 0, 6.2832);
      bctx.stroke();
    }
    bctx.setLineDash([]);

    if (completed.size) { // green ring = a run updated this file
      bctx.strokeStyle = THEME.success;
      bctx.lineWidth = 1.4 / cam.k;
      bctx.beginPath();
      for (const p of completed) {
        const v = vByPath.get(p);
        if (!v || !inView(v)) continue;
        bctx.moveTo(v.x + v.r + 2.4, v.y);
        bctx.arc(v.x, v.y, v.r + 2.4, 0, 6.2832);
      }
      bctx.stroke();
    }
    if (dirtySet.size && (REDUCED || sceneryQ() === 0)) {
      // the fx heartbeat is off in these modes — a steady ring stands in for the pulse
      bctx.strokeStyle = THEME.changed;
      bctx.lineWidth = 2 / cam.k;
      bctx.globalAlpha = 0.65;
      bctx.beginPath();
      let dn = 0;
      for (const p of dirtySet) {
        if (dn++ >= 60) break;
        const v = resolveV(p);
        if (!v || !inView(v)) continue;
        const r = v.r + 6 / cam.k;
        bctx.moveTo(v.x + r, v.y);
        bctx.arc(v.x, v.y, r, 0, 6.2832);
      }
      bctx.stroke();
      bctx.globalAlpha = 1;
    }
    if (taskMarks.size) { // warn corner dot = the board has open tasks here
      bctx.fillStyle = THEME.changed;
      bctx.beginPath();
      for (const p of taskMarks.keys()) {
        const v = resolveV(p);
        if (!v || !inView(v)) continue;
        const r = Math.max(2.2 / cam.k, v.r * 0.3), ox = v.r * 0.8 + r;
        bctx.moveTo(v.x + ox + r, v.y - ox);
        bctx.arc(v.x + ox, v.y - ox, r, 0, 6.2832);
      }
      bctx.fill();
    }
    if (pinSet.size) { // accent dot above the node = pinned
      bctx.fillStyle = THEME.accent;
      bctx.beginPath();
      for (const p of pinSet) {
        const v = resolveV(p);
        if (!v || !inView(v)) continue;
        const r = Math.max(2 / cam.k, v.r * 0.25), oy = v.r + 3 / cam.k + r;
        bctx.moveTo(v.x + r, v.y - oy);
        bctx.arc(v.x, v.y - oy, r, 0, 6.2832);
      }
      bctx.fill();
    }
    if (hoverV) {
      bctx.strokeStyle = THEME.accent;
      bctx.lineWidth = 1.6 / cam.k;
      bctx.beginPath();
      bctx.arc(hoverV.x, hoverV.y, hoverV.r + 3 / cam.k, 0, 6.2832);
      bctx.stroke();
      bctx.globalAlpha = 0.3; // soft outer aura
      bctx.lineWidth = 4.5 / cam.k;
      bctx.beginPath();
      bctx.arc(hoverV.x, hoverV.y, hoverV.r + 7 / cam.k, 0, 6.2832);
      bctx.stroke();
      bctx.globalAlpha = 1;
    }

    bctx.setTransform(dpr, 0, 0, dpr, 0, 0); // labels stay pixel-crisp in screen space
    const cands = [];
    for (const v of vis) {
      if (!inView(v) || v.grow < 0.95) continue;
      if (dimOf(v)) continue; // filtered-out files keep their dots, lose their labels
      const isDir = v.isAgg || v.n.type === 'dir';
      const sr = v.r * cam.k;
      if (sr < (isDir ? 5 : 4)) continue;
      cands.push([isDir ? sr + 1000 : sr, v, isDir]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    bctx.textBaseline = 'middle';
    const placed = []; // greedy overlap rejection, highest-priority labels win
    let shown = 0;
    for (const [, v, isDir] of cands) {
      if (shown >= LABEL_CAP) break;
      const [sx, sy] = screenOf(v.x, v.y);
      const label = v.isAgg ? '+' + v.aggCount.toLocaleString() : v.n.name + (isDir ? '/' : '');
      bctx.font = (isDir ? '600 11px ' : '10px ') + THEME.mono;
      const lx = sx + v.r * cam.k + 5;
      const lw = bctx.measureText(label).width;
      const box = [lx - 2, sy - 7, lx + lw + 2, sy + 7];
      let hit = false;
      for (const b of placed) {
        if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) { hit = true; break; }
      }
      if (hit) continue;
      placed.push(box);
      shown++;
      bctx.lineWidth = 3;
      bctx.strokeStyle = THEME.labelHalo;
      bctx.strokeText(label, lx, sy);
      bctx.fillStyle = isDir ? THEME.labelDir : THEME.labelFile;
      bctx.fillText(label, lx, sy);
    }
  }

  /* ----- drawing: fx layer ----- */
  function sampleLink(p, c, out) { // polyline along the same curve linkPath draws
    const start = out.length ? 1 : 0;
    if (p.depth === 0) {
      const r = RING0 * 0.45, qx = r * Math.cos(c.angle), qy = r * Math.sin(c.angle);
      for (let i = start; i <= 12; i++) {
        const t = i / 12, u = 1 - t;
        out.push([u * u * p.tx + 2 * u * t * qx + t * t * c.tx, u * u * p.ty + 2 * u * t * qy + t * t * c.ty]);
      }
      return;
    }
    const Rp = Math.hypot(p.tx, p.ty), Rc = Math.hypot(c.tx, c.ty), m = 0.42;
    const R1 = Rp + m * (Rc - Rp), R2 = Rc - m * (Rc - Rp);
    const c1x = R1 * Math.cos(p.angle), c1y = R1 * Math.sin(p.angle);
    const c2x = R2 * Math.cos(c.angle), c2y = R2 * Math.sin(c.angle);
    for (let i = start; i <= 12; i++) {
      const t = i / 12, u = 1 - t;
      out.push([
        u * u * u * p.tx + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * c.tx,
        u * u * u * p.ty + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * c.ty,
      ]);
    }
  }

  /* ----- flowing work-streams: liquid light along every path an agent is editing ----- */
  const hashPhase = (p) => { let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0; return (h % 997) / 997; };

  function bright(hex) { // color pushed 55% toward white, for dash cores and packets
    let b = brights.get(hex);
    if (b) return b;
    b = '#' + [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16);
      return Math.round(c + (255 - c) * 0.55).toString(16).padStart(2, '0');
    }).join('');
    brights.set(hex, b);
    return b;
  }

  function chainOf(path) {
    let n = byPath.get(path);
    while (n && !vByPath.has(n.path)) n = n.parent; // folded leaf -> deepest visible ancestor
    const v = n && vByPath.get(n.path);
    if (!v) return null;
    const chain = [];
    for (let u = v; u; u = u.parentV) chain.unshift(u);
    return chain.length > 1 ? chain : null;
  }

  function traceChain(g, c, live) { // same curves as linkPath, one continuous subpath root->leaf
    const X = (v) => (live ? v.x : v.tx), Y = (v) => (live ? v.y : v.ty);
    g.moveTo(X(c[0]), Y(c[0]));
    for (let i = 1; i < c.length; i++) {
      const p = c[i - 1], k = c[i];
      if (p.depth === 0) {
        const r = RING0 * 0.45;
        g.quadraticCurveTo(r * Math.cos(k.angle), r * Math.sin(k.angle), X(k), Y(k));
      } else {
        const Rp = Math.hypot(X(p), Y(p)), Rc = Math.hypot(X(k), Y(k)), m = 0.42;
        const R1 = Rp + m * (Rc - Rp), R2 = Rc - m * (Rc - Rp);
        g.bezierCurveTo(R1 * Math.cos(p.angle), R1 * Math.sin(p.angle), R2 * Math.cos(k.angle), R2 * Math.sin(k.angle), X(k), Y(k));
      }
    }
  }

  function streamGeom(s) {
    s.p2d = new Path2D();
    traceChain(s.p2d, s.chain, false);
    s.pts = [];
    for (let i = 1; i < s.chain.length; i++) sampleLink(s.chain[i - 1], s.chain[i], s.pts);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const [x, y] of s.pts) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    s.b = [x0 - 10, y0 - 10, x1 + 10, y1 + 10];
    s.gen = geomGen;
  }

  function rebuildStreams() { // on changedMap/activity mutation / relayout — never per frame
    const T = trailsCfg();
    const cand = new Map(); // path -> sort time; git-detected changes ∪ live tool activity
    for (const [path, info] of changedMap) cand.set(path, info.t0);
    for (const [path, a] of activity) cand.set(path, Math.max(cand.get(path) || 0, a.t));
    const alive = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, ST_MAX);
    const keep = new Set();
    for (const [path] of alive) {
      keep.add(path);
      let s = streams.get(path);
      if (!s) streams.set(path, (s = { a: 0, phase: hashPhase(path), flash: 0 }));
      s.on = true;
      const info = changedMap.get(path);
      // meaning over identity: read = orange, edit = red (deleted keeps its own tone)
      const op = activity.get(path)?.op || 'edit';
      s.color = info?.kind === 'deleted' ? THEME.deleted : (T[op] || T.edit);
      s.bcol = bright(s.color);
      s.chain = chainOf(path);
      s.gen = -1; // geometry rebuilds lazily in drawStreams
    }
    for (const [path, s] of streams) if (!keep.has(path)) s.on = false; // 600ms fade-out
  }

  function fileActivity(path, op) { // live attribution from the runner's tool events
    if (!bctx || !path) return;
    const prev = activity.get(path);
    // an edit outranks a read; a later read does NOT demote an edited file
    const next = prev?.op === 'edit' ? 'edit' : (op === 'edit' ? 'edit' : 'read');
    activity.set(path, { op: next, t: performance.now() });
    rebuildStreams();
    wake();
  }

  function strokeStream(s, tweening) {
    if (!tweening && s.p2d) { fctx.stroke(s.p2d); return; }
    fctx.beginPath();
    traceChain(fctx, s.chain, true);
    fctx.stroke();
  }

  function strokeChainFx(chain, colorHex, alpha, now, phase, endRing) {
    // the work-stream recipe (halo + fiber + marching dash), for hover/selection
    const trace = () => { fctx.beginPath(); traceChain(fctx, chain, true); fctx.stroke(); };
    const ph = phase * 6.2832;
    fctx.lineCap = 'round';
    fctx.strokeStyle = colorHex;
    fctx.lineWidth = 8 / cam.k; // halo
    fctx.globalAlpha = ga(alpha * (0.10 + 0.05 * Math.sin(now / 430 + ph)));
    trace();
    fctx.lineWidth = 2.4 / cam.k; // fiber body
    fctx.globalAlpha = ga(alpha * 0.25);
    trace();
    DASH[0] = 10 / cam.k; DASH[1] = 26 / cam.k; // marching core, root -> leaf
    fctx.setLineDash(DASH);
    fctx.lineDashOffset = -((now * 0.13 + phase * 36) % 36) / cam.k;
    fctx.strokeStyle = bright(colorHex);
    fctx.lineWidth = 1.6 / cam.k;
    fctx.globalAlpha = ga(alpha * 0.9);
    trace();
    fctx.setLineDash(NODASH);
    if (endRing) {
      const end = chain[chain.length - 1];
      fctx.globalAlpha = ga(alpha * 0.8);
      fctx.lineWidth = 1.6 / cam.k;
      fctx.beginPath();
      fctx.arc(end.x, end.y, end.r + 4 / cam.k, 0, 6.2832);
      fctx.stroke();
    }
    fctx.globalAlpha = 1;
  }

  let lastSweep = 0;
  function drawStreams(now, dt) {
    if (!streams.size) return;
    if (now - lastSweep > 500) { // read-only attention drifts away after ~6s untouched
      lastSweep = now;
      for (const [p, a] of activity) {
        if (a.op === 'read' && now - a.t > 6000 && !changedMap.has(p)) {
          activity.delete(p);
          const s = streams.get(p);
          if (s) s.on = false; // built-in 600ms retract
        }
      }
    }
    const tweening = !!(introT0 || layoutT0);
    const mw = W / 2 / cam.k + 40, mh = H / 2 / cam.k + 40;
    fctx.lineCap = 'round';
    const glowOk = streams.size <= 12;
    const pkPer = streams.size > 12 ? 1 : 2;
    let pkBudget = PKT_MAX;
    for (const [path, s] of streams) {
      s.a = Math.max(0, Math.min(1, s.a + (s.on ? dt / 250 : -dt / 600)));
      if (!s.on && s.a <= 0) { streams.delete(path); continue; }
      if (!s.chain) continue;
      if (!tweening && s.gen !== geomGen) streamGeom(s);
      if (s.b && (s.b[2] < cam.x - mw || s.b[0] > cam.x + mw || s.b[3] < cam.y - mh || s.b[1] > cam.y + mh)) continue;
      const T = trailsCfg();
      const hot = s.flash && now - s.flash < T.holdMs; // success: hold the finish color…
      if (s.flash && !hot && s.on) s.on = false;       // …then retract the stream
      const col = hot ? T.done : s.color;
      const bcl = hot ? bright(T.done) : s.bcol;
      const ph = s.phase * 6.2832;
      fctx.strokeStyle = col;
      if (REDUCED) { // static soft highlight, no marching light
        fctx.lineWidth = 2.5 / cam.k;
        fctx.globalAlpha = ga(s.a * 0.28);
        strokeStream(s, tweening);
        continue;
      }
      if (glowOk) { // strobing halo
        fctx.lineWidth = 8 / cam.k;
        fctx.globalAlpha = ga(s.a * (0.10 + 0.05 * Math.sin(now / 430 + ph)));
        strokeStream(s, tweening);
      }
      fctx.lineWidth = 2.4 / cam.k; // fiber body
      fctx.globalAlpha = ga(s.a * 0.22);
      strokeStream(s, tweening);
      DASH[0] = 10 / cam.k; DASH[1] = 26 / cam.k; // marching core, root -> leaf
      fctx.setLineDash(DASH);
      fctx.lineDashOffset = -((now * 0.13 + s.phase * 36) % 36) / cam.k;
      fctx.strokeStyle = bcl;
      fctx.lineWidth = 1.6 / cam.k;
      fctx.globalAlpha = ga(s.a * 0.9);
      strokeStream(s, tweening);
      fctx.setLineDash(NODASH);
      if (s.pts && s.pts.length > 1) { // glowing packets riding the fiber
        const period = 900 + 450 * (s.chain.length - 1);
        for (let j = 0; j < pkPer && pkBudget > 0; j++, pkBudget--) {
          const t = ((now + s.phase * period) / period + j * 0.47) % 1;
          const f = t * (s.pts.length - 1), i0 = Math.floor(f), fr = f - i0;
          const x = s.pts[i0][0] + (s.pts[i0 + 1][0] - s.pts[i0][0]) * fr;
          const y = s.pts[i0][1] + (s.pts[i0 + 1][1] - s.pts[i0][1]) * fr;
          const sz = 5 * (0.8 + 0.2 * Math.sin(now / 300 + ph + j * 2.1));
          fctx.globalAlpha = ga(s.a * 0.75);
          fctx.drawImage(sprite(bcl), x - sz, y - sz, sz * 2, sz * 2);
        }
      }
    }
    fctx.globalAlpha = 1;
  }

  function spawnComet(v) { // a pulse racing from the root to a changing file
    if (REDUCED) return;
    if (comets.length >= 6) { if (cometQueue.length < 40) cometQueue.push(v); return; }
    const chain = [];
    for (let u = v; u; u = u.parentV) chain.unshift(u);
    if (chain.length < 2) return;
    const pts = [];
    for (let i = 1; i < chain.length; i++) sampleLink(chain[i - 1], chain[i], pts);
    comets.push({ pts, t0: performance.now(), dur: 380 + 160 * (chain.length - 1) });
    wake();
  }

  function burst(v, color) { // completion firework
    if (REDUCED) return;
    for (let i = 0; i < 26; i++) {
      if (particles.length >= 600) particles.shift();
      const a = (i / 26) * 6.2832 + Math.random() * 0.3;
      const sp = 35 + Math.random() * 95;
      const ttl = 650 + Math.random() * 500;
      particles.push({ x: v.x, y: v.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, ttl, life: ttl, size: 2 + Math.random() * 2.6, color });
    }
    wake();
  }

  const flicking = () => flickSet && performance.now() - flickT0 < 700;
  const onlyBreathing = () => !particles.length && !comets.length && !flicking() && !streams.size && !pulses.length && !waves.length && !hoverV && !selChain && !(active > 0 && changedMap.size);
  function fxActive() {
    if (!visRoot || document.hidden) return false;
    if (particles.length || comets.length || cometQueue.length || flicking() || streams.size || pulses.length || waves.length) return true;
    if (active > 0 && changedMap.size) return true;
    return !REDUCED && sceneryQ() > 0; // idle breathing keeps a slow 12fps heartbeat
  }

  function drawFx(now, dt) {
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    fctx.clearRect(0, 0, W, H);
    if (!visRoot) return;
    setWorld(fctx);
    fctx.globalCompositeOperation = THEME.fxComposite;
    const mw = W / 2 / cam.k + 40, mh = H / 2 / cam.k + 40;
    const inView = (v) => Math.abs(v.x - cam.x) < mw && Math.abs(v.y - cam.y) < mh;

    if (!REDUCED && sceneryQ() > 0) { // breathing hubs
      for (let i = 0; i < vis.length; i++) {
        const v = vis[i];
        if ((!v.isAgg && v.n.type !== 'dir') || !inView(v) || dimOf(v)) continue;
        fctx.globalAlpha = ga(Math.max(0, 0.05 + 0.045 * Math.sin(now / 1400 + ((i * 2.39) % 6.28))));
        const s = v.r * 3.4;
        fctx.drawImage(sprite(colorOf(v)), v.x - s, v.y - s, s * 2, s * 2);
      }
    }

    drawStreams(now, dt); // liquid light along every active work path

    if (!REDUCED && sceneryQ() > 0) { // hover + selection trails — same liquid light, your colors
      const T = trailsCfg();
      if (selChain && selChain.length > 1) strokeChainFx(selChain, T.selected, 1, now, hashPhase(selPath || 'sel'), true);
      if (hoverV && hoverV.parentV && (!selChain || hoverV !== selChain[selChain.length - 1])) {
        const chain = [];
        for (let u = hoverV; u; u = u.parentV) chain.unshift(u);
        if (chain.length > 1) strokeChainFx(chain, T.hover, 0.8, now, hashPhase(hoverV.n?.path || 'hov'), false);
      }
    }

    for (const [p, info] of changedMap) { // amber pulse on files being edited right now
      const v = vByPath.get(p);
      if (!v || !inView(v)) continue;
      const col = info.kind === 'deleted' ? THEME.deleted : THEME.changed;
      fctx.globalAlpha = ga(Math.max(0.08, REDUCED || !active ? 0.3 : 0.32 + 0.22 * Math.sin((now - info.t0) / 300)));
      const s = Math.max(11, v.r * 3.6);
      fctx.drawImage(sprite(col), v.x - s, v.y - s, s * 2, s * 2);
    }

    if (dirtySet.size && !REDUCED && sceneryQ() > 0) { // uncommitted: one slow shared breath
      const ping = pingCfg();
      const cyc = Math.floor(now / (ping.every * 1000)); // fire a shockwave per dirty node
      if (ping.on && cyc !== lastWaveCyc) {
        lastWaveCyc = cyc;
        let wi = 0;
        for (const p of dirtySet) {
          if (wi >= 4) break;
          if (changedMap.has(p)) continue;
          const v = resolveV(p);
          if (!v) continue;
          waves.push({ wx: v.x, wy: v.y, t0: now + wi * 220 });
          wi++;
        }
      }
      const breath = 0.5 + 0.5 * Math.sin(now / 1200); // 0..1, ~2.4s — swells big, never vanishes
      fctx.strokeStyle = THEME.changed;
      fctx.lineWidth = 2 / cam.k;
      let dn = 0;
      for (const p of dirtySet) {
        if (dn++ >= 60) break;
        if (changedMap.has(p)) continue; // a live run pulse already owns this node
        const v = resolveV(p);
        if (!v || !inView(v) || dimOf(v)) continue;
        fctx.globalAlpha = ga(0.10 + 0.10 * breath);
        const s = Math.max(14, v.r * (4.2 + 1.6 * breath)); // a wide halo that grows with the breath
        fctx.drawImage(sprite(THEME.changed), v.x - s, v.y - s, s * 2, s * 2);
        fctx.globalAlpha = 0.22 + 0.26 * breath;
        fctx.beginPath();
        fctx.arc(v.x, v.y, v.r + (4.5 + 4.5 * breath) / cam.k, 0, 6.2832);
        fctx.stroke();
      }
      fctx.globalAlpha = 1;
    }

    if (flickSet) { // failed run: three red pulses
      const el = now - flickT0;
      if (el < 700) {
        fctx.globalAlpha = ga(Math.abs(Math.sin((el / 700) * Math.PI * 3)) * 0.5);
        for (const p of flickSet) {
          const v = vByPath.get(p);
          if (!v) continue;
          const s = Math.max(12, v.r * 4);
          fctx.drawImage(sprite(THEME.deleted), v.x - s, v.y - s, s * 2, s * 2);
        }
      } else flickSet = null;
    }

    for (let ci = comets.length - 1; ci >= 0; ci--) {
      const c = comets[ci];
      const p = (now - c.t0) / c.dur;
      if (p >= 1) {
        comets.splice(ci, 1);
        const nx = cometQueue.shift();
        if (nx) spawnComet(nx);
        continue;
      }
      const n = c.pts.length;
      const hi = Math.max(1, Math.min(n - 1, Math.floor(p * n)));
      const tail = Math.max(0, hi - Math.max(2, Math.floor(n * 0.16)));
      fctx.strokeStyle = THEME.comet;
      fctx.lineWidth = 1.8 / cam.k;
      for (let i = tail; i < hi; i++) {
        fctx.globalAlpha = ga(((i - tail + 1) / (hi - tail + 1)) * 0.55);
        fctx.beginPath();
        fctx.moveTo(c.pts[i][0], c.pts[i][1]);
        fctx.lineTo(c.pts[i + 1][0], c.pts[i + 1][1]);
        fctx.stroke();
      }
      fctx.globalAlpha = ga(0.9);
      const hs = 7;
      fctx.drawImage(sprite(THEME.cometHead), c.pts[hi][0] - hs, c.pts[hi][1] - hs, hs * 2, hs * 2);
    }

    for (let i = pulses.length - 1; i >= 0; i--) { // fly-to landing rings
      const p = pulses[i];
      const el = now - p.t0;
      if (el > 1800) { pulses.splice(i, 1); continue; }
      if (el < 0) continue;
      const pr = el / 1800;
      fctx.strokeStyle = p.color;
      fctx.lineWidth = 2 / cam.k;
      for (const off of [0, 0.18]) {
        const q = pr - off;
        if (q < 0 || q > 1) continue;
        fctx.globalAlpha = ga((1 - q) * 0.7);
        fctx.beginPath();
        fctx.arc(p.x, p.y, 6 / cam.k + (q * 90) / Math.sqrt(cam.k), 0, 6.2832);
        fctx.stroke();
      }
    }

    for (let i = particles.length - 1; i >= 0; i--) {
      const pt = particles[i];
      pt.life -= dt;
      if (pt.life <= 0) { particles.splice(i, 1); continue; }
      const f = Math.pow(0.92, dt / 16);
      pt.vx *= f;
      pt.vy = pt.vy * f + 18 * (dt / 1000);
      pt.x += pt.vx * (dt / 1000);
      pt.y += pt.vy * (dt / 1000);
      const lf = pt.life / pt.ttl;
      fctx.globalAlpha = ga(Math.min(1, lf * 1.4));
      const s = pt.size * (0.5 + lf * 0.7);
      fctx.drawImage(sprite(pt.color), pt.x - s, pt.y - s, s * 2, s * 2);
    }

    if (waves.length) { // shockwaves: the map's own light bends inside a moving annulus
      fctx.setTransform(dpr, 0, 0, dpr, 0, 0); // screen space — we redraw the base layer displaced
      fctx.globalCompositeOperation = 'source-over';
      const ping = pingCfg();
      const diag = Math.hypot(W, H);
      for (let i = waves.length - 1; i >= 0; i--) {
        const wv = waves[i];
        const t = (now - wv.t0) / (ping.sweep * 1000);
        if (t >= 1) { waves.splice(i, 1); continue; }
        if (t < 0) continue; // staggered start
        const e = 1 - Math.pow(1 - t, 2); // ease-out expansion
        const sx = (wv.wx - cam.x) * cam.k + W / 2;
        const sy = (wv.wy - cam.y) * cam.k + H / 2;
        const r = e * diag, band = (10 + 26 * t) * ping.width;
        fctx.save();
        fctx.beginPath();
        fctx.arc(sx, sy, r + band / 2, 0, 6.2832);
        fctx.arc(sx, sy, Math.max(0, r - band / 2), 0, 6.2832, true);
        fctx.clip();
        const sc = 1 + 0.03 * (1 - t) * ping.power; // lens magnification at the front
        fctx.translate(sx, sy);
        fctx.scale(sc, sc);
        fctx.translate(-sx, -sy);
        fctx.globalAlpha = 0.85 * (1 - t * 0.5);
        fctx.drawImage(baseC, 0, 0, baseC.width, baseC.height, 0, 0, W, H);
        fctx.restore();
        fctx.strokeStyle = THEME.wave; // contrast-colored wavefront
        fctx.globalAlpha = 0.5 * (1 - t) * Math.min(1.5, ping.power);
        fctx.lineWidth = Math.max(1, band * 0.12);
        fctx.beginPath();
        fctx.arc(sx, sy, r, 0, 6.2832);
        fctx.stroke();
      }
      setWorld(fctx); // leave the transform the way the rest of the frame expects
      fctx.globalCompositeOperation = THEME.fxComposite;
    }
    fctx.globalAlpha = 1;
    fctx.globalCompositeOperation = 'source-over';
  }

  /* ----- scheduler: one rAF loop that parks when idle ----- */
  function stepCam(now) {
    const a = camAnim;
    const p = Math.min(1, (now - a.t0) / a.dur);
    const e = easeIO(p);
    cam.x = a.x0 + (a.x1 - a.x0) * e;
    cam.y = a.y0 + (a.y1 - a.y0) * e;
    cam.k = Math.exp(a.l0 + (a.l1 - a.l0) * e);
    if (p >= 1) { camAnim = null; scheduleAutoExpand(); }
    dirtyBase = true;
  }

  function stepNodes(now) {
    if (introT0) { // tree grows out of the core, staggered by depth
      let busy = false;
      for (const v of vis) {
        const p = Math.min(1, Math.max(0, (now - introT0 - v.delay) / 460));
        v.grow = easeOB(p);
        const q = easeIO(Math.min(1, p * 1.15));
        const px = v.parentV ? v.parentV.tx : 0, py = v.parentV ? v.parentV.ty : 0;
        v.x = px + (v.tx - px) * q;
        v.y = py + (v.ty - py) * q;
        if (p < 1) busy = true;
      }
      dirtyBase = true;
      if (!busy) { introT0 = 0; geomGen++; for (const v of vis) { v.grow = 1; v.x = v.tx; v.y = v.ty; } }
      return busy;
    }
    if (layoutT0) {
      const p = Math.min(1, (now - layoutT0) / 300);
      const e = easeIO(p);
      for (const v of vis) {
        v.x = v.sx + (v.tx - v.sx) * e;
        v.y = v.sy + (v.ty - v.sy) * e;
        if (v.isNew) v.grow = e;
      }
      dirtyBase = true;
      if (p >= 1) { layoutT0 = 0; geomGen++; for (const v of vis) { v.x = v.tx; v.y = v.ty; v.grow = 1; v.isNew = false; } }
      return p < 1;
    }
    return false;
  }

  function frame(now) {
    if (!running) return;
    try {
      let busy = false;
      if (camAnim) { stepCam(now); busy = true; }
      if (stepNodes(now)) busy = true;
      if (dirtyBase) { drawBase(); dirtyBase = false; }
      const f = fxActive();
      if (f) {
        const throttle = onlyBreathing() && !busy ? 80 : 0;
        if (now - lastFx >= throttle) { drawFx(now, Math.min(60, now - lastFx || 16)); lastFx = now; }
      }
      if (busy || f || camAnim || dirtyBase) requestAnimationFrame(frame);
      else {
        running = false;
        fctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fctx.clearRect(0, 0, W, H);
      }
    } catch (err) {
      // never leave `running` stranded — a stuck flag makes every future
      // wake() a no-op and the map goes permanently dark
      running = false;
      console.error('RepoViz frame error:', err);
    }
  }

  function wake() {
    if (running) return;
    running = true;
    lastT = performance.now();
    lastFx = lastT - 100;
    requestAnimationFrame(frame);
  }

  /* ----- live run integration ----- */
  function tickerPush(txt) {
    const d = document.createElement('div');
    d.className = 'tk';
    d.textContent = txt;
    tickerEl.prepend(d);
    while (tickerEl.children.length > 4) tickerEl.lastChild.remove();
    setTimeout(() => d.classList.add('out'), 4200);
    setTimeout(() => d.remove(), 5100);
  }

  function ensurePath(path, size) { // splice a freshly created file into the live tree
    if (byPath.has(path)) return byPath.get(path);
    const parts = path.split('/');
    let n = tree;
    let p = '';
    for (let i = 0; i < parts.length; i++) {
      p = p ? p + '/' + parts[i] : parts[i];
      let c = (n.children || []).find((k) => k.name === parts[i]);
      if (!c) {
        const nowS = Date.now() / 1000;
        c = i === parts.length - 1
          ? { name: parts[i], path: p, type: 'file', size: size || 0, t: nowS, ext: extOf(parts[i]), leaf: 1, total: size || 0, maxT: nowS }
          : { name: parts[i], path: p, type: 'dir', children: [], leaf: 1, total: 0, maxT: 0 };
        c.parent = n;
        c.depth = n.depth + 1;
        n.children.push(c);
        n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
        byPath.set(p, c);
      }
      if (c.type === 'dir') expanded.add(c);
      n = c;
    }
    return n;
  }

  async function poll() {
    let r;
    try { r = await (await fetch('/api/repotree/status')).json(); } catch { return; }
    if (r.error || !tree) return;
    const now = new Set();
    let mutated = false, hotMut = false;
    for (const c of r.changed) {
      now.add(c.file);
      const prev = changedMap.get(c.file);
      if (!prev) {
        changedMap.set(c.file, { kind: c.kind, t0: performance.now() });
        hotMut = true;
        if (!touched.has(c.file)) {
          touched.add(c.file);
          tickerPush((c.kind === 'added' ? '+ ' : c.kind === 'deleted' ? '− ' : '± ') + c.file);
        }
        if (c.kind !== 'deleted' && !byPath.has(c.file)) {
          ensurePath(c.file, c.size);
          mutated = true;
          pendingComets.push(c.file);
        } else if (vByPath.has(c.file)) {
          spawnComet(vByPath.get(c.file));
        } else if (byPath.has(c.file)) { // in the tree but folded away — open its ancestors
          for (let u = byPath.get(c.file).parent; u; u = u.parent) {
            if (u.type === 'dir' && !expanded.has(u)) { expanded.add(u); mutated = true; }
          }
          if (mutated) pendingComets.push(c.file);
        }
        dirtyBase = true;
      } else if (prev.kind !== c.kind) {
        prev.kind = c.kind;
        hotMut = true;
        dirtyBase = true;
      }
    }
    for (const p of [...changedMap.keys()]) {
      if (!now.has(p)) { changedMap.delete(p); hotMut = true; dirtyBase = true; } // reverted or committed
    }
    if (r.head && lastHead && r.head !== lastHead) load(true, true); // the runner committed
    lastHead = r.head || lastHead;
    if (hotMut) rebuildStreams();
    if (mutated) relayout({ tween: true });
    wake();
  }

  function runStarted() {
    active++;
    snapshots.push(new Set(touched));
    if (active === 1) {
      poll();
      pollTimer = setInterval(poll, 2000);
    }
  }

  function runEnded(ok) { // ok: true = celebrate, false = flicker, null = just clean up
    if (!active) return;
    active--;
    const snap = snapshots.pop() || new Set();
    const delta = [...touched].filter((p) => !snap.has(p));
    if (ok === true) {
      const fnow = performance.now();
      for (const [, s] of streams) if (s.on) s.flash = fnow; // finish-color farewell on EVERY live trail (reads too)
      activity.clear();
      delta.forEach((p, i) => {
        completed.add(p);
        setTimeout(() => {
          const v = vByPath.get(p);
          if (v) burst(v, trailsCfg().done);
          dirtyBase = true;
          wake();
        }, i * 90);
      });
    } else if (ok === false && delta.length && !REDUCED) {
      flickSet = new Set(delta);
      flickT0 = performance.now();
      wake();
    }
    if (ok !== true) { activity.clear(); rebuildStreams(); } // no celebration — read trails just retract
    if (active === 0) {
      clearInterval(pollTimer);
      pollTimer = null;
      setTimeout(() => { poll(); load(true, true); }, ok === true ? 1900 : 900); // let the show play, then refresh
    }
  }

  /* ----- data load / empty state / legend ----- */
  function showEmpty(msg) {
    let d = shell.querySelector('.viz-empty');
    if (!d) { d = document.createElement('div'); d.className = 'viz-empty'; shell.appendChild(d); }
    d.innerHTML = msg;
    tree = null; visRoot = null; vis = []; grid = new Map(); vByPath = new Map();
    $('#viz-count').textContent = '';
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0); bctx.clearRect(0, 0, W, H);
    fctx.setTransform(dpr, 0, 0, dpr, 0, 0); fctx.clearRect(0, 0, W, H);
  }

  async function load(fresh, keepMarks) {
    if (loading) { queued = true; return; }
    loading = true;
    try {
      const q = [heatOn && 'heat=1', fresh && 'fresh=1'].filter(Boolean).join('&');
      let data;
      try { data = await (await fetch('/api/repotree' + (q ? '?' + q : ''))).json(); }
      catch { showEmpty('dashboard server unreachable'); return; }
      if (data.error) { showEmpty(esc(data.error) + ' — point Workloop at a repo in Settings'); return; }
      shell.querySelector('.viz-empty')?.remove();
      stats = data.stats;
      hasHeat = heatOn;
      if (!keepMarks) { completed.clear(); touched.clear(); changedMap.clear(); streams.clear(); }
      const prevExp = new Set([...expanded].map((n) => n.path));
      byPath = new Map();
      tree = buildTree(data);
      annotate(tree, null, 0);
      defaultExpansion();
      for (const p of prevExp) { const n = byPath.get(p); if (n && n.type === 'dir' && n.children.length) expanded.add(n); }
      $('#viz-count').textContent =
        `${stats.files.toLocaleString()} files · ${fmtB(stats.bytes)}${data.truncated ? ` · largest ${data.files.length.toLocaleString()} shown` : ''}`;
      relayout(firstLoad ? { intro: true } : { tween: true });
      if (firstLoad) {
        const f = fitParams(visRoot);
        fitK = f.k;
        cam.x = f.x; cam.y = f.y; cam.k = f.k;
        firstLoad = false;
      }
      if (!legendEl.hidden) renderLegend();
      dirtyBase = true;
      wake();
    } finally {
      loading = false;
      if (queued) { queued = false; load(false, true); }
    }
  }

  function renderLegend() {
    const langs = Object.entries((stats && stats.langs) || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
    legendEl.innerHTML =
      `<div class="lg" style="color:var(--text)">node size = file size</div>` +
      `<div class="lg"><span class="sw" style="background:${THEME.pal.dir}"></span>directory</div>` +
      langs.map(([e, c]) =>
        `<div class="lg"><span class="sw" style="background:${THEME.pal[e] || THEME.pal.other}"></span>${esc(e || 'no ext')} · ${c}</div>`).join('') +
      `<div class="lg"><span class="sw" style="background:${THEME.changed}"></span>changing now</div>` +
      `<div class="lg"><span class="sw" style="background:transparent;border:1.5px solid ${THEME.changed}"></span>uncommitted changes</div>` +
      `<div class="lg"><span class="sw" style="background:${THEME.success}"></span>updated by a run</div>` +
      (heatOn ? `<div class="lg" style="margin-top:5px;color:var(--text)">heat: bright = recent commits</div>` : '');
  }

  /* ----- theme switch ----- */
  function retheme(next) {
    next = next || {};
    if (next.palGroups) { // theme.js hands over 15 group colors; expand to extensions
      next = { ...next, pal: expandPal(next.palGroups) };
      delete next.palGroups;
    }
    Object.assign(THEME, next);
    HEAT = buildHeat(THEME.heatStops);
    if (typeof VizScenery !== 'undefined') VizScenery.retheme(THEME);
    sprites.clear();  // glow sprites are cached per color string
    brights.clear();  // derived bright colors too
    if (!bctx) return; // theme applied before init() — values land, first draw uses them
    if (streams.size || changedMap.size) rebuildStreams(); // live streams pick up new palette
    if (legendEl && !legendEl.hidden) renderLegend();
    dirtyBase = true;
    wake();
  }

  /* ----- input ----- */
  function xy(e) {
    const r = shell.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function onHover(sx, sy) {
    const v = pick(sx, sy);
    if (v !== hoverV) {
      hoverV = v;
      dirtyBase = true;
      wake();
      shell.style.cursor = v ? 'pointer' : 'grab';
      if (hoverCb) {
        hoverCb(v ? { path: v.isAgg ? v.host.path : v.n.path, isDir: v.isAgg || v.n.type === 'dir' } : null);
      }
    }
    if (!pinned) { if (v) showTip(v, sx, sy); else hideTip(); }
  }

  function onClick(sx, sy) {
    const v = pick(sx, sy);
    if (!v) { pinned = false; hideTip(); if (menuCb) menuCb(null); if (fileClickCb) fileClickCb(null); return; }
    if (v.isAgg || v.n.type === 'dir') userView = true;
    if (v.isAgg) { zoomToFitV(v.parentV, 480); return; }
    if (v.n.type === 'dir') {
      if (!expanded.has(v.n) && v.n.children.length) {
        expanded.add(v.n);
        evictFor(v.n);
        relayout({ tween: true });
        zoomToFitV(vByPath.get(v.n.path) || v, 520);
      } else zoomToFitV(v, 520);
      return;
    }
    if (menuCb) { hideTip(); menuCb(nodeInfo(v), sx, sy); return; } // nav menu takes over
    if (fileClickCb) { hideTip(); fileClickCb(v.n.path, sx, sy); return; }
    pinned = true;
    showTip(v, sx, sy);
  }

  function bind() {
    shell.addEventListener('wheel', (e) => {
      e.preventDefault();
      camAnim = null;
      const [sx, sy] = xy(e);
      zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015));
      if (!pinned) hideTip();
    }, { passive: false });

    shell.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return; // right-click is the context menu, never a drag
      if (e.target.closest('.viz-legend')) return;
      shell.setPointerCapture(e.pointerId);
      const [sx, sy] = xy(e);
      pointers.set(e.pointerId, { x: sx, y: sy });
      if (pointers.size === 1) { drag = { moved: false }; camAnim = null; }
      shell.classList.add('dragging');
    });

    shell.addEventListener('pointermove', (e) => {
      const [sx, sy] = xy(e);
      const pt = pointers.get(e.pointerId);
      if (!pt) { onHover(sx, sy); return; }
      if (pointers.size === 2) { // pinch
        const other = [...pointers.entries()].find(([pid]) => pid !== e.pointerId)[1];
        const d0 = Math.hypot(pt.x - other.x, pt.y - other.y);
        const d1 = Math.hypot(sx - other.x, sy - other.y);
        if (d0 > 8) zoomAt((sx + other.x) / 2, (sy + other.y) / 2, d1 / d0);
        if (drag) drag.moved = true;
      } else if (drag) { // pan
        cam.x -= (sx - pt.x) / cam.k;
        cam.y -= (sy - pt.y) / cam.k;
        if (Math.abs(sx - pt.x) + Math.abs(sy - pt.y) > 3) { drag.moved = true; userView = true; pinned = false; hideTip(); }
        dirtyBase = true;
        wake();
      }
      pointers.set(e.pointerId, { x: sx, y: sy });
    });

    const up = (e) => {
      const had = pointers.delete(e.pointerId);
      if (!pointers.size) shell.classList.remove('dragging');
      if (!had) return;
      if (drag && !drag.moved && e.type === 'pointerup') { const [sx, sy] = xy(e); onClick(sx, sy); }
      if (!pointers.size) { drag = null; scheduleAutoExpand(); }
    };
    shell.addEventListener('pointerup', up);
    shell.addEventListener('pointercancel', up);
    shell.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.viz-legend')) return; // native menu on the legend stays
      e.preventDefault();
      const [sx, sy] = xy(e);
      const v = pick(sx, sy);
      pinned = false;
      hideTip();
      if (menuCb) menuCb(v && !(!v.isAgg && v.n.depth === 0) ? nodeInfo(v) : null, sx, sy); // no menu on the root core
    });
    shell.addEventListener('dblclick', () => { userView = false; zoomToFitV(visRoot, 500); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape') { pinned = false; hideTip(); } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { dirtyBase = true; wake(); } });

    $('#viz-zin').addEventListener('click', () => { userView = true; animateCam(cam.x, cam.y, Math.min(40, cam.k * 1.6), 220); });
    $('#viz-zout').addEventListener('click', () => { userView = true; animateCam(cam.x, cam.y, Math.max(fitK * 0.4, cam.k / 1.6), 220); });
    $('#viz-fit').addEventListener('click', () => { userView = false; zoomToFitV(visRoot, 500); });
    $('#viz-heat').classList.toggle('on', heatOn);
    $('#viz-heat').addEventListener('click', () => (typeof Viz !== 'undefined' ? Viz.toggleHeat() : setHeat(!heatOn)));
    $('#viz-help').addEventListener('click', () => {
      legendEl.hidden = !legendEl.hidden;
      if (!legendEl.hidden) renderLegend();
    });
  }

  function resize() {
    const r = shell.getBoundingClientRect();
    W = Math.max(60, r.width);
    H = Math.max(60, r.height);
    dpr = Math.min(2, devicePixelRatio || 1);
    for (const c of [baseC, fxC]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    if (!userView && visRoot && !introT0) { // keep the whole-repo fit until the user takes the wheel
      const f = fitParams(visRoot);
      fitK = f.k;
      cam.x = f.x; cam.y = f.y; cam.k = f.k;
      camAnim = null;
    }
    dirtyBase = true;
    wake();
  }

  async function init() {
    shell = $('#viz-shell');
    baseC = $('#viz-base'); fxC = $('#viz-fx');
    bctx = baseC.getContext('2d'); fctx = fxC.getContext('2d');
    tip = $('#viz-tip'); tickerEl = $('#viz-ticker'); legendEl = $('#viz-legend');
    new ResizeObserver(resize).observe(shell);
    resize();
    bind();
    if (typeof Quality !== 'undefined') {
      VizScenery.setQuality(Quality.level());
      Quality.onChange((l) => { VizScenery.setQuality(l); dirtyBase = true; wake(); });
    }
    await load(false, false);
  }

  /* ----- navigation / integration API ----- */
  function allPaths() {
    const out = [];
    for (const [p, n] of byPath) if (p && n.type === 'file') out.push(p);
    return out;
  }

  function flyTo(path) {
    const n = byPath.get(path);
    if (!n) return false;
    let mutated = false;
    for (let u = n.parent; u; u = u.parent) {
      if (u.type === 'dir' && !expanded.has(u)) { expanded.add(u); mutated = true; }
    }
    if (mutated) { evictFor(n); relayout({ tween: true }); }
    let m = n;
    while (m && !vByPath.has(m.path)) m = m.parent; // folded leaf -> nearest visible
    const v = m && vByPath.get(m.path);
    if (!v) return false;
    userView = true;
    const k = Math.max(fitK, Math.min(12, 24 / Math.max(2, v.r)));
    const availW = Math.max(120, W - insets.left - insets.right);
    const availH = Math.max(120, H - insets.top - insets.bottom);
    animateCam(
      v.tx - (insets.left + availW / 2 - W / 2) / k,
      v.ty - (insets.top + availH / 2 - H / 2) / k,
      k, 600,
    );
    if (!REDUCED) pulses.push({ x: v.tx, y: v.ty, t0: performance.now() + 400, color: THEME.accent });
    wake();
    return true;
  }

  function spotlight(path) {
    spotPath = path || null;
    spotChain = spotPath ? chainOf(spotPath) : null;
    dirtyBase = true;
    wake();
  }

  function setSelected(path) {
    selPath = path || null;
    selChain = selPath && bctx ? chainOf(selPath) : null;
    dirtyBase = true;
    if (bctx) wake();
  }

  function setExtFilter(exts) {
    extFilter = exts && exts.size ? exts : null;
    dirtyBase = true;
    wake();
  }

  function setPathFilter(prefix) {
    pathFilter = prefix || null;
    pathAnc = null;
    if (pathFilter) {
      pathAnc = new Set(['']); // root always stays lit
      let acc = '';
      for (const seg of pathFilter.split('/')) { acc = acc ? acc + '/' + seg : seg; pathAnc.add(acc); }
    }
    dirtyBase = true;
    if (bctx) wake();
  }
  function setTaskMarks(list) {
    taskMarks = new Map((list || []).map((m) => [m.file, m]));
    dirtyBase = true;
    if (bctx) wake();
  }
  function setPins(set) {
    pinSet = new Set(set || []);
    dirtyBase = true;
    if (bctx) wake();
  }
  function setDirty(list) {
    dirtySet = new Set(list || []);
    if (!dirtySet.size) waves.length = 0; // committed/discarded — stop the ripples too
    dirtyBase = true; // the static-fallback ring lives on the base layer
    if (bctx) wake();
  }

  async function setHeat(on) {
    on = !!on;
    $('#viz-heat')?.classList.toggle('on', on);
    if (heatOn === on) return;
    heatOn = on;
    if (!bctx) return; // pre-init: the first load() honors heatOn
    if (heatOn && !hasHeat) await load(false, true);
    if (!legendEl.hidden) renderLegend();
    dirtyBase = true;
    wake();
  }

  return {
    init, reload: () => load(false, false), runStarted, runEnded, retheme, setInsets, resize,
    allPaths, flyTo, spotlight, setExtFilter, setHeat,
    setPathFilter, setTaskMarks, setPins, setDirty,
    setSelected, fileActivity,
    onHoverChange: (fn) => { hoverCb = fn; },
    onFileClick: (fn) => { fileClickCb = fn; },
    onNodeMenu: (fn) => { menuCb = fn; },
    langStats: () => (stats && stats.langs) || {},
    debug: () => ({ cam: { ...cam }, running, dirtyBase, vis: vis.length, W, H, fitK, insets: { ...insets }, hasRoot: !!visRoot, camAnim: !!camAnim }),
  };
})();
