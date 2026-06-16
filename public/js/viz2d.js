/* viz2d.js — shared flat-canvas view engine for the non-galaxy modes.

   makeFlatViz(cfg) returns a module that satisfies the same public API the
   galaxy exposes (galaxy.js:1763), so the Viz facade (viz-mode.js) can fan
   nav/board/bus calls to it for free: search fly-to, the breadcrumb, ext/path
   filters, pins, task marks, the dirty ring, live fileActivity glow, selection,
   theming and heat all "just work" once a mode plugs in.

   The engine owns everything that is identical across modes — tree load, the
   {x,y,k} camera (pan/zoom/fit), spatial-hash picking, hover tooltip, the node
   menu hookup, overlays, labels and the dirty-flag rAF loop. A mode supplies
   only a layout strategy (where nodes go) and, optionally, how the "world layer"
   (edges + node bodies) is painted. Cribbed from galaxy.js so behaviour matches. */
function makeFlatViz(cfg) {
  const { EXT_GROUPS, expandPal, PAL_DEFAULT, buildHeat, extOf, fmtB, easeIO } = GalaxyCore;
  const NODE_CAP = 2500, CHILD_CAP = 64, LABEL_CAP = 200, GRID = 64;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const id = cfg.id;
  const $id = (suffix) => document.getElementById(suffix);

  const CONFIG_RE = /^(package(-lock)?\.json|app\.json|eas\.json|tsconfig[^/]*|babel\.config\.[^/]+|metro\.config\.[^/]+|\.[^/]*rc[^/]*|[^/]+\.config\.(js|ts|mjs|cjs))$/i;
  const THEME = {
    pal: expandPal(PAL_DEFAULT),
    heatStops: ['#ecb24c', '#c48642', '#786a58', '#4a5260', '#343b47'],
    heatEmpty: '#3a4150', link: '#565f6e', accent: '#4fd1c5',
    changed: '#e0a33e', deleted: '#e0614b', success: '#3fb66e',
    labelDir: '#c7d2d0', labelFile: 'rgba(150,159,173,0.95)', labelHalo: 'rgba(20,23,28,0.85)',
    mono: 'ui-monospace,"SF Mono",Menlo,monospace', core: '#ffffff',
  };
  let HEAT = buildHeat(THEME.heatStops);

  const withAlpha = (hex, a) => {
    if (!hex || hex[0] !== '#' || hex.length < 7) return hex;
    return `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
  };

  let shell, canvas, g, tip, legendEl, countEl, W = 0, H = 0, dpr = 1;
  let tree = null, byPath = new Map(), stats = null, heatOn = localStorage.getItem('wl.heat') === '1', hasHeat = false;
  let loading = false, queued = false, firstLoad = true, visible = id === (localStorage.getItem('wl.viz') || '3d');
  let vis = [], visRoot = null, vByPath = new Map(), expanded = new Set(), grid = new Map();
  const cam = { x: 0, y: 0, k: 1 };
  let camAnim = null, fitK = 0.2, running = false, dirty = true;
  let tweenT0 = 0;
  let hoverV = null, pinned = false, drag = null, userView = false;
  const pointers = new Map();
  let hoverCb = null, fileClickCb = null, menuCb = null;
  let extFilter = null, pathFilter = null, pathAnc = null;
  let taskMarks = new Map(), pinSet = new Set(), dirtySet = new Set(), completed = new Set();
  let selPath = null, selChain = null, spotPath = null, spotChain = null;
  const activity = new Map(); // path -> { op, t }
  let insets = { left: 0, right: 0, top: 0, bottom: 0 };
  let active = 0;

  const trailsCfg = () => (typeof Trails !== 'undefined' ? Trails.cfg : GalaxyCore.TRAILS_DEF);

  /* ---- data: flat payload -> nested tree (mirrors galaxy.js) ---- */
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
    for (const d of data.dirs || []) {
      const dir = d.p === '.' ? root : dirAt(d.p.split('/'));
      dir.aggN = (dir.aggN || 0) + d.n; dir.aggS = (dir.aggS || 0) + d.s;
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

  const visChildCount = (d) => Math.min(d.children.length, CHILD_CAP) + (d.children.length > CHILD_CAP || d.aggN ? 1 : 0);
  function defaultExpansion() {
    expanded = new Set([tree]);
    let count = 1 + visChildCount(tree);
    const cand = (tree.children || []).filter((c) => c.type === 'dir');
    while (cand.length) {
      let bi = 0;
      for (let i = 1; i < cand.length; i++) if (cand[i].leaf > cand[bi].leaf) bi = i;
      const d = cand.splice(bi, 1)[0];
      if (!d.children.length) continue;
      if (count + visChildCount(d) > NODE_CAP) continue;
      expanded.add(d); count += visChildCount(d);
      for (const c of d.children) if (c.type === 'dir') cand.push(c);
    }
  }
  function evictFor(target) {
    let count = vis.length;
    if (count <= NODE_CAP) return;
    const protect = new Set();
    for (let u = target; u; u = u.parent) protect.add(u);
    const ev = [...expanded].filter((d) => d !== tree && !protect.has(d)).sort((a, b) => b.depth - a.depth);
    while (count > NODE_CAP && ev.length) { const d = ev.shift(); expanded.delete(d); count -= visChildCount(d); }
  }

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
        depth: parentV ? parentV.depth + 1 : 0, tx: 0, ty: 0, x: 0, y: 0, sx: 0, sy: 0, r: 0, rect: null, grow: 1, _dx: 0, _dy: 0,
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
      if (cs.length > CHILD_CAP) {
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
    for (const v of vis) prev.set(v.isAgg ? v.host.path + '/*' : v.n.path, [v.x, v.y]);
    buildVis();
    cfg.layout(visRoot, vis, { THEME, colorOf, radiusOf, GalaxyCore });
    buildGrid();
    if (spotPath) spotChain = chainOf(spotPath);
    if (selPath) selChain = chainOf(selPath);
    if (opts.tween && !REDUCED && !firstLoad) {
      tweenT0 = performance.now();
      for (const v of vis) {
        const p = prev.get(v.isAgg ? v.host.path + '/*' : v.n.path);
        v.sx = p ? p[0] : (v.parentV ? v.parentV.tx : v.tx);
        v.sy = p ? p[1] : (v.parentV ? v.parentV.ty : v.ty);
        v.x = v.sx; v.y = v.sy;
      }
    } else {
      for (const v of vis) { v.x = v.tx; v.y = v.ty; }
    }
    dirty = true; wake();
  }

  /* ---- camera ---- */
  const screenOf = (wx, wy) => [(wx - cam.x) * cam.k + W / 2, (wy - cam.y) * cam.k + H / 2];
  const worldOf = (sx, sy) => [(sx - W / 2) / cam.k + cam.x, (sy - H / 2) / cam.k + cam.y];
  const setWorld = () => g.setTransform(cam.k * dpr, 0, 0, cam.k * dpr, (W / 2 - cam.x * cam.k) * dpr, (H / 2 - cam.y * cam.k) * dpr);

  function bounds() {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const v of vis) {
      const ext = v.rect ? Math.max(v.rect.w, v.rect.h) / 2 : v.r;
      x0 = Math.min(x0, v.tx - ext); x1 = Math.max(x1, v.tx + ext);
      y0 = Math.min(y0, v.ty - ext); y1 = Math.max(y1, v.ty + ext);
    }
    if (!isFinite(x0)) return { x0: -100, x1: 100, y0: -100, y1: 100 };
    return { x0, x1, y0, y1 };
  }
  function fitParams() {
    const b = bounds();
    const availW = Math.max(120, W - insets.left - insets.right);
    const availH = Math.max(120, H - insets.top - insets.bottom);
    const k = Math.min(2.4, Math.min(availW / Math.max(60, b.x1 - b.x0 + 80), availH / Math.max(60, b.y1 - b.y0 + 80)));
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    return { x: cx - (insets.left + availW / 2 - W / 2) / k, y: cy - (insets.top + availH / 2 - H / 2) / k, k };
  }
  function animateCam(x, y, k, ms) {
    if (REDUCED) ms = Math.min(ms, 120);
    if (ms <= 0) { cam.x = x; cam.y = y; cam.k = k; dirty = true; wake(); return; }
    camAnim = { x0: cam.x, y0: cam.y, l0: Math.log(cam.k), x1: x, y1: y, l1: Math.log(k), t0: performance.now(), dur: ms };
    wake();
  }
  function fit(ms = 500) { const f = fitParams(); fitK = f.k; animateCam(f.x, f.y, f.k, ms); }
  function zoomAt(sx, sy, f) {
    userView = true;
    const k2 = Math.max(fitK * 0.4, Math.min(40, cam.k * f));
    const [wx, wy] = worldOf(sx, sy);
    cam.x = wx - (sx - W / 2) / k2; cam.y = wy - (sy - H / 2) / k2; cam.k = k2;
    dirty = true; wake();
  }

  /* ---- picking / tooltip ---- */
  function pick(sx, sy) {
    if (!visRoot) return null;
    const [wx, wy] = worldOf(sx, sy);
    if (cfg.pickMode === 'rect') { // treemap: smallest containing tile
      let best = null, ba = Infinity;
      for (const v of vis) {
        const r = v.rect; if (!r) continue;
        if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
          const a = r.w * r.h; if (a < ba) { ba = a; best = v; }
        }
      }
      return best;
    }
    const cx = Math.floor(wx / GRID), cy = Math.floor(wy / GRID);
    let best = null, bd = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = grid.get((cx + i) + ',' + (cy + j));
      if (!cell) continue;
      for (const v of cell) {
        const d = Math.hypot(wx - v.tx, wy - v.ty);
        if (d <= v.r + 8 / cam.k && d < bd) { bd = d; best = v; }
      }
    }
    return best;
  }
  const ago = (t) => { const d = Date.now() / 1000 - t; return d < 3600 ? Math.max(1, Math.floor(d / 60)) + 'm ago' : d < 86400 ? Math.floor(d / 3600) + 'h ago' : Math.floor(d / 86400) + 'd ago'; };
  function tipHTML(v) {
    if (v.isAgg) return `<div>${esc(v.host.path || v.host.name)}/</div><div class="dim">+${v.aggCount.toLocaleString()} more files · ${fmtB(v.aggSize)}</div>`;
    const n = v.n;
    if (n.type === 'dir') return `<div>${esc(n.path || n.name)}/</div><div class="dim">${n.leaf.toLocaleString()} files · ${fmtB(n.total)}${expanded.has(n) || !n.children.length ? '' : ' · click to open'}</div>`;
    return `<div>${esc(n.path)}</div><div class="dim">${fmtB(n.size)}${n.ext ? ' · ' + esc(n.ext) : ''}${n.t ? ' · ' + ago(n.t) : ''}</div>`;
  }
  function showTip(v, x, y) {
    if (!tip) return;
    tip.innerHTML = tipHTML(v); tip.hidden = false;
    tip.style.left = Math.max(4, Math.min(x + 14, W - tip.offsetWidth - 8)) + 'px';
    tip.style.top = Math.max(4, Math.min(y + 14, H - tip.offsetHeight - 8)) + 'px';
  }
  const hideTip = () => { if (tip) tip.hidden = true; };

  function topExts(n) {
    const c = new Map(); let budget = 3000;
    const rec = (d) => { for (const k of d.children || []) { if (budget-- <= 0) return; if (k.type === 'dir') rec(k); else { const e = k.ext || 'other'; c.set(e, (c.get(e) || 0) + 1); } } };
    rec(n);
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }
  function nodeInfo(v) {
    if (v.isAgg) { const h = v.host; return { path: h.path, name: h.name, isDir: true, isAgg: true, aggCount: v.aggCount, leaf: h.leaf, bytes: h.total, t: h.maxT || 0, topExts: topExts(h) }; }
    const n = v.n;
    if (n.type === 'dir') return { path: n.path, name: n.name, isDir: true, leaf: n.leaf, bytes: n.total, t: n.maxT || 0, topExts: topExts(n) };
    return { path: n.path, name: n.name, isDir: false, size: n.size, ext: n.ext, t: n.t || 0 };
  }

  /* ---- coloring + dimming ---- */
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
  const pfKeep = (p) => p === pathFilter || p.startsWith(pathFilter + '/') || pathAnc.has(p);
  function dimOf(v) {
    if (extFilter && !v.isAgg && v.n.type !== 'dir' && !extFilter.has(v.n.ext)) return true;
    if (pathFilter) {
      if (v.isAgg) { const h = v.host.path; if (h !== pathFilter && !h.startsWith(pathFilter + '/')) return true; }
      else if (!pfKeep(v.n.path)) return true;
    }
    return false;
  }

  const resolveV = (p) => { let n = byPath.get(p); while (n && !vByPath.has(n.path)) n = n.parent; return n ? vByPath.get(n.path) : null; };
  function chainOf(path) {
    let n = byPath.get(path);
    while (n && !vByPath.has(n.path)) n = n.parent;
    const v = n && vByPath.get(n.path);
    if (!v) return null;
    const chain = [];
    for (let u = v; u; u = u.parentV) chain.unshift(u);
    return chain.length > 1 ? chain : null;
  }

  /* ---- drawing ---- */
  const inView = (v) => {
    const ext = (v.rect ? Math.max(v.rect.w, v.rect.h) / 2 : v.r) + 40 / cam.k;
    return Math.abs(v.x - cam.x) < W / 2 / cam.k + ext && Math.abs(v.y - cam.y) < H / 2 / cam.k + ext;
  };
  function defaultEdges() {
    g.strokeStyle = withAlpha(THEME.link, 0.5);
    g.lineWidth = 1 / cam.k;
    g.beginPath();
    let any = false;
    for (const v of vis) { if (!v.parentV) continue; if (!inView(v) && !inView(v.parentV)) continue; g.moveTo(v.parentV.x, v.parentV.y); g.lineTo(v.x, v.y); any = true; }
    if (any) g.stroke();
  }
  function defaultNodes() {
    const groups = new Map();
    for (const v of vis) {
      if (!inView(v) || v.grow <= 0) continue;
      const col = colorOf(v), dim = dimOf(v), key = (dim ? 'd' : 'n') + col;
      let gr = groups.get(key);
      if (!gr) groups.set(key, (gr = { col, dim, arr: [] }));
      gr.arr.push(v);
    }
    for (const gr of groups.values()) {
      g.fillStyle = gr.col; g.globalAlpha = gr.dim ? 0.12 : 1;
      g.beginPath();
      for (const v of gr.arr) { const r = v.r * Math.min(1.25, Math.max(0, v.grow)); g.moveTo(v.x + r, v.y); g.arc(v.x, v.y, r, 0, 6.2832); }
      g.fill();
    }
    g.globalAlpha = 1;
  }
  function strokeChain(chain, color, width, alpha) {
    if (!chain || chain.length < 2) return;
    g.strokeStyle = color; g.lineWidth = width / cam.k; g.globalAlpha = alpha; g.lineCap = 'round';
    g.beginPath();
    g.moveTo(chain[0].x, chain[0].y);
    for (let i = 1; i < chain.length; i++) g.lineTo(chain[i].x, chain[i].y);
    g.stroke();
    g.globalAlpha = 1;
  }
  function overlays(now) {
    // path highlights
    if (spotChain) { strokeChain(spotChain, THEME.changed, 1.8, 0.85); const e = spotChain[spotChain.length - 1]; g.strokeStyle = THEME.changed; g.lineWidth = 1.6 / cam.k; g.beginPath(); g.arc(e.x, e.y, e.r + 4 / cam.k, 0, 6.2832); g.stroke(); }
    if (selChain) strokeChain(selChain, trailsCfg().selected, 1.8, 0.9);
    if (hoverV && hoverV.parentV) { const chain = []; for (let u = hoverV; u; u = u.parentV) chain.unshift(u); strokeChain(chain, trailsCfg().hover, 1.4, 0.6); }
    // live agent activity — glow + path to root
    if (activity.size) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 360);
      for (const [p, a] of activity) {
        const v = resolveV(p); if (!v || !inView(v)) continue;
        const col = a.op === 'edit' ? trailsCfg().edit : trailsCfg().read;
        const ch = chainOf(p); strokeChain(ch, col, 1.6, 0.5 + 0.3 * pulse);
        g.fillStyle = col; g.globalAlpha = 0.25 + 0.25 * pulse;
        g.beginPath(); g.arc(v.x, v.y, v.r + (5 + 4 * pulse) / cam.k, 0, 6.2832); g.fill();
        g.globalAlpha = 1;
      }
    }
    // completed (green ring), dirty (amber ring), task dots, pins, hover ring
    if (completed.size) { g.strokeStyle = THEME.success; g.lineWidth = 1.4 / cam.k; g.beginPath(); for (const p of completed) { const v = vByPath.get(p); if (!v || !inView(v)) continue; g.moveTo(v.x + v.r + 2.4, v.y); g.arc(v.x, v.y, v.r + 2.4, 0, 6.2832); } g.stroke(); }
    if (dirtySet.size) {
      const breath = 0.5 + 0.5 * Math.sin(now / 1200);
      g.strokeStyle = THEME.changed; g.lineWidth = 2 / cam.k; g.globalAlpha = 0.35 + 0.3 * breath;
      g.beginPath(); let dn = 0;
      for (const p of dirtySet) { if (dn++ >= 80) break; const v = resolveV(p); if (!v || !inView(v)) continue; const r = v.r + (4 + 4 * breath) / cam.k; g.moveTo(v.x + r, v.y); g.arc(v.x, v.y, r, 0, 6.2832); }
      g.stroke(); g.globalAlpha = 1;
    }
    if (taskMarks.size) { g.fillStyle = THEME.changed; g.beginPath(); for (const p of taskMarks.keys()) { const v = resolveV(p); if (!v || !inView(v)) continue; const r = Math.max(2.2 / cam.k, v.r * 0.3), ox = v.r * 0.8 + r; g.moveTo(v.x + ox + r, v.y - ox); g.arc(v.x + ox, v.y - ox, r, 0, 6.2832); } g.fill(); }
    if (pinSet.size) { g.fillStyle = THEME.accent; g.beginPath(); for (const p of pinSet) { const v = resolveV(p); if (!v || !inView(v)) continue; const r = Math.max(2 / cam.k, v.r * 0.25), oy = v.r + 3 / cam.k + r; g.moveTo(v.x + r, v.y - oy); g.arc(v.x, v.y - oy, r, 0, 6.2832); } g.fill(); }
    if (hoverV) { g.strokeStyle = THEME.accent; g.lineWidth = 1.6 / cam.k; g.beginPath(); const hr = (hoverV.rect ? Math.max(hoverV.rect.w, hoverV.rect.h) / 2 : hoverV.r) + 3 / cam.k; g.beginPath(); g.arc(hoverV.x, hoverV.y, hr, 0, 6.2832); g.stroke(); }
  }
  function drawLabels() {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cands = [];
    for (const v of vis) {
      if (!inView(v) || v.grow < 0.9 || dimOf(v)) continue;
      const isDir = v.isAgg || v.n.type === 'dir';
      const sr = (v.rect ? Math.min(v.rect.w, v.rect.h) * cam.k / 2 : v.r * cam.k);
      if (sr < (isDir ? 6 : 4.5)) continue;
      cands.push([isDir ? sr + 1000 : sr, v, isDir]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    g.textBaseline = 'middle';
    const placed = []; let shown = 0;
    for (const [, v, isDir] of cands) {
      if (shown >= LABEL_CAP) break;
      const [sx, sy] = screenOf(v.x, v.y);
      const label = v.isAgg ? '+' + v.aggCount.toLocaleString() : v.n.name + (isDir ? '/' : '');
      g.font = (isDir ? '600 11px ' : '10px ') + THEME.mono;
      const off = v.rect ? 0 : v.r * cam.k + 5;
      const lx = v.rect ? sx - g.measureText(label).width / 2 : sx + off;
      const lw = g.measureText(label).width;
      const box = [lx - 2, sy - 7, lx + lw + 2, sy + 7];
      let hit = false;
      for (const b of placed) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) { hit = true; break; }
      if (hit) continue;
      placed.push(box); shown++;
      g.lineWidth = 3; g.strokeStyle = THEME.labelHalo; g.strokeText(label, lx, sy);
      g.fillStyle = isDir ? THEME.labelDir : THEME.labelFile; g.fillText(label, lx, sy);
    }
  }
  function draw(now) {
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!visRoot) return;
    setWorld();
    const api = { vis, cam, colorOf, withAlpha, dimOf, inView, THEME, GalaxyCore, screenOf, heatOn: () => heatOn };
    if (cfg.drawWorld) cfg.drawWorld(g, api);
    else { defaultEdges(); defaultNodes(); }
    overlays(now);
    drawLabels();
  }

  /* ---- rAF loop ---- */
  function stepCam(now) {
    const a = camAnim, p = Math.min(1, (now - a.t0) / a.dur), e = easeIO(p);
    cam.x = a.x0 + (a.x1 - a.x0) * e; cam.y = a.y0 + (a.y1 - a.y0) * e; cam.k = Math.exp(a.l0 + (a.l1 - a.l0) * e);
    if (p >= 1) camAnim = null;
    dirty = true;
  }
  function stepTween(now) {
    const p = Math.min(1, (now - tweenT0) / 360), e = easeIO(p);
    for (const v of vis) { v.x = v.sx + (v.tx - v.sx) * e; v.y = v.sy + (v.ty - v.sy) * e; }
    dirty = true;
    if (p >= 1) { tweenT0 = 0; for (const v of vis) { v.x = v.tx; v.y = v.ty; } }
  }
  function frame(now) {
    if (!running) return;
    try {
      let busy = false;
      if (camAnim) { stepCam(now); busy = true; }
      if (tweenT0) { stepTween(now); busy = true; }
      const liveFx = activity.size > 0 || dirtySet.size > 0;
      if (dirty || liveFx) { draw(now); dirty = false; }
      if (busy || liveFx) requestAnimationFrame(frame);
      else running = false;
    } catch (err) { running = false; console.error('FlatViz(' + id + ') frame error:', err); }
  }
  function wake() { if (running || !g || !visible) return; running = true; requestAnimationFrame(frame); }

  /* ---- data load ---- */
  function showEmpty(msg) {
    let d = shell && shell.querySelector('.viz-empty');
    if (shell && !d) { d = document.createElement('div'); d.className = 'viz-empty'; shell.appendChild(d); }
    if (d) d.innerHTML = msg;
    tree = null; visRoot = null; vis = []; grid = new Map(); vByPath = new Map();
    if (g) { g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); }
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
      if (shell) shell.querySelector('.viz-empty')?.remove();
      stats = data.stats; hasHeat = heatOn;
      if (!keepMarks) { completed.clear(); activity.clear(); }
      byPath = new Map();
      tree = buildTree(data); annotate(tree, null, 0); defaultExpansion();
      if (countEl) countEl.textContent = `${stats.files.toLocaleString()} files · ${fmtB(stats.bytes)}`;
      relayout({ tween: !firstLoad });
      if (firstLoad) { const f = fitParams(); fitK = f.k; cam.x = f.x; cam.y = f.y; cam.k = f.k; firstLoad = false; }
      dirty = true; wake();
    } finally { loading = false; if (queued) { queued = false; load(false, true); } }
  }

  /* ---- theme ---- */
  function retheme(next) {
    next = next || {};
    if (next.palGroups) { next = { ...next, pal: expandPal(next.palGroups) }; delete next.palGroups; }
    Object.assign(THEME, next);
    HEAT = buildHeat(THEME.heatStops);
    dirty = true; wake();
  }

  /* ---- input ---- */
  function xy(e) { const r = shell.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function stageXY(e) { const r = $id('stage').getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function onHover(sx, sy) {
    const v = pick(sx, sy);
    if (v !== hoverV) {
      hoverV = v; dirty = true; wake();
      shell.style.cursor = v ? 'pointer' : 'grab';
      if (hoverCb) hoverCb(v ? { path: v.isAgg ? v.host.path : v.n.path, isDir: v.isAgg || v.n.type === 'dir' } : null);
    }
    if (!pinned) { if (v) showTip(v, sx, sy); else hideTip(); }
  }
  function onClick(sx, sy, e) {
    const v = pick(sx, sy);
    if (!v) { pinned = false; hideTip(); if (menuCb) menuCb(null); if (fileClickCb) fileClickCb(null); return; }
    if (v.isAgg) { userView = true; const t = v.parentV || v; animateCam(t.tx, t.ty, Math.min(8, cam.k * 1.8), 480); return; }
    if (v.n.type === 'dir') {
      userView = true;
      if (!expanded.has(v.n) && v.n.children.length) { expanded.add(v.n); evictFor(v.n); relayout({ tween: true }); }
      const tgt = vByPath.get(v.n.path) || v;
      animateCam(tgt.tx, tgt.ty, Math.min(8, Math.max(cam.k, fitK * 2)), 520);
      return;
    }
    if (menuCb) { hideTip(); const [mx, my] = stageXY(e); menuCb(nodeInfo(v), mx, my); return; }
    if (fileClickCb) { hideTip(); fileClickCb(v.n.path); return; }
  }
  function bind() {
    shell.addEventListener('wheel', (e) => { e.preventDefault(); camAnim = null; const [sx, sy] = xy(e); zoomAt(sx, sy, Math.exp(-e.deltaY * 0.0015)); if (!pinned) hideTip(); }, { passive: false });
    shell.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      if (e.target.closest('.viz-legend')) return;
      shell.setPointerCapture(e.pointerId);
      const [sx, sy] = xy(e);
      pointers.set(e.pointerId, { x: sx, y: sy });
      if (pointers.size === 1) { drag = { moved: false }; camAnim = null; }
      shell.classList.add('dragging');
    });
    shell.addEventListener('pointermove', (e) => {
      const [sx, sy] = xy(e), pt = pointers.get(e.pointerId);
      if (!pt) { onHover(sx, sy); return; }
      if (pointers.size === 2) {
        const other = [...pointers.entries()].find(([pid]) => pid !== e.pointerId)[1];
        const d0 = Math.hypot(pt.x - other.x, pt.y - other.y), d1 = Math.hypot(sx - other.x, sy - other.y);
        if (d0 > 8) zoomAt((sx + other.x) / 2, (sy + other.y) / 2, d1 / d0);
        if (drag) drag.moved = true;
      } else if (drag) {
        cam.x -= (sx - pt.x) / cam.k; cam.y -= (sy - pt.y) / cam.k;
        if (Math.abs(sx - pt.x) + Math.abs(sy - pt.y) > 3) { drag.moved = true; userView = true; pinned = false; hideTip(); }
        dirty = true; wake();
      }
      pointers.set(e.pointerId, { x: sx, y: sy });
    });
    const up = (e) => {
      const had = pointers.delete(e.pointerId);
      if (!pointers.size) shell.classList.remove('dragging');
      if (!had) return;
      if (drag && !drag.moved && e.type === 'pointerup') { const [sx, sy] = xy(e); onClick(sx, sy, e); }
      if (!pointers.size) drag = null;
    };
    shell.addEventListener('pointerup', up);
    shell.addEventListener('pointercancel', up);
    shell.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.viz-legend')) return;
      e.preventDefault();
      const [sx, sy] = xy(e), v = pick(sx, sy);
      pinned = false; hideTip();
      if (menuCb) { const [mx, my] = stageXY(e); menuCb(v && !(!v.isAgg && v.n.depth === 0) ? nodeInfo(v) : null, mx, my); }
    });
    shell.addEventListener('dblclick', () => { userView = false; fit(500); });
    const btn = (suffix, fn) => { const el = $id('vz-' + id + '-' + suffix); if (el) el.addEventListener('click', fn); };
    btn('zin', () => { userView = true; animateCam(cam.x, cam.y, Math.min(40, cam.k * 1.6), 220); });
    btn('zout', () => { userView = true; animateCam(cam.x, cam.y, Math.max(fitK * 0.4, cam.k / 1.6), 220); });
    btn('fit', () => { userView = false; fit(500); });
    btn('heat', () => (typeof Viz !== 'undefined' ? Viz.toggleHeat() : setHeat(!heatOn)));
    const heatBtn = $id('vz-' + id + '-heat'); if (heatBtn) heatBtn.classList.toggle('on', heatOn);
  }
  function resize() {
    if (!shell) return;
    const r = shell.getBoundingClientRect();
    W = Math.max(60, r.width); H = Math.max(60, r.height); dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    if (!userView && visRoot && !tweenT0) { const f = fitParams(); fitK = f.k; cam.x = f.x; cam.y = f.y; cam.k = f.k; camAnim = null; }
    dirty = true; wake();
  }

  /* ---- public API (matches galaxy.js) ---- */
  function setVisible(on) {
    visible = !!on;
    if (visible) { requestAnimationFrame(() => { resize(); if (!tree) load(false, false); else { dirty = true; wake(); } }); }
  }
  function allPaths() { const out = []; for (const [p, n] of byPath) if (p && n.type === 'file') out.push(p); return out; }
  function flyTo(path) {
    const n = byPath.get(path); if (!n) return false;
    let mutated = false;
    for (let u = n.parent; u; u = u.parent) if (u.type === 'dir' && !expanded.has(u)) { expanded.add(u); mutated = true; }
    if (mutated) { evictFor(n); relayout({ tween: true }); }
    let m = n; while (m && !vByPath.has(m.path)) m = m.parent;
    const v = m && vByPath.get(m.path); if (!v) return false;
    userView = true;
    const k = Math.max(fitK, Math.min(12, 24 / Math.max(2, v.r)));
    const availW = Math.max(120, W - insets.left - insets.right), availH = Math.max(120, H - insets.top - insets.bottom);
    animateCam(v.tx - (insets.left + availW / 2 - W / 2) / k, v.ty - (insets.top + availH / 2 - H / 2) / k, k, 600);
    return true;
  }
  function spotlight(path) { spotPath = path || null; spotChain = spotPath ? chainOf(spotPath) : null; dirty = true; wake(); }
  function setSelected(path) { selPath = path || null; selChain = selPath ? chainOf(selPath) : null; dirty = true; wake(); }
  function setExtFilter(exts) { extFilter = exts && exts.size ? exts : null; dirty = true; wake(); }
  function setPathFilter(prefix) {
    pathFilter = prefix || null; pathAnc = null;
    if (pathFilter) { pathAnc = new Set(['']); let acc = ''; for (const seg of pathFilter.split('/')) { acc = acc ? acc + '/' + seg : seg; pathAnc.add(acc); } }
    dirty = true; wake();
  }
  function setTaskMarks(list) { taskMarks = new Map((list || []).map((m) => [m.file, m])); dirty = true; wake(); }
  function setPins(set) { pinSet = new Set(set || []); dirty = true; wake(); }
  function setDirty(list) { dirtySet = new Set(list || []); dirty = true; wake(); }
  function fileActivity(path, op) {
    if (!g || !path) return;
    const prev = activity.get(path);
    const next = prev?.op === 'edit' ? 'edit' : (op === 'edit' ? 'edit' : 'read');
    activity.set(path, { op: next, t: performance.now() });
    dirty = true; wake();
  }
  function runStarted() { active++; }
  function runEnded(ok) {
    if (active) active--;
    if (ok === true) for (const p of activity.keys()) completed.add(p);
    activity.clear();
    dirty = true; wake();
  }
  async function setHeat(on) {
    on = !!on;
    const heatBtn = $id('vz-' + id + '-heat'); if (heatBtn) heatBtn.classList.toggle('on', on);
    if (heatOn === on) return;
    heatOn = on;
    if (!g) return;
    if (heatOn && !hasHeat) await load(false, true);
    dirty = true; wake();
  }
  function setInsets(next) {
    const n = { ...insets, ...next };
    if (n.left === insets.left && n.right === insets.right && n.top === insets.top && n.bottom === insets.bottom) return;
    insets = n;
    if (!visRoot || userView) return;
    const f = fitParams(); fitK = f.k; cam.x = f.x; cam.y = f.y; cam.k = f.k; camAnim = null; dirty = true; wake();
  }
  function init() {
    shell = $id('vshell-' + id); canvas = $id('vcanvas-' + id);
    if (!shell || !canvas) return;
    g = canvas.getContext('2d');
    tip = $id('vtip-' + id); legendEl = $id('vlegend-' + id); countEl = $id('vcount-' + id);
    new ResizeObserver(resize).observe(shell);
    resize(); bind();
    if (visible) load(false, false);
  }

  return {
    init, setVisible, reload: () => load(false, false), runStarted, runEnded, retheme, setInsets, resize,
    allPaths, flyTo, spotlight, setExtFilter, setHeat, setPathFilter, setTaskMarks, setPins, setDirty,
    setSelected, fileActivity,
    onHoverChange: (fn) => { hoverCb = fn; }, onFileClick: (fn) => { fileClickCb = fn; }, onNodeMenu: (fn) => { menuCb = fn; },
    langStats: () => (stats && stats.langs) || {},
    debug: () => ({ id, cam: { ...cam }, vis: vis.length, W, H, visible }),
  };
}
