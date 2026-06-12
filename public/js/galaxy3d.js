/* galaxy3d.js — Repo3D: the repo galaxy in true 3D.
   A WebGL2 scene (via gl3d.js) that mirrors RepoViz's contract: same data
   endpoint, same theme tokens (retheme), same run hooks (runStarted/runEnded,
   status polling), same insets. Three deterministic layouts — spiral / shells
   / clusters — morph into each other; every node knows where it came FROM and
   where it's going TO, so intros and layout switches are one GPU uniform.
   Labels + tooltip are a 2D overlay canvas; picking is CPU projection.
   All spectacle (bloom, god rays, bokeh DoF, trails, nebulae) gates on the
   Quality dial and retints from the live theme. */
const Repo3D = (() => {
  const CAP = 4000, CHILD_CAP = 96, LABEL_BASE = 90;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const MORPH_MS = REDUCED ? 500 : 2400;

  /* per-quality budgets: counts, post strengths, render scale */
  const QCFG = [
    { stars: 1600, dust: 0, neb: 0, b1: 0, b2: 0, ray: 0, dof: 0, shim: 0, wob: 0, trail: 0, dpr: 1.25, grain: 0 },
    { stars: 4500, dust: 600, neb: 0.55, b1: 0.55, b2: 0.4, ray: 0, dof: 0, shim: 0, wob: 0.45, trail: 0.6, dpr: 1.25, grain: 0.008 },
    { stars: 9000, dust: 1600, neb: 1, b1: 0.9, b2: 0.65, ray: 0.55, dof: 0.9, shim: 0.45, wob: 1, trail: 1, dpr: 1.5, grain: 0.012 },
    { stars: 15000, dust: 3200, neb: 1.4, b1: 1.05, b2: 0.85, ray: 0.85, dof: 1.1, shim: 0.85, wob: 1.35, trail: 1.7, dpr: 2, grain: 0.014 },
  ];
  const q = () => (typeof Quality !== 'undefined' ? Quality.level() : 2);
  const QC = () => QCFG[q()];

  /* ----- theme (defaults = Mission Control; theme.js overwrites via retheme) ----- */
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
  let probeEl = null;
  function cssRGB(expr) { // resolve any CSS color expr -> [r,g,b] 0..1
    if (!probeEl) { probeEl = document.createElement('i'); probeEl.style.display = 'none'; document.body.appendChild(probeEl); }
    probeEl.style.color = ''; probeEl.style.color = expr;
    const m = (getComputedStyle(probeEl).color.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    return [m[0] / 255, m[1] / 255, m[2] / 255];
  }
  const hex3 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const brite = (c, k = 0.55) => c.map((v) => v + (1 - v) * k);
  function expandPal(groups) {
    const pal = {};
    for (const [g, exts] of Object.entries(EXT_GROUPS)) for (const e of exts) pal[e] = groups[g];
    return pal;
  }
  const PAL_HEX_DEFAULT = {
    dir: '#4fd1c5', ts: '#8ab4ff', tsx: '#5e8fe6', js: '#e6cf6f', jsx: '#cdb45c',
    script: '#3fb66e', data: '#e0a33e', style: '#c08bff', markup: '#e0614b',
    docs: '#8c95a3', sql: '#d678b6', image: '#5dbb8f', config: '#7d8aa0',
    native: '#d98a68', other: '#5c6470',
  };
  let palHex = expandPal(PAL_HEX_DEFAULT); // hex mirror of TH.pal — legend swatches paint HTML, not GL
  const TH = {
    pal: expandPal(Object.fromEntries(Object.entries(PAL_HEX_DEFAULT).map(([g, h]) => [g, hex3(h)]))),
    link: hex3('#565f6e'), accent: hex3('#4fd1c5'),
    changed: hex3('#e0a33e'), deleted: hex3('#e0614b'), success: hex3('#3fb66e'),
    comet: hex3('#e0a33e'), cometHead: hex3('#e8c069'),
    changedHex: '#e0a33e', successHex: '#3fb66e',
    labelDir: '#c7d2d0', labelFile: 'rgba(150,159,173,0.95)', labelHalo: 'rgba(20,23,28,0.85)',
    mono: 'ui-monospace,"SF Mono",Menlo,monospace', fxAlpha: 1,
    neb1: hex3('#5e8fe6'), neb2: hex3('#4fd1c5'), neb3: hex3('#2b3a6e'), nebAlpha: 0.16,
    star1: hex3('#cdd6e4'), star2: hex3('#7f8aa0'), starDensity: 1,
    core: hex3('#ffffff'), ring: hex3('#4fd1c5'),
    bg: hex3('#10131a'), light: 0,
    heatEmpty: hex3('#3a4150'),
    wave: hex3('#ff7a5c'), waveHex: '#ff7a5c', // shockwave front — theme.js hands over the accent's complement
  };
  function buildHeat3(stopsHex) { // 32-step vec3 ramp lerped between the 5 stops (mirrors galaxy.js)
    const stops = stopsHex.map(hex3);
    return Array.from({ length: 32 }, (_, i) => {
      const t = (i / 31) * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(t)), f = t - a;
      return stops[a].map((v, j) => v + (stops[a + 1][j] - v) * f);
    });
  }
  let HEAT3 = buildHeat3(['#ecb24c', '#c48642', '#786a58', '#4a5260', '#343b47']); // recent → old

  /* ----- tweaks (drawer sliders; viz-mode.js persists + pushes these) ----- */
  const TW = {
    fov: 55, drift: 1, inertia: 0.86,
    neb: 1, stars: 1, bloom: 1,
    twist: 1.2, spread: 1, thick: 1,
    nodeSize: 1, labels: 1,
  };

  /* ----- state ----- */
  let shell, glC, lbC, lctx, tip, tickerEl, countEl;
  let env = null; // { gl, hdr, T, P, post } from GL3D.boot
  let W = 0, H = 0, dprL = 1, dprGL = 1;
  let visible = false, running = false, lastT = 0, timeS = 0;
  let insets = { left: 0, right: 0, top: 0, bottom: 0 };
  let tree = null, byPath = new Map(), vis = [], vByPath = new Map(), statTxt = '';
  let layoutMode = localStorage.getItem('wl.g3d.layout') || 'spiral';
  let boundR = 300, fitR = 300, fitD = 700;
  let morphT0 = -1e9, posSettled = false, ready = false;
  let stats = null, hasHeat = false, heatOn = localStorage.getItem('wl.heat') === '1';
  let extFilter = null, spotPath = null, spotV = null;
  let hoverCb = null, fileClickCb = null, menuCb = null;
  let pathFilter = null, pathAnc = null;
  let taskMarks = [], markVs = [], pinPaths = new Set(), pinVs = [];
  let dirtyPaths = new Set(), dirtyVs = []; // uncommitted files — slow alert ring
  let selectedPath = null, selV = null; // node-menu selection — blue trail
  const activity = new Map(); // path -> { op: 'read'|'edit', t } — live agent tool attribution
  let doneFlashUntil = 0; // run finished: hold streams in the done color, then retract
  const TRAILS_DEF = { hover: '#3b82f6', selected: '#3b82f6', read: '#ff9f43', edit: '#ff4d4d', done: '#22c55e', holdMs: 2000 };
  const tc3 = (k) => (typeof Trails !== 'undefined' ? Trails.c3(k) : hex3(TRAILS_DEF[k]));
  const trailsCfg = () => (typeof Trails !== 'undefined' ? Trails.cfg : TRAILS_DEF);
  const dirtyWaves = []; // light-bending shockwaves rippling out from dirty nodes
  let lastWaveCyc = -1;
  const waveU = new Float32Array(16); // 4 × vec4 uniform scratch
  const PING_DEF = { on: true, every: 7, sweep: 3.6, width: 1, power: 1 };
  const pingCfg = () => (typeof Ping !== 'undefined' ? Ping.cfg : PING_DEF); // Appearance sliders
  let loading = false, queued = false, srcByPath = null, lastHead = null;
  let legendEl = null;

  // typed mirrors (length = vis.length)
  let aFrom, aTo, aColor, aMeta, posNow;
  let linkFrom, linkTo, linkColor, linkMeta, linkN = 0, linkVerts = 0;
  let B = null; // gl buffers + vaos

  const cam = { yaw: -0.6, pitch: 0.42, dist: 700, tg: [0, 0, 0], vyaw: 0, vpitch: 0 };
  let camAnim = null, vp = null, vpCPU = null, eye = [0, 0, 1], focusD = 700, lastInput = 0, driftOn = true;
  let hoverV = null, pinned = false, drag = null;
  const pointers = new Map();

  let active = 0, pollTimer = null;
  const changed = new Map(); // path -> { idx, kind, t0 }
  const comets = [], pulses = [], trail = [];
  const TRAIL_MAX = 4096;

  /* ----- small helpers ----- */
  const hash01 = (p) => { let h = 0; for (let i = 0; i < p.length; i++) h = (h * 31 + p.charCodeAt(i)) >>> 0; return (h % 9973) / 9973; };
  const rnd = (i, salt) => { // well-mixed integer hash — sequential i must NOT correlate
    let x = ((i + 1) * 374761393 + salt * 668265263) >>> 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    x = (x ^ (x >>> 16)) >>> 0;
    return x / 4294967296;
  };
  const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const fmtB = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B';
  const gauss = (a, b) => (a + b - 1) * 1.2; // two hashes -> approx normal

  /* ----- data: same payload as RepoViz ----- */
  function buildTree(data) {
    byPath = new Map();
    const name = (data.repo || 'repo').split('/').filter(Boolean).pop() || 'repo';
    const root = { name, path: '', type: 'dir', kids: new Map() };
    const dirAt = (parts) => {
      let cur = root, acc = '';
      for (const part of parts) {
        acc = acc ? acc + '/' + part : part;
        let d = cur.kids.get(part);
        if (!d || d.type !== 'dir') { d = { name: part, path: acc, type: 'dir', kids: new Map() }; cur.kids.set(part, d); }
        cur = d;
      }
      return cur;
    };
    for (const f of data.files || []) {
      const parts = f.p.split('/'), base = parts.pop();
      const dir = parts.length ? dirAt(parts) : root;
      dir.kids.set(base, { name: base, path: f.p, type: 'file', size: f.s, t: f.t });
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
    if (n.type === 'dir') {
      n.children = [...n.kids.values()];
      n.leaf = 0; n.bytes = 0; n.maxT = 0;
      for (const k of n.children) {
        annotate(k, n, depth + 1);
        n.leaf += k.type === 'dir' ? k.leaf : 1;
        n.bytes += k.type === 'dir' ? k.bytes : k.size;
        n.maxT = Math.max(n.maxT, k.type === 'dir' ? k.maxT : (k.t || 0));
      }
      if (n.aggN) { n.leaf += n.aggN; n.bytes += n.aggS || 0; }
      n.children.sort((a, b) =>
        (b.type === 'dir' ? b.leaf * 4096 + b.bytes : b.size) - (a.type === 'dir' ? a.leaf * 4096 + a.bytes : a.size));
    }
  }
  function buildVis() { // greedy expansion under the node budget, overflow -> agg node
    vis = []; vByPath = new Map();
    const expanded = new Set([tree]);
    let count = 1 + Math.min(tree.children.length, CHILD_CAP);
    const heap = tree.children.filter((c) => c.type === 'dir');
    heap.sort((a, b) => b.leaf - a.leaf);
    while (heap.length) {
      const d = heap.shift();
      const add = Math.min(d.children.length, CHILD_CAP) + 1;
      if (count + add > CAP) continue;
      count += add;
      expanded.add(d);
      for (const c of d.children) if (c.type === 'dir') heap.push(c);
      heap.sort((a, b) => b.leaf - a.leaf);
    }
    const rOf = (n, kind, aggN) => {
      if (kind === 2) return clamp(4.5 + Math.log2(1 + aggN), 3, 9) * 1;
      if (n.type === 'dir') return clamp(4 + 1.25 * Math.log2(1 + n.leaf), 4, 11.5);
      return clamp(1.5 + 1.05 * Math.log2(1 + n.size / 1500), 1.5, 6.2);
    };
    const mk = (n, parentV) => {
      const kind = n.type === 'dir' ? 1 : 0;
      const v = {
        n, parentV, kind, depth: n.depth,
        r: rOf(n, kind), seed: hash01(n.path || '@root'),
        ext: kind ? 'dir' : (extOf(n.name) || 'other'),
        pos: [0, 0, 0], clusterR: 18, idx: vis.length,
      };
      vis.push(v); vByPath.set(n.path, v);
      if (kind && expanded.has(n)) {
        v.kids = [];
        const list = n.children.slice(0, CHILD_CAP);
        for (const c of list) v.kids.push(mk(c, v));
        const over = n.children.length - list.length + (n.aggN || 0);
        if (over > 0) {
          const a = {
            n: { name: '+' + over, path: n.path + '/*', type: 'file', size: 0 }, parentV: v, kind: 2,
            depth: n.depth + 1, r: rOf(null, 2, over), seed: hash01(n.path + '/*'), ext: 'other',
            pos: [0, 0, 0], clusterR: 10, idx: vis.length, aggN: over,
          };
          vis.push(a); v.kids.push(a);
        }
      } else if (kind) v.folded = true;
      return v;
    };
    mk(tree, null);
  }

  /* ----- layouts: fill v.pos (target), v.clusterR ----- */
  const fib = (j, M) => { // unit fibonacci sphere
    const y = 1 - (2 * (j + 0.5)) / M, r = Math.sqrt(Math.max(0, 1 - y * y)), p = j * 2.399963;
    return [r * Math.cos(p), y, r * Math.sin(p)];
  };
  function layoutSpiral() {
    const root = vis[0];
    root.pos = [0, 0, 0];
    const kids = root.kids || [];
    const dirs = kids.filter((v) => v.kind === 1).sort((a, b) => (b.n.leaf || 0) - (a.n.leaf || 0));
    const arms = dirs.filter((d, i) => i < 6 && (d.n.leaf || 0) >= 10);
    const small = dirs.filter((d) => !arms.includes(d));
    const rest = kids.filter((v) => v.kind !== 1);
    rest.forEach((v, i) => { // root files: the bulge
      const a = i * 2.39996 + v.seed, r = (22 + i * 2.8) * TW.spread;
      v.pos = [r * Math.cos(a), gauss(v.seed, hash01(v.n.path + 'y')) * 6 * TW.thick, r * Math.sin(a)];
    });
    const mini = (d, c, R) => { // compact sub-cluster for off-arm dirs
      (d.kids || []).forEach((k, j, arr) => {
        const f = fib(j, arr.length), rr = R * (0.6 + 0.55 * k.seed);
        k.pos = [c[0] + f[0] * rr, c[1] + f[1] * rr * 0.6 * Math.max(0.25, TW.thick), c[2] + f[2] * rr];
        if (k.kids) mini(k, k.pos, R * 0.7);
      });
    };
    small.forEach((d, i) => { // small dirs: globular clusters orbiting the bulge
      const a = i * 2.39996 + 0.9, r = (74 + 24 * (i % 3)) * TW.spread;
      d.pos = [r * Math.cos(a), gauss(d.seed, hash01(d.n.path + 'y')) * 12 * TW.thick, r * Math.sin(a)];
      mini(d, d.pos, (15 + 2.4 * Math.sqrt(d.n.leaf || 1)) * TW.spread);
    });
    const nA = Math.max(2, arms.length);
    let maxW = 1;
    for (const a of arms) maxW = Math.max(maxW, a.n.leaf || 1);
    arms.forEach((arm, i) => {
      const phi0 = (i / nA) * 6.2832 + 0.4;
      const order = []; // beads along the arm, in tree order
      let s = 0;
      const walk = (d) => {
        order.push([d, s += 12, true]);
        for (const c of d.kids || []) {
          if (c.kind === 1 && c.kids) walk(c);
          else order.push([c, s += 4.6, false]);
        }
        s += 8;
      };
      walk(arm);
      const total = Math.max(1, s);
      const wgt = Math.sqrt((arm.n.leaf || 1) / maxW); // arms scale with weight, not raw count
      const armLen = (170 + 300 * wgt) * TW.spread;
      const turns = (1.5 + 1.3 * wgt) * TW.twist;
      for (const [v, sv, isDir] of order) {
        const t = sv / total;
        const r = 64 * TW.spread + Math.pow(t, 0.88) * armLen;
        const ang = phi0 + turns * Math.pow(t, 0.85);
        const h1 = v.seed, h2 = hash01(v.n.path + 'b'), h3 = hash01(v.n.path + 'c');
        const w = 8 + 30 * t; // the arm widens as it sweeps outward
        const perp = isDir ? gauss(h1, h2) * 3 : gauss(h1, h2) * w * 0.6;
        const along = isDir ? 0 : gauss(h2, h3) * w * 0.45;
        const y = gauss(h3, h1) * TW.thick * (3 + w * 0.5);
        const ca = Math.cos(ang), sa = Math.sin(ang);
        v.pos = [r * ca - perp * sa + along * ca, y, r * sa + perp * ca + along * sa];
      }
    });
  }
  function layoutShells() {
    const root = vis[0];
    root.pos = [0, 0, 0]; root.dirv = [0, 1, 0];
    const place = (v) => {
      const kids = v.kids || [];
      const M = kids.length;
      kids.forEach((c, j) => {
        let nd;
        if (v.depth === 0) { const f = fib(j, M); nd = [f[0], f[1] * 0.82, f[2]]; }
        else {
          const d = v.dirv;
          const ax = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          let t1 = [d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]];
          const l1 = Math.hypot(...t1); t1 = t1.map((x) => x / l1);
          const t2 = [d[1] * t1[2] - d[2] * t1[1], d[2] * t1[0] - d[0] * t1[2], d[0] * t1[1] - d[1] * t1[0]];
          const A = 0.3 + 0.95 * Math.pow(0.8, v.depth - 1);
          const ca = 1 - ((j + 0.5) / M) * (1 - Math.cos(A)), sa = Math.sqrt(Math.max(0, 1 - ca * ca));
          const phi = j * 2.399963 + v.seed * 6.2832;
          nd = [0, 1, 2].map((k) => d[k] * ca + t1[k] * sa * Math.cos(phi) + t2[k] * sa * Math.sin(phi));
        }
        const L = Math.hypot(...nd); nd = nd.map((x) => x / L);
        const R = (v.depth === 0 ? 105 : 88 * Math.pow(0.9, v.depth - 1)) * TW.spread * (0.9 + 0.2 * hash01(c.n.path + 'r'));
        c.pos = [v.pos[0] + nd[0] * R, v.pos[1] + nd[1] * R * (0.55 + 0.45 * TW.thick), v.pos[2] + nd[2] * R];
        c.dirv = nd;
        if (c.kids) place(c);
      });
    };
    place(root);
  }
  function layoutClusters() {
    const root = vis[0];
    const R = (v) => { // bottom-up packing radius
      if (v.R) return v.R;
      if (!v.kids || !v.kids.length) { v.R = v.r * 1.5; return v.R; }
      let s = 0, mx = 0;
      for (const c of v.kids) { const cr = R(c); s += cr * cr; mx = Math.max(mx, cr); }
      v.R = Math.max(12, Math.sqrt(s) * 1.9 + mx * 0.4);
      return v.R;
    };
    R(root);
    root.pos = [0, 0, 0];
    const place = (v) => {
      const kids = v.kids || [];
      const M = kids.length;
      kids.forEach((c, j) => {
        const f = fib(j, M);
        const rot = v.seed * 6.2832, cs = Math.cos(rot), sn = Math.sin(rot);
        const d = [f[0] * cs - f[2] * sn, f[1] * (0.62 + 0.38 * TW.thick), f[0] * sn + f[2] * cs];
        const dist = (v.depth === 0 ? v.R * 0.36 + c.R + 16 : v.R * 0.62 + c.R * 0.55) * TW.spread;
        c.pos = [v.pos[0] + d[0] * dist, v.pos[1] + d[1] * dist, v.pos[2] + d[2] * dist];
        if (c.kids) place(c);
      });
    };
    place(root);
  }
  function runLayout() {
    if (layoutMode === 'shells') layoutShells();
    else if (layoutMode === 'clusters') layoutClusters();
    else layoutSpiral();
    const radii = vis.map((v) => Math.hypot(...v.pos)).sort((a, b) => a - b);
    boundR = Math.max(80, radii[radii.length - 1] + 30);
    fitR = Math.max(80, radii[Math.floor((radii.length - 1) * 0.94)] + 60); // frame the mass, not the stragglers
    for (const v of vis) { // swoop radius = farthest direct child
      if (!v.kids) continue;
      let m = 24;
      for (const c of v.kids) m = Math.max(m, Math.hypot(c.pos[0] - v.pos[0], c.pos[1] - v.pos[1], c.pos[2] - v.pos[2]));
      v.clusterR = m + 18;
    }
    computeFit();
  }

  /* ----- curved links: a gentle radial arc between two nodes ----- */
  const LSEG = 8;
  function curvePt(a, b, t) {
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, mz = (a[2] + b[2]) / 2;
    const rm = Math.hypot(mx, my, mz) || 1;
    const want = (Math.hypot(a[0], a[1], a[2]) + Math.hypot(b[0], b[1], b[2])) / 2;
    const k = Math.min(2.2, Math.max(1, want / rm)); // sagging chords bow back out around the core
    const cx = mx * k, cy = my * k, cz = mz * k;
    const u = 1 - t;
    return [u * u * a[0] + 2 * u * t * cx + t * t * b[0],
      u * u * a[1] + 2 * u * t * cy + t * t * b[1],
      u * u * a[2] + 2 * u * t * cz + t * t * b[2]];
  }
  // one curved edge -> LSEG line segments; sample seeds are deterministic so
  // streams drawn later land exactly on top of their link
  function emitEdge(par, ch, col, f, t, c, m, vtx) {
    const fp = [aFrom[par.idx * 3], aFrom[par.idx * 3 + 1], aFrom[par.idx * 3 + 2]];
    const fc = [aFrom[ch.idx * 3], aFrom[ch.idx * 3 + 1], aFrom[ch.idx * 3 + 2]];
    const tp = par.pos, tc = ch.pos;
    const delay = Math.min(0.7, ch.depth * 0.13 + ch.seed * 0.12);
    let prevF = null, prevT = null, prevS = 0, prevK = 0, prevMix = 0;
    for (let k = 0; k <= LSEG; k++) {
      const tt = k / LSEG;
      const sF = curvePt(fp, fc, tt), sT = curvePt(tp, tc, tt);
      const seed = k === 0 ? par.seed : k === LSEG ? ch.seed : rnd(k, ch.idx);
      const kind = k === 0 ? par.kind : ch.kind;
      if (k > 0) {
        for (const [pF, pT, sd, kn, mx] of [[prevF, prevT, prevS, prevK, prevMix], [sF, sT, seed, kind, tt]]) {
          const o3 = vtx.i * 3, o4 = vtx.i * 4;
          f.set(pF, o3); t.set(pT, o3); c.set(col, o3);
          m[o4] = delay; m[o4 + 1] = sd; m[o4 + 2] = mx; m[o4 + 3] = kn;
          vtx.i++;
        }
      }
      prevF = sF; prevT = sT; prevS = seed; prevK = kind; prevMix = tt;
    }
  }

  /* ----- node colors: one source of truth for buffers + recolors ----- */
  function nodeColor(v) { // heat ramp / palette; agg nodes stay dir-colored (2D parity)
    if (v.kind === 2) return TH.pal.dir;
    if (heatOn) {
      const t = v.kind === 1 ? v.n.maxT : v.n.t;
      if (!t) return TH.heatEmpty;
      const age = (Date.now() / 1000 - t) / (90 * 86400);
      return HEAT3[Math.min(31, Math.round(Math.sqrt(Math.max(0, Math.min(1, age))) * 31))];
    }
    if (v.kind === 1) return TH.pal.dir;
    return TH.pal[v.ext] || TH.pal.other;
  }
  const pfKeep3 = (p) => p === pathFilter || p.startsWith(pathFilter + '/') || pathAnc.has(p);
  const isDim = (v) => {
    if (extFilter && v.kind === 0 && !extFilter.has(v.ext)) return true;
    // focus: agg paths are "host/*", so the same prefix test covers files, dirs AND agg
    if (pathFilter && !pfKeep3(v.n.path)) return true;
    return false;
  };
  function linkCol(v) { // a link wears its child's tint, dimmed with it
    const base = nodeColor(v);
    const c = [0, 1, 2].map((k) => TH.link[k] * 0.55 + base[k] * 0.45);
    return isDim(v) ? c.map((x) => x * 0.15) : c;
  }
  function recolor() { // heat/filter/theme changed — repaint buffers in place, geometry untouched
    if (!ready) return;
    for (const v of vis) {
      const c = nodeColor(v), dim = isDim(v);
      aColor.set(dim ? [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15] : c, v.idx * 3);
      aMeta[v.idx * 4 + 3] = v.kind + (dim ? 8 : 0);
    }
    GL3D.sub(env.gl, B.nCol, aColor);
    GL3D.sub(env.gl, B.nMeta, aMeta);
    let li = 0;
    for (const v of vis) {
      if (!v.parentV) continue;
      const mixc = linkCol(v);
      for (let k = 0; k < LSEG * 2; k++) linkColor.set(mixc, (li * LSEG * 2 + k) * 3);
      li++;
    }
    GL3D.sub(env.gl, B.lCol, linkColor);
  }
  function nearestVis(path) { // folded leaf -> nearest node that's actually on the map
    let n = byPath.get(path);
    while (n && !vByPath.has(n.path)) n = n.parent;
    return n ? vByPath.get(n.path) : null;
  }

  /* ----- GPU buffers ----- */
  function buildBuffers(introFromParent) {
    const gl = env.gl, N = vis.length;
    const oldNow = posNow;
    aFrom = new Float32Array(N * 3); aTo = new Float32Array(N * 3);
    aColor = new Float32Array(N * 3); aMeta = new Float32Array(N * 4);
    posNow = new Float32Array(N * 3);
    for (const v of vis) {
      const i = v.idx;
      let src;
      if (introFromParent) src = v.parentV ? v.parentV.pos : [0, 0, 0];
      else if (srcByPath) src = srcByPath.get(v.n.path) || (v.parentV && srcByPath.get(v.parentV.n.path)) || v.pos; // reload: morph from where each path was (new files emerge from their parent)
      else if (oldNow && oldNow.length === N * 3) src = [oldNow[i * 3], oldNow[i * 3 + 1], oldNow[i * 3 + 2]];
      else src = v.pos;
      aFrom.set(src, i * 3);
      aTo.set(v.pos, i * 3);
      const c = nodeColor(v), dim = isDim(v);
      aColor.set(dim ? [c[0] * 0.15, c[1] * 0.15, c[2] * 0.15] : c, i * 3);
      aMeta[i * 4] = v.idx === 0 ? 0 : v.r; // root rendered as the core, not a point
      aMeta[i * 4 + 1] = v.seed;
      aMeta[i * 4 + 2] = Math.min(0.7, v.depth * 0.13 + v.seed * 0.12);
      aMeta[i * 4 + 3] = v.kind + (dim ? 8 : 0);
      posNow.set(src, i * 3);
    }
    // links: curved edges, endpoint samples carry their node's morph inputs
    linkN = 0;
    for (const v of vis) if (v.parentV) linkN++;
    const lv = linkN * LSEG * 2; // line-list vertices
    linkFrom = new Float32Array(lv * 3); linkTo = new Float32Array(lv * 3);
    linkColor = new Float32Array(lv * 3); linkMeta = new Float32Array(lv * 4);
    const vtx = { i: 0 };
    for (const v of vis) {
      if (!v.parentV) continue;
      emitEdge(v.parentV, v, linkCol(v), linkFrom, linkTo, linkColor, linkMeta, vtx);
    }
    linkVerts = vtx.i;
    if (!B) B = { caps: {} };
    const up = (key, data, dynamic) => {
      if (B[key] && B.caps[key] >= data.byteLength) GL3D.sub(gl, B[key], data);
      else { B[key] = GL3D.buf(gl, data, dynamic); B.caps[key] = data.byteLength; }
    };
    up('nFrom', aFrom, true); up('nTo', aTo, true); up('nCol', aColor); up('nMeta', aMeta);
    up('lFrom', linkFrom, true); up('lTo', linkTo, true); up('lCol', linkColor); up('lMeta', linkMeta);
    B.nodeVAO = vao([[0, 'nFrom', 3], [1, 'nTo', 3], [2, 'nCol', 3], [3, 'nMeta', 4]]);
    B.lineVAO = vao([[0, 'lFrom', 3], [1, 'lTo', 3], [2, 'lCol', 3], [3, 'lMeta', 4]]);
    posSettled = false;
  }
  function vao(spec) {
    const gl = env.gl, v = gl.createVertexArray();
    gl.bindVertexArray(v);
    for (const [loc, key, size, div] of spec) GL3D.attr(gl, loc, B[key], size, div || 0);
    gl.bindVertexArray(null);
    return v;
  }
  function dynVAO(key, floats, spec) { // dynamic buffer + vao in one step
    const gl = env.gl;
    B[key] = GL3D.buf(gl, new Float32Array(floats), true);
    B.caps[key] = floats * 4;
    return vao(spec.map(([loc, size, div]) => [loc, key, size, div]));
  }

  /* ----- environment: stars, dust, nebula ----- */
  function buildEnv() {
    const gl = env.gl, c = QC();
    const mkStars = (count, rMin, rMax, pxA, pxB) => {
      const pos = new Float32Array(count * 3), dat = new Float32Array(count * 2);
      for (let i = 0; i < count; i++) {
        const h1 = rnd(i, 11), h2 = rnd(i, 23), h3 = rnd(i, 37), h4 = rnd(i, 53);
        const z = h1 * 2 - 1, ph = h2 * 6.2832, rr = rMin + (rMax - rMin) * Math.pow(h3, 0.7);
        const s = Math.sqrt(1 - z * z);
        pos.set([s * Math.cos(ph) * rr, z * rr * 0.92, s * Math.sin(ph) * rr], i * 3);
        dat[i * 2] = pxA + h4 * (pxB - pxA);
        dat[i * 2 + 1] = h4 + h2;
      }
      return { pos, dat, count };
    };
    const sc = clamp(TH.starDensity * TW.stars, 0.1, 3);
    const far = mkStars(Math.round(c.stars * sc), boundR * 2.6, boundR * 7, 1.1, 3);
    B.starN = far.count;
    B.sPos = GL3D.buf(gl, far.pos); B.sDat = GL3D.buf(gl, far.dat);
    B.starVAO = vao([[0, 'sPos', 3], [1, 'sDat', 2]]);
    const dn = Math.round(c.dust * sc);
    B.dustN = dn;
    if (dn) {
      const du = mkStars(dn, boundR * 0.4, boundR * 1.7, 0.8, 1.7);
      B.dPos = GL3D.buf(gl, du.pos); B.dDat = GL3D.buf(gl, du.dat);
      B.dustVAO = vao([[0, 'dPos', 3], [1, 'dDat', 2]]);
    }
    buildNebula();
  }
  function buildNebula() {
    const gl = env.gl, c = QC();
    const inst = [];
    const den = c.neb * TW.neb;
    if (den > 0.05) {
      const cols = [TH.neb1, TH.neb2, TH.neb3];
      const hubs = vis.filter((v) => v.kind === 1 && v.kids && v.kids.length >= 4 && v.idx !== 0)
        .sort((a, b) => b.r - a.r).slice(0, Math.round(20 * den));
      let ci = 0;
      for (const v of hubs) {
        const n = 1 + ((v.idx % 2) && den > 0.8 ? 1 : 0);
        for (let k = 0; k < n; k++) {
          const h1 = hash01(v.n.path + 'n' + k), h2 = hash01(v.n.path + 'm' + k);
          const off = v.clusterR * 0.5;
          inst.push({
            p: [v.pos[0] + (h1 - 0.5) * off, v.pos[1] + (h2 - 0.5) * off * 0.6, v.pos[2] + (h1 + h2 - 1) * off],
            s: v.clusterR * (1.7 + h1), c: cols[ci++ % 3],
            a: TH.nebAlpha * 0.62 * den * (0.6 + h2 * 0.7),
            rot: h1 * 6.28, spin: (h2 - 0.5) * 0.02, tex: (v.idx + k) % 3,
          });
        }
      }
      const nc = Math.round(7 * den); // heart of the galaxy
      for (let k = 0; k < nc; k++) {
        const h1 = hash01('core' + k), h2 = hash01('corez' + k);
        const rr = boundR * (0.12 + 0.3 * h1), an = h1 * 47;
        inst.push({
          p: [Math.cos(an) * rr, (h2 - 0.5) * boundR * 0.1, Math.sin(an) * rr],
          s: boundR * (0.22 + 0.25 * h2), c: cols[k % 3],
          a: TH.nebAlpha * 0.8 * den * (0.5 + h1 * 0.5),
          rot: h2 * 6.28, spin: (h1 - 0.5) * 0.014, tex: k % 3,
        });
      }
    }
    B.nebByTex = [[], [], []];
    for (const n of inst) B.nebByTex[n.tex].push(n);
    B.nebData = B.nebByTex.map((arr) => {
      const d = new Float32Array(arr.length * 12);
      arr.forEach((n, i) => d.set([...n.p, n.s, ...n.c, n.a, n.rot, n.seed || 0, n.spin, 0], i * 12));
      return d;
    });
    if (!B.nebVAOs) {
      B.cornerB = GL3D.buf(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
      B.nebVAOs = [0, 1, 2].map((i) => {
        B['nebI' + i] = GL3D.buf(gl, new Float32Array(320 * 12), true);
        B.caps['nebI' + i] = 320 * 12 * 4;
        const v = env.gl.createVertexArray();
        env.gl.bindVertexArray(v);
        GL3D.attr(env.gl, 0, B.cornerB, 2);
        bindInst('nebI' + i);
        env.gl.bindVertexArray(null);
        return v;
      });
    }
    B.nebData.forEach((d, i) => { if (d.length) GL3D.sub(env.gl, B['nebI' + i], d); });
  }
  function bindInst(key) { // iA(1) iB(2) iC(3) interleaved vec4 ×3, divisor 1
    const gl = env.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, B[key]);
    for (let a = 0; a < 3; a++) {
      gl.enableVertexAttribArray(1 + a);
      gl.vertexAttribPointer(1 + a, 4, gl.FLOAT, false, 48, a * 16);
      gl.vertexAttribDivisor(1 + a, 1);
    }
  }
  function initFxBuffers() {
    const gl = env.gl;
    for (const key of ['fxGlow', 'fxStar', 'fxRing']) {
      B[key] = GL3D.buf(gl, new Float32Array(256 * 12), true);
      B.caps[key] = 256 * 12 * 4;
      const v = gl.createVertexArray();
      gl.bindVertexArray(v);
      GL3D.attr(gl, 0, B.cornerB, 2);
      bindInst(key);
      gl.bindVertexArray(null);
      B[key + 'VAO'] = v;
    }
    B.trailVAO = dynVAO('trailP', TRAIL_MAX * 3, [[0, 3]]);
    env.gl.bindVertexArray(B.trailVAO);
    B.trailC = GL3D.buf(gl, new Float32Array(TRAIL_MAX * 3), true);
    B.trailD = GL3D.buf(gl, new Float32Array(TRAIL_MAX * 2), true);
    GL3D.attr(gl, 1, B.trailC, 3); GL3D.attr(gl, 2, B.trailD, 2);
    env.gl.bindVertexArray(null);
    B.strmVAO = null; // built lazily when a run lights paths up
  }

  /* ----- camera ----- */
  function computeFit() {
    const fov = (TW.fov * Math.PI) / 180;
    const availW = Math.max(120, W - insets.left - insets.right);
    const t = Math.tan(fov / 2) * Math.min(1, availW / Math.max(1, H));
    fitD = clamp((fitR / t) * 1.02, 120, 30000);
  }
  function camVectors() {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    eye = [cam.tg[0] + cam.dist * cp * cy, cam.tg[1] + cam.dist * sp, cam.tg[2] + cam.dist * cp * sy];
  }
  function updateVP() {
    const fov = (TW.fov * Math.PI) / 180;
    camVectors();
    const view = GL3D.lookAt(eye, cam.tg, [0, 1, 0]);
    const proj = GL3D.persp(fov, W / Math.max(1, H), 4, boundR * 16);
    let m = GL3D.mul(proj, view);
    m = GL3D.clipShift(m, (insets.left - insets.right) / Math.max(1, W), -(insets.top - insets.bottom) / Math.max(1, H));
    vp = m; vpCPU = m;
    B && (B.right = [view[0], view[4], view[8]], B.up = [view[1], view[5], view[9]]);
  }
  function animCam(to, dur = 900) {
    camAnim = {
      t0: performance.now(), dur,
      f: { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, tg: [...cam.tg] },
      t: to,
    };
  }
  function stepCam(now, dt) {
    if (camAnim) {
      const p = easeIO(clamp((now - camAnim.t0) / camAnim.dur, 0, 1));
      const { f, t } = camAnim;
      cam.yaw = f.yaw + (t.yaw - f.yaw) * p;
      cam.pitch = f.pitch + (t.pitch - f.pitch) * p;
      cam.dist = f.dist + (t.dist - f.dist) * p;
      for (let i = 0; i < 3; i++) cam.tg[i] = f.tg[i] + (t.tg[i] - f.tg[i]) * p;
      if (p >= 1) camAnim = null;
    } else {
      cam.yaw += cam.vyaw * dt; cam.pitch += cam.vpitch * dt;
      const fr = Math.pow(1 - clamp(TW.inertia, 0, 0.98), dt * 3.2);
      cam.vyaw *= fr; cam.vpitch *= fr;
      cam.pitch = clamp(cam.pitch, -1.35, 1.35);
      if (driftOn && !REDUCED && !drag && now - lastInput > 9000 && TW.drift > 0.01) {
        cam.yaw += dt * 0.05 * TW.drift;
        cam.pitch += ((0.36 + 0.16 * Math.sin(now * 0.00006)) - cam.pitch) * Math.min(1, dt * 0.25);
        cam.dist += ((fitD * (1 + 0.05 * Math.sin(now * 0.00004))) - cam.dist) * Math.min(1, dt * 0.05);
      }
    }
    const want = hoverV ? Math.hypot(posNow[hoverV.idx * 3] - eye[0], posNow[hoverV.idx * 3 + 1] - eye[1], posNow[hoverV.idx * 3 + 2] - eye[2]) : cam.dist;
    focusD += (want - focusD) * Math.min(1, dt * 4);
  }
  const refit = (dur = 1100) => animCam({ yaw: cam.yaw % 6.2832, pitch: 0.42, dist: fitD, tg: [0, 0, 0] }, dur);
  function swoop(v) {
    animCam({
      yaw: cam.yaw + 0.4, pitch: clamp(cam.pitch * 0.75 + 0.1, -1.2, 1.2),
      dist: clamp(v.clusterR * 3, 60, fitD), tg: [...v.pos],
    }, 1100);
  }

  /* ----- morph / live positions ----- */
  function startMorph(introFromParent) {
    buildBuffers(introFromParent);
    morphT0 = performance.now();
    if (changed.size) buildStreams(); // re-anchor active work-streams to the new geometry
    else if (B) B.strmN = 0;
    if (spotPath) buildSpot(); // spotlight survives layout switches + reloads too
    else if (B) B.spotN = 0;
    buildSelect(); // selection trail re-anchors; hover is transient — drop it
    if (B) B.hovN = 0;
    resolveMarks(); // task badges + pins re-anchor the same way
  }
  const morphNow = (now) => clamp((now - morphT0) / MORPH_MS, 0, 1);
  function updatePosNow(m) {
    if (m >= 1 && posSettled) return;
    for (let i = 0; i < vis.length; i++) {
      const d = aMeta[i * 4 + 2];
      let g = (m - d) / Math.max(0.2, 1 - d);
      g = easeIO(clamp(g, 0, 1));
      for (let k = 0; k < 3; k++) posNow[i * 3 + k] = aFrom[i * 3 + k] + (aTo[i * 3 + k] - aFrom[i * 3 + k]) * g;
    }
    if (m >= 1) posSettled = true;
  }

  /* ----- runs: comets, streams, changed markers ----- */
  function chainPts(v) {
    const chain = [];
    for (let u = v; u; u = u.parentV) chain.unshift(u);
    if (chain.length < 2) return null;
    const P = chain.map((u) => [posNow[u.idx * 3], posNow[u.idx * 3 + 1], posNow[u.idx * 3 + 2]]);
    const pts = [];
    for (let i = 0; i < P.length - 1; i++) { // catmull-rom through the ancestry
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      for (let s = 0; s < 12; s++) {
        const t = s / 12, t2 = t * t, t3 = t2 * t;
        pts.push([0, 1, 2].map((k) =>
          0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)));
      }
    }
    pts.push(P[P.length - 1]);
    return pts;
  }
  function spawnComet(path, kind) {
    let n = byPath.get(path);
    while (n && !vByPath.has(n.path)) n = n.parent;
    const v = n && vByPath.get(n.path);
    if (!v || v.idx === 0) return;
    const pts = chainPts(v);
    if (!pts) return;
    comets.push({ pts, t0: performance.now(), dur: 700 + pts.length * 26, v, kind, color: TH.comet, head: TH.cometHead });
    tick((kind === 'added' ? '+ ' : kind === 'deleted' ? '− ' : '~ ') + path);
  }
  function cometArrive(c) {
    changed.set(c.v.n.path, { idx: c.v.idx, kind: c.kind, t0: performance.now() });
    pulses.push({ p: [...c.pts[c.pts.length - 1]], t0: performance.now(), dur: 900, c: c.kind === 'deleted' ? TH.deleted : TH.changed, r0: c.v.r * 1.5, r1: c.v.r * 7 });
    buildStreams();
  }
  function buildStreams() { // bright animated edges along every path the agent touches
    const gl = env.gl;
    const done = doneFlashUntil > performance.now();
    const seen = new Set();
    const chains = []; // [v, color] — git-detected changes ∪ live tool activity
    const add = (path, op) => {
      if (chains.length >= 16) return;
      const v = nearestVis(path);
      if (!v || seen.has(v.idx)) return;
      seen.add(v.idx);
      // meaning over identity: read = orange, edit = red; finish holds everything green
      chains.push([v, brite(done ? tc3('done') : tc3(op), 0.25)]);
    };
    for (const [path] of changed) add(path, activity.get(path)?.op || 'edit');
    for (const [path, a] of activity) if (!changed.has(path)) add(path, a.op);
    const segs = [];
    for (const [v, col] of chains) {
      for (let u = v; u.parentV; u = u.parentV) segs.push([u.parentV, u, col]);
    }
    B.strmN = segs.length * LSEG * 2;
    if (!B.strmN) return;
    const nf = B.strmN;
    const f = new Float32Array(nf * 3), t = new Float32Array(nf * 3), c = new Float32Array(nf * 3), m = new Float32Array(nf * 4);
    const vtx = { i: 0 };
    for (const [p, ch, col] of segs) emitEdge(p, ch, col, f, t, c, m, vtx);
    const up = (key, data) => {
      if (B[key] && B.caps[key] >= data.byteLength) GL3D.sub(gl, B[key], data);
      else { B[key] = GL3D.buf(gl, data, true); B.caps[key] = data.byteLength; }
    };
    up('stF', f); up('stT', t); up('stC', c); up('stM', m);
    B.strmVAO = vao([[0, 'stF', 3], [1, 'stT', 3], [2, 'stC', 3], [3, 'stM', 4]]);
  }

  /* ----- navigation / integration API (RepoViz contract) ----- */
  function allPaths() {
    const out = [];
    for (const [p, n] of byPath) if (p && n.type === 'file') out.push(p);
    return out;
  }
  function flyTo(path) {
    if (!ready || !byPath.get(path)) return false;
    const v = nearestVis(path);
    if (!v) return false;
    lastInput = performance.now();
    if (v.idx === 0) refit();
    else swoop(v);
    if (!REDUCED) pulses.push({ p: [...v.pos], t0: performance.now() + 400, dur: 900, c: TH.accent, r0: v.r * 1.5, r1: v.r * 7 });
    wake();
    return true;
  }
  function spotlight(path) { // run-target highlight from a hovered task card
    spotPath = path || null;
    if (!ready) return;
    buildSpot();
    wake();
  }
  function buildSpot() { // bright chain along the target's ancestry (2D draws THEME.changed)
    spotV = spotPath ? nearestVis(spotPath) : null;
    if (spotV && spotV.idx === 0) spotV = null;
    if (!B) return;
    if (!spotV) { B.spotN = 0; return; }
    const segs = [];
    for (let u = spotV; u.parentV; u = u.parentV) segs.push([u.parentV, u]);
    B.spotN = segs.length * LSEG * 2;
    if (!B.spotN) return;
    const gl = env.gl, nf = B.spotN;
    const f = new Float32Array(nf * 3), t = new Float32Array(nf * 3), c = new Float32Array(nf * 3), m = new Float32Array(nf * 4);
    const vtx = { i: 0 };
    for (const [p, ch] of segs) emitEdge(p, ch, TH.changed, f, t, c, m, vtx);
    const up = (key, data) => {
      if (B[key] && B.caps[key] >= data.byteLength) GL3D.sub(gl, B[key], data);
      else { B[key] = GL3D.buf(gl, data, true); B.caps[key] = data.byteLength; }
    };
    up('spF', f); up('spT', t); up('spC', c); up('spM', m);
    B.spotVAO = vao([[0, 'spF', 3], [1, 'spT', 3], [2, 'spC', 3], [3, 'spM', 4]]);
  }
  function buildChainBatch(v, color, fKey, tKey, cKey, mKey, vaoKey) { // shared recipe for hover/selection trails
    if (!B) return 0;
    if (!v || v.idx === 0) return 0;
    const segs = [];
    for (let u = v; u.parentV; u = u.parentV) segs.push([u.parentV, u]);
    const n = segs.length * LSEG * 2;
    if (!n) return 0;
    const gl = env.gl;
    const f = new Float32Array(n * 3), t = new Float32Array(n * 3), c = new Float32Array(n * 3), m = new Float32Array(n * 4);
    const vtx = { i: 0 };
    for (const [p, ch] of segs) emitEdge(p, ch, color, f, t, c, m, vtx);
    const up = (key, data) => {
      if (B[key] && B.caps[key] >= data.byteLength) GL3D.sub(gl, B[key], data);
      else { B[key] = GL3D.buf(gl, data, true); B.caps[key] = data.byteLength; }
    };
    up(fKey, f); up(tKey, t); up(cKey, c); up(mKey, m);
    B[vaoKey] = vao([[0, fKey, 3], [1, tKey, 3], [2, cKey, 3], [3, mKey, 4]]);
    return n;
  }
  function buildHover() {
    B && (B.hovN = (hoverV && ready) ? buildChainBatch(hoverV, tc3('hover'), 'hvF', 'hvT', 'hvC', 'hvM', 'hovVAO') : 0);
  }
  function buildSelect() {
    selV = selectedPath ? nearestVis(selectedPath) : null;
    if (selV && selV.idx === 0) selV = null;
    B && (B.selN = (selV && ready) ? buildChainBatch(selV, tc3('selected'), 'slF', 'slT', 'slC', 'slM', 'selVAO') : 0);
  }
  function setSelected(path) {
    selectedPath = path || null;
    if (!ready) return;
    buildSelect();
    wake();
  }
  function fileActivity(path, op) { // live attribution from the runner's tool events
    if (!path) return;
    const prev = activity.get(path);
    const next = prev?.op === 'edit' ? 'edit' : (op === 'edit' ? 'edit' : 'read'); // edits don't demote
    activity.set(path, { op: next, t: performance.now() });
    if (!ready) return;
    clearTimeout(fileActivity._t); // debounce bursts of tool events
    fileActivity._t = setTimeout(buildStreams, 120);
    wake();
  }
  function setExtFilter(exts) {
    extFilter = exts && exts.size ? exts : null;
    if (!ready) return; // buildBuffers consults the filter on first build
    recolor();
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
    if (!ready) return;
    recolor();
    wake();
  }
  function resolveMarks() { // task/pin paths -> live vis nodes (re-run after every geometry rebuild)
    markVs = [];
    const seen = new Map();
    for (const m of taskMarks) {
      const v = nearestVis(m.file);
      if (!v || v.idx === 0) continue;
      const e = seen.get(v.idx);
      if (e) e.count += m.count;
      else { const o = { v, count: m.count }; seen.set(v.idx, o); markVs.push(o); }
    }
    pinVs = [];
    const ps = new Set();
    for (const p of pinPaths) {
      const v = nearestVis(p);
      if (v && v.idx !== 0 && !ps.has(v.idx)) { ps.add(v.idx); pinVs.push(v); }
    }
    dirtyVs = [];
    const ds = new Set();
    for (const p of dirtyPaths) {
      if (dirtyVs.length >= 48) break;
      const v = nearestVis(p);
      if (v && v.idx !== 0 && !ds.has(v.idx)) { ds.add(v.idx); dirtyVs.push({ v, path: p }); }
    }
    dirtyWaves.length = 0; // in-flight waves hold node indices — stale after any rebuild
  }
  function setTaskMarks(list) {
    taskMarks = list || [];
    if (ready) { resolveMarks(); wake(); }
  }
  function setPins(set) {
    pinPaths = new Set(set || []);
    if (ready) { resolveMarks(); wake(); }
  }
  function setDirty(list) {
    dirtyPaths = new Set(list || []);
    if (ready) { resolveMarks(); wake(); }
  }
  function remaxT(d) { // freshest commit under each dir — heat color for hubs
    let mt = 0;
    for (const c of d.children || []) {
      if (c.type === 'dir') remaxT(c);
      mt = Math.max(mt, c.type === 'dir' ? c.maxT : (c.t || 0));
    }
    d.maxT = mt;
  }
  async function setHeat(on) {
    on = !!on;
    $('#v3-heat')?.classList.toggle('on', on);
    if (heatOn === on) return;
    heatOn = on;
    if (!ready) return; // init/reload fetch honors heatOn
    if (on && !hasHeat) { // lazy: merge commit times into the live tree, no geometry morph
      let data;
      try { data = await (await fetch('/api/repotree?heat=1')).json(); } catch { return; }
      if (data.error) return;
      for (const f of data.files || []) { const n = byPath.get(f.p); if (n && n.type === 'file') n.t = f.t || 0; }
      remaxT(tree);
      hasHeat = true;
    }
    recolor();
    if (legendEl && !legendEl.hidden) renderLegend();
    wake();
  }
  async function reload() {
    if (!env) return;
    if (loading) { queued = true; return; }
    loading = true;
    try {
      let data;
      try { data = await (await fetch('/api/repotree?heat=' + (heatOn ? 1 : 0))).json(); } catch { return; }
      if (data.error) return;
      stats = data.stats || null;
      hasHeat = heatOn;
      const old = new Map();
      if (ready) {
        updatePosNow(morphNow(performance.now()));
        for (const v of vis) old.set(v.n.path, [posNow[v.idx * 3], posNow[v.idx * 3 + 1], posNow[v.idx * 3 + 2]]);
      }
      tree = buildTree(data);
      annotate(tree, null, 0);
      buildVis();
      runLayout();
      comets.length = 0; // in-flight comets hold stale node refs
      for (const [path, ch] of changed) { // re-point active embers at the new geometry
        const v = nearestVis(path);
        if (v) ch.idx = v.idx; else changed.delete(path);
      }
      srcByPath = old.size ? old : null;
      startMorph(false);
      srcByPath = null;
      buildEnv();
      if (!B.fxGlowVAO) initFxBuffers(); // a failed boot fetch can finish init here
      statTxt = `${((stats && stats.files) || vis.length).toLocaleString()} files · 3D`;
      if (countEl) countEl.textContent = statTxt;
      if (!ready) {
        ready = true;
        cam.dist = fitD * 2.5; cam.yaw = -2.1; cam.pitch = 0.5;
        if (visible && !revealed) { revealed = true; reveal(); }
      }
      wake();
    } finally {
      loading = false;
      if (queued) { queued = false; reload(); }
    }
  }
  function runStarted() {
    active++;
    if (!pollTimer) pollTimer = setInterval(poll, 1100);
  }
  function runEnded(ok) {
    if (active > 0) active--;
    if (!active) {
      clearInterval(pollTimer);
      pollTimer = null;
      setTimeout(reload, ok === true ? 1900 : 900); // let the show play, then refresh (2D parity)
    }
    const hold = ok ? trailsCfg().holdMs : 600;
    if (ok) {
      const done = tc3('done');
      for (const [, ch] of changed) {
        pulses.push({ p: [posNow[ch.idx * 3], posNow[ch.idx * 3 + 1], posNow[ch.idx * 3 + 2]], t0: performance.now() + Math.random() * 350, dur: 1100, c: done, r0: 4, r1: 26 });
      }
      pulses.push({ p: [0, 0, 0], t0: performance.now(), dur: 1600, c: done, r0: 20, r1: boundR * 0.9 });
      tick('✓ run complete');
      doneFlashUntil = performance.now() + hold; // every live trail holds the finish color…
      if (ready) buildStreams();
    }
    setTimeout(() => { // …then retracts
      doneFlashUntil = 0;
      changed.clear();
      activity.clear();
      B && (B.strmN = 0);
    }, hold);
  }
  async function poll() {
    let r;
    try { r = await (await fetch('/api/repotree/status')).json(); } catch { return; }
    for (const { file, kind } of r.changed || []) {
      if (!changed.has(file) && !comets.some((c) => c.v.n.path === file)) spawnComet(file, kind);
    }
    let swept = false; // read-only attention drifts away after ~6s untouched
    const pnow = performance.now();
    for (const [p, a] of activity) {
      if (a.op === 'read' && pnow - a.t > 6000 && !changed.has(p)) { activity.delete(p); swept = true; }
    }
    if (swept && ready) buildStreams();
    if (r.head && lastHead && r.head !== lastHead) reload(); // the runner committed
    lastHead = r.head || lastHead;
  }
  let tickN = 0;
  function tick(text) {
    if (!tickerEl) return;
    const d = document.createElement('div');
    d.className = 'tk'; d.textContent = text;
    tickerEl.appendChild(d);
    while (tickerEl.children.length > 4) tickerEl.firstChild.remove();
    const id = ++tickN;
    setTimeout(() => { if (d.parentNode) { d.classList.add('out'); setTimeout(() => d.remove(), 800); } }, 4200 + id * 0);
  }

  /* ----- fx instance batches (rebuilt per frame; tiny) ----- */
  const fxArr = { fxGlow: new Float32Array(256 * 12), fxStar: new Float32Array(256 * 12), fxRing: new Float32Array(256 * 12) };
  const fxN = { fxGlow: 0, fxStar: 0, fxRing: 0 };
  function fxPush(key, p, s, c, a, rot = 0, spin = 0) {
    const i = fxN[key];
    if (i >= 256) return;
    fxArr[key].set([p[0], p[1], p[2], s, c[0], c[1], c[2], a, rot, 0, spin, 0], i * 12);
    fxN[key] = i + 1;
  }
  function trailSpawn(p, c, r, life) {
    if (trail.length >= TRAIL_MAX) trail.shift();
    trail.push({ p: [...p], c, r, t0: performance.now(), life });
  }

  /* ----- labels + tooltip ----- */
  function drawLabels(now, m) {
    lctx.setTransform(dprL, 0, 0, dprL, 0, 0);
    lctx.clearRect(0, 0, W, H);
    const noText = TW.labels <= 0.02; // picking depends on v.scr — project even with labels off
    const c = QC();
    const cands = [];
    for (const v of vis) {
      const pr = GL3D.project(vpCPU, posNow[v.idx * 3], posNow[v.idx * 3 + 1], posNow[v.idx * 3 + 2], W, H);
      v.scr = pr;
      if (!pr) continue;
      const dist = pr[2];
      const sr = (v.r * pxK) / Math.max(dist, 1);
      v.scrR = sr;
      if (noText) continue;
      if (v.idx === 0) { cands.push([1e6, v, true, 16]); continue; }
      if (isDim(v)) continue; // filtered-out files keep no labels (2D parity)
      const isDir = v.kind === 1;
      if (sr < (isDir ? 1.7 : 3.2) / Math.sqrt(TW.labels)) continue;
      const defo = (Math.abs(dist - focusD) / Math.max(focusD, 40)) * c.dof;
      const alpha = clamp(1.25 / (1 + defo * defo * 2), 0, 1);
      if (alpha < 0.1) continue;
      cands.push([isDir ? sr + 1000 : sr, v, isDir, alpha]);
    }
    cands.sort((a, b) => b[0] - a[0]);
    const placed = [];
    let shown = 0;
    const max = Math.round(LABEL_BASE * TW.labels);
    lctx.textBaseline = 'middle';
    for (const [, v, isDir, alpha] of cands) {
      if (shown >= max) break;
      const [sx, sy] = v.scr;
      if (sx < -40 || sx > W + 40 || sy < -20 || sy > H + 20) continue;
      const label = v.kind === 2 ? '+' + v.aggN.toLocaleString() : v.n.name + (isDir ? '/' : '');
      lctx.font = (isDir ? '600 11px ' : '10px ') + TH.mono;
      const lx = sx + Math.max(4, v.scrR) + 5;
      const lw = lctx.measureText(label).width;
      const box = [lx - 2, sy - 7, lx + lw + 2, sy + 7];
      let hit = false;
      for (const b of placed) if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) { hit = true; break; }
      if (hit) continue;
      placed.push(box);
      shown++;
      lctx.globalAlpha = Math.min(1, (typeof alpha === 'number' ? alpha : 1)) * Math.min(1, m * 1.6);
      lctx.lineWidth = 3;
      lctx.strokeStyle = TH.labelHalo;
      lctx.strokeText(label, lx, sy);
      lctx.fillStyle = isDir ? TH.labelDir : TH.labelFile;
      lctx.fillText(label, lx, sy);
    }
    lctx.globalAlpha = 1;
  }
  /* ----- node context info (feeds the nav.js menu) ----- */
  function topExts(n) { // top-3 extension counts under a dir, walk budgeted for huge trees
    const c = new Map();
    let budget = 3000;
    const rec = (d) => {
      for (const k of d.children || []) {
        if (budget-- <= 0) return;
        if (k.type === 'dir') rec(k);
        else { const e = extOf(k.name) || 'other'; c.set(e, (c.get(e) || 0) + 1); }
      }
    };
    rec(n);
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 3);
  }
  function nodeInfo(v) {
    if (v.kind === 2) {
      const h = v.parentV.n; // agg reports its host dir
      return { path: h.path, name: h.name, isDir: true, isAgg: true, aggCount: v.aggN, leaf: h.leaf, bytes: h.bytes, t: h.maxT || 0, topExts: topExts(h) };
    }
    const n = v.n;
    if (v.kind === 1) return { path: n.path, name: n.name, isDir: true, leaf: n.leaf, bytes: n.bytes, t: n.maxT || 0, topExts: topExts(n) };
    return { path: n.path, name: n.name, isDir: false, size: n.size, ext: v.ext, t: n.t || 0 };
  }

  function showTip(v, sx, sy) {
    const n = v.n;
    let html;
    if (v.kind === 2) html = `<b>${v.aggN} more files</b><br><span class="dim">${esc(n.path.slice(0, -2))}/</span>`;
    else if (v.kind === 1) html = `<b>${esc(n.name)}/</b><br><span class="dim">${esc(n.path || n.name)}</span><br><span class="dim">${n.leaf} files · ${fmtB(n.bytes)}</span>`;
    else html = `<b>${esc(n.name)}</b><br><span class="dim">${esc(n.path)}</span><br><span class="dim">${fmtB(n.size)}</span>`;
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = clamp(sx + 14, 8, W - r.width - 10) + 'px';
    tip.style.top = clamp(sy - r.height - 10, 8, H - r.height - 8) + 'px';
  }
  const hideTip = () => { if (!pinned) tip.hidden = true; };

  /* ----- picking ----- */
  function pick(sx, sy) {
    let best = null, bd = 1e9;
    for (const v of vis) {
      const pr = v.scr;
      if (!pr) continue;
      const rad = Math.max(9, (v.idx === 0 ? 18 : v.scrR) + 5);
      const d = Math.hypot(pr[0] - sx, pr[1] - sy);
      if (d < rad && d < bd) { bd = d; best = v; }
    }
    return best;
  }

  /* ----- input ----- */
  function bind() {
    const xy = (e) => { const r = shell.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    shell.addEventListener('wheel', (e) => {
      e.preventDefault();
      lastInput = performance.now(); camAnim = null;
      cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), fitD * 0.04, fitD * 3.4);
    }, { passive: false });
    shell.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return; // right-click is the context menu, never an orbit drag
      shell.setPointerCapture?.(e.pointerId);
      const [sx, sy] = xy(e);
      pointers.set(e.pointerId, { x: sx, y: sy });
      lastInput = performance.now();
      if (pointers.size === 1) { drag = { moved: false }; camAnim = null; }
      shell.classList.add('dragging');
    });
    shell.addEventListener('pointermove', (e) => {
      const [sx, sy] = xy(e);
      const pt = pointers.get(e.pointerId);
      if (!pt) { onHover(sx, sy); return; }
      lastInput = performance.now();
      if (pointers.size === 2) {
        const other = [...pointers.entries()].find(([pid]) => pid !== e.pointerId)[1];
        const d0 = Math.hypot(pt.x - other.x, pt.y - other.y);
        const d1 = Math.hypot(sx - other.x, sy - other.y);
        if (d0 > 8) cam.dist = clamp(cam.dist * (d0 / d1), fitD * 0.04, fitD * 3.4);
        if (drag) drag.moved = true;
      } else if (drag) {
        const dx = sx - pt.x, dy = sy - pt.y;
        cam.yaw += dx * 0.0052;
        cam.pitch = clamp(cam.pitch + dy * 0.0052, -1.35, 1.35);
        cam.vyaw = dx * 0.0052 * 18; cam.vpitch = dy * 0.0052 * 18;
        if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; pinned = false; hideTip(); }
      }
      pointers.set(e.pointerId, { x: sx, y: sy });
    });
    const up = (e) => {
      const had = pointers.delete(e.pointerId);
      if (!pointers.size) shell.classList.remove('dragging');
      if (!had) return;
      if (drag && !drag.moved && e.type === 'pointerup') { const [sx, sy] = xy(e); onClick(sx, sy); }
      if (!pointers.size) drag = null;
    };
    shell.addEventListener('pointerup', up);
    shell.addEventListener('pointercancel', up);
    shell.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      lastInput = performance.now(); // hold off the idle drift while the menu is up
      const [sx, sy] = xy(e);
      const v = pick(sx, sy);
      pinned = false;
      hideTip();
      if (menuCb) menuCb(v && v.idx !== 0 ? nodeInfo(v) : null, sx, sy); // no menu on the root core
    });
    shell.addEventListener('dblclick', () => { lastInput = performance.now(); refit(); });
    addEventListener('keydown', (e) => { if (e.key === 'Escape') { pinned = false; tip.hidden = true; } });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) wake(); });
    $('#v3-zin')?.addEventListener('click', () => { lastInput = performance.now(); animCam({ ...snapCam(), dist: Math.max(fitD * 0.05, cam.dist / 1.5) }, 320); });
    $('#v3-zout')?.addEventListener('click', () => { lastInput = performance.now(); animCam({ ...snapCam(), dist: Math.min(fitD * 3.2, cam.dist * 1.5) }, 320); });
    $('#v3-fit')?.addEventListener('click', () => { lastInput = performance.now(); refit(); });
    const spin = $('#v3-spin');
    if (spin) {
      driftOn = localStorage.getItem('wl.g3d.drift') !== '0';
      spin.classList.toggle('on', driftOn);
      spin.addEventListener('click', () => {
        driftOn = !driftOn;
        spin.classList.toggle('on', driftOn);
        localStorage.setItem('wl.g3d.drift', driftOn ? '1' : '0');
      });
    }
    const heat = $('#v3-heat');
    if (heat) {
      heat.classList.toggle('on', heatOn);
      heat.addEventListener('click', () => (typeof Viz !== 'undefined' ? Viz.toggleHeat() : setHeat(!heatOn)));
    }
    $('#v3-help')?.addEventListener('click', () => {
      if (!legendEl) return;
      legendEl.hidden = !legendEl.hidden;
      if (!legendEl.hidden) renderLegend();
    });
  }
  const snapCam = () => ({ yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, tg: [...cam.tg] });
  function onHover(sx, sy) {
    const v = pick(sx, sy);
    if (v === hoverV) { if (v && !pinned) showTip(v, sx, sy); return; }
    hoverV = v;
    if (ready) buildHover(); // animated trail along the hovered ancestry
    shell.style.cursor = v ? 'pointer' : 'grab';
    if (hoverCb) { // breadcrumb feed — agg nodes report their host dir (2D parity)
      hoverCb(v ? { path: v.kind === 2 ? v.parentV.n.path : v.n.path, isDir: v.kind >= 1 } : null);
    }
    if (v && !pinned) showTip(v, sx, sy);
    else hideTip();
  }
  function onClick(sx, sy) {
    lastInput = performance.now();
    const v = pick(sx, sy);
    if (!v) { pinned = false; tip.hidden = true; if (menuCb) menuCb(null); if (fileClickCb) fileClickCb(null); return; }
    if (v.idx === 0) { refit(); return; }
    if (v.kind === 1) { swoop(v); pinned = false; tip.hidden = true; }
    else if (v.kind === 2) { swoop(v.parentV); pinned = false; tip.hidden = true; } // agg -> frame its host (2D parity)
    else {
      pulses.push({ p: [posNow[v.idx * 3], posNow[v.idx * 3 + 1], posNow[v.idx * 3 + 2]], t0: performance.now(), dur: 700, c: TH.accent, r0: v.r, r1: v.r * 6 });
      if (menuCb) { pinned = false; tip.hidden = true; menuCb(nodeInfo(v), sx, sy); return; } // nav menu takes over
      if (fileClickCb) { pinned = false; tip.hidden = true; fileClickCb(v.n.path, sx, sy); return; }
      pinned = true;
      showTip(v, sx, sy);
    }
  }

  /* ----- render ----- */
  let pxK = 800; // world->px constant at dist 1 (CSS px, labels/picking)
  function frame(now) {
    if (!running) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - lastT) / 1000 || 0.016);
    lastT = now; timeS += dt;
    const gl = env.gl, c = QC();

    stepCam(now, dt);
    updateVP();
    const m = morphNow(now);
    updatePosNow(m);

    const fov = (TW.fov * Math.PI) / 180;
    pxK = H / (2 * Math.tan(fov / 2));
    const pxGL = (H * dprGL) / (2 * Math.tan(fov / 2));
    const fxA = TH.fxAlpha;

    /* --- update dynamic actors --- */
    fxN.fxGlow = fxN.fxStar = fxN.fxRing = 0;
    // the root core: layered glows + a white heart
    const coreB = 1 + 0.06 * Math.sin(timeS * 1.7);
    const coreR = clamp(boundR * 0.14, 40, 130);
    fxPush('fxGlow', [0, 0, 0], coreR * coreB, TH.neb1, 0.17 * fxA, 0, 0.01);
    fxPush('fxGlow', [0, 0, 0], 32 * coreB, TH.accent, 0.5 * fxA);
    fxPush('fxGlow', [0, 0, 0], 13, TH.core, 0.85 * fxA);
    fxPush('fxStar', [0, 0, 0], 22 * coreB, TH.core, 0.55 * fxA, timeS * 0.05);
    // comets
    for (let i = comets.length - 1; i >= 0; i--) {
      const cm = comets[i];
      const p = clamp((now - cm.t0) / cm.dur, 0, 1);
      const u = p * p * (3 - 2 * p) * (cm.pts.length - 1);
      const i0 = Math.min(cm.pts.length - 2, Math.floor(u)), ft = u - i0;
      const hp = [0, 1, 2].map((k) => cm.pts[i0][k] + (cm.pts[i0 + 1][k] - cm.pts[i0][k]) * ft);
      fxPush('fxGlow', hp, 10, cm.color, 0.8 * fxA);
      fxPush('fxStar', hp, 6.5, cm.head, 0.95 * fxA, timeS * 2);
      if (c.trail > 0) for (let s = 0; s < 2; s++) {
        trailSpawn([hp[0] + (Math.random() - 0.5) * 2, hp[1] + (Math.random() - 0.5) * 2, hp[2] + (Math.random() - 0.5) * 2], cm.color, 2.6, 600 * c.trail + Math.random() * 300);
      }
      if (p >= 1) { cometArrive(cm); comets.splice(i, 1); }
    }
    // changed-node embers
    let ci = 0;
    for (const [, ch] of changed) {
      const p = [posNow[ch.idx * 3], posNow[ch.idx * 3 + 1], posNow[ch.idx * 3 + 2]];
      const col = ch.kind === 'deleted' ? TH.deleted : TH.changed;
      fxPush('fxGlow', p, 8 + 2 * Math.sin(timeS * 3 + ci), col, (0.5 + 0.25 * Math.sin(timeS * 3 + ci)) * fxA);
      ci++;
    }
    // pulses
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i];
      const p = (now - pu.t0) / pu.dur;
      if (p < 0) continue;
      if (p >= 1) { pulses.splice(i, 1); continue; }
      fxPush('fxRing', pu.p, pu.r0 + (pu.r1 - pu.r0) * easeIO(p), pu.c, (1 - p) * 0.85 * fxA);
    }
    // hover halo
    if (hoverV && hoverV.idx !== 0) {
      const p = [posNow[hoverV.idx * 3], posNow[hoverV.idx * 3 + 1], posNow[hoverV.idx * 3 + 2]];
      fxPush('fxRing', p, hoverV.r * 2.6 + 0.6 * Math.sin(timeS * 5), TH.accent, 0.9 * fxA);
    }
    // spotlight halo (task card hover)
    if (spotV) {
      const p = [posNow[spotV.idx * 3], posNow[spotV.idx * 3 + 1], posNow[spotV.idx * 3 + 2]];
      fxPush('fxRing', p, spotV.r * 2.6 + 1.2 * Math.sin(timeS * 3), TH.changed, 0.75 * fxA);
    }
    // task badges: soft warn glow on files the board has open work for
    let mi = 0;
    for (const { v } of markVs) {
      if (mi++ >= 32) break;
      const p = [posNow[v.idx * 3], posNow[v.idx * 3 + 1], posNow[v.idx * 3 + 2]];
      fxPush('fxGlow', p, v.r * 2.4 + 0.5 * Math.sin(timeS * 2.4 + v.seed * 6.28), TH.changed, 0.38 * fxA);
    }
    // pins: a quiet accent star riding each pinned file
    let pi = 0;
    for (const v of pinVs) {
      if (pi++ >= 32) break;
      const p = [posNow[v.idx * 3], posNow[v.idx * 3 + 1], posNow[v.idx * 3 + 2]];
      fxPush('fxStar', p, v.r * 2.0, TH.accent, 0.5 * fxA, timeS * 0.4);
    }
    // uncommitted files: one slow shared breath — swells big, never vanishes
    const dirtyBreath = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(timeS * 2.6); // 0..1
    for (const { v, path } of dirtyVs) {
      if (changed.has(path)) continue; // a live run ember already owns this node
      const p = [posNow[v.idx * 3], posNow[v.idx * 3 + 1], posNow[v.idx * 3 + 2]];
      fxPush('fxGlow', p, v.r * (3.2 + 1.4 * dirtyBreath), TH.changed, (0.10 + 0.08 * dirtyBreath) * fxA);
      fxPush('fxRing', p, v.r * (2.6 + 1.6 * dirtyBreath), TH.changed, (0.22 + 0.2 * dirtyBreath) * fxA);
    }
    // …and each breath, the dirty nodes fire a light-bending shockwave (post shader)
    if (dirtyVs.length && !REDUCED && pingCfg().on) {
      const cyc = Math.floor(timeS / pingCfg().every);
      if (cyc !== lastWaveCyc) {
        lastWaveCyc = cyc;
        for (let wi = 0; wi < Math.min(4, dirtyVs.length); wi++) {
          dirtyWaves.push({ idx: dirtyVs[wi].v.idx, t0: now + wi * 220 });
        }
      }
    }
    // trails -> typed arrays
    let tn = 0;
    const tP = trailBufs.p, tC = trailBufs.c, tD = trailBufs.d;
    for (let i = trail.length - 1; i >= 0; i--) {
      const t = trail[i];
      const p = (now - t.t0) / t.life;
      if (p >= 1) { trail.splice(i, 1); continue; }
      tP.set(t.p, tn * 3); tC.set(t.c, tn * 3);
      tD[tn * 2] = t.r * (1 - p * 0.6); tD[tn * 2 + 1] = (1 - p) * 0.7 * fxA;
      tn++;
    }

    /* --- GL upload + draw --- */
    if (m < 1) { GL3D.sub(gl, B.nFrom, aFrom); } // (no-op cost: from/to static during morph)
    for (const key of ['fxGlow', 'fxStar', 'fxRing']) if (fxN[key]) GL3D.sub(gl, B[key], fxArr[key].subarray(0, fxN[key] * 12));
    if (tn) {
      GL3D.sub(gl, B.trailP, tP.subarray(0, tn * 3));
      GL3D.sub(gl, B.trailC, tC.subarray(0, tn * 3));
      GL3D.sub(gl, B.trailD, tD.subarray(0, tn * 2));
    }

    env.post.size(Math.round(W * dprGL), Math.round(H * dprGL));
    env.post.begin();
    const P = env.P, T = env.T;
    const wob = REDUCED ? 0 : c.wob * 0.55;

    // stars + dust
    gl.useProgram(P.star.p);
    gl.uniformMatrix4fv(P.star.u.uVP, false, vp);
    gl.uniform1f(P.star.u.uTime, timeS);
    gl.uniform1f(P.star.u.uPxScale, dprGL);
    gl.uniform1f(P.star.u.uTwk, REDUCED ? 0.15 : 0.55);
    gl.uniform3fv(P.star.u.uC1, TH.star1); gl.uniform3fv(P.star.u.uC2, TH.star2);
    bindT(0, T.dot, P.star.u.uTex);
    gl.bindVertexArray(B.starVAO);
    gl.drawArrays(gl.POINTS, 0, B.starN);
    if (B.dustN) { gl.bindVertexArray(B.dustVAO); gl.drawArrays(gl.POINTS, 0, B.dustN); }

    // nebula gas
    if (c.neb * TW.neb > 0.05) {
      gl.useProgram(P.bill.p);
      gl.uniformMatrix4fv(P.bill.u.uVP, false, vp);
      gl.uniform3fv(P.bill.u.uRight, B.right); gl.uniform3fv(P.bill.u.uUp, B.up);
      gl.uniform1f(P.bill.u.uTime, timeS);
      const nebT = [T.neb1, T.neb2, T.neb3];
      B.nebByTex.forEach((arr, i) => {
        if (!arr.length) return;
        bindT(0, nebT[i], P.bill.u.uTex);
        gl.bindVertexArray(B.nebVAOs[i]);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, arr.length);
      });
    }

    // links
    gl.useProgram(P.line.p);
    gl.uniformMatrix4fv(P.line.u.uVP, false, vp);
    gl.uniform3fv(P.line.u.uEye, eye);
    gl.uniform1f(P.line.u.uMorph, m); gl.uniform1f(P.line.u.uTime, timeS);
    gl.uniform1f(P.line.u.uFocus, focusD); gl.uniform1f(P.line.u.uDof, c.dof);
    gl.uniform1f(P.line.u.uAlpha, 0.5 * fxA); gl.uniform1f(P.line.u.uShimmer, REDUCED ? 0 : c.shim);
    gl.uniform1f(P.line.u.uWobble, wob); gl.uniform1f(P.line.u.uFog, 0.18 / boundR);
    gl.bindVertexArray(B.lineVAO);
    gl.drawArrays(gl.LINES, 0, linkVerts);
    if (B.strmN && B.strmVAO) { // work-streams burn brighter
      gl.uniform1f(P.line.u.uAlpha, 1.1 * fxA);
      gl.uniform1f(P.line.u.uShimmer, 1.3);
      gl.uniform1f(P.line.u.uFog, 0);
      gl.bindVertexArray(B.strmVAO);
      gl.drawArrays(gl.LINES, 0, B.strmN);
    }
    if (B.spotN && B.spotVAO) { // spotlight chain (task card hover)
      gl.uniform1f(P.line.u.uAlpha, 1.25 * fxA);
      gl.uniform1f(P.line.u.uShimmer, 1.1);
      gl.uniform1f(P.line.u.uFog, 0);
      gl.bindVertexArray(B.spotVAO);
      gl.drawArrays(gl.LINES, 0, B.spotN);
    }
    if (B.selN && B.selVAO) { // selection trail (node menu open)
      gl.uniform1f(P.line.u.uAlpha, 1.3 * fxA);
      gl.uniform1f(P.line.u.uShimmer, 1.1);
      gl.uniform1f(P.line.u.uFog, 0);
      gl.bindVertexArray(B.selVAO);
      gl.drawArrays(gl.LINES, 0, B.selN);
    }
    if (B.hovN && B.hovVAO) { // hover trail
      gl.uniform1f(P.line.u.uAlpha, 1.0 * fxA);
      gl.uniform1f(P.line.u.uShimmer, 1.2);
      gl.uniform1f(P.line.u.uFog, 0);
      gl.bindVertexArray(B.hovVAO);
      gl.drawArrays(gl.LINES, 0, B.hovN);
    }

    // nodes: glow halo -> body -> white-hot heart
    gl.useProgram(P.node.p);
    gl.uniformMatrix4fv(P.node.u.uVP, false, vp);
    gl.uniform3fv(P.node.u.uEye, eye);
    gl.uniform1f(P.node.u.uMorph, m); gl.uniform1f(P.node.u.uTime, timeS);
    gl.uniform1f(P.node.u.uFocus, focusD); gl.uniform1f(P.node.u.uDof, c.dof);
    gl.uniform1f(P.node.u.uPx, pxGL); gl.uniform1f(P.node.u.uMaxPx, 320 * dprGL);
    gl.uniform1f(P.node.u.uWobble, wob);
    gl.uniform3fv(P.node.u.uTint, TH.core);
    gl.bindVertexArray(B.nodeVAO);
    const nodePass = (tex, sizeK, alphaK, tintK) => {
      bindT(0, tex, P.node.u.uTex);
      gl.uniform1f(P.node.u.uSizeK, sizeK * 2 * TW.nodeSize);
      gl.uniform1f(P.node.u.uAlphaK, alphaK * fxA);
      gl.uniform1f(P.node.u.uTintK, tintK);
      gl.drawArrays(gl.POINTS, 0, vis.length);
    };
    nodePass(T.glow, 3.1, 0.07, 0);
    nodePass(q() >= 2 ? T.star : T.dot, 1.25, 0.95, 0);
    if (q() >= 2) nodePass(T.dot, 0.45, 0.8, 0.9);

    // trails + fx billboards
    if (tn) {
      gl.useProgram(P.part.p);
      gl.uniformMatrix4fv(P.part.u.uVP, false, vp);
      gl.uniform3fv(P.part.u.uEye, eye);
      gl.uniform1f(P.part.u.uPx, pxGL); gl.uniform1f(P.part.u.uMaxPx, 80 * dprGL);
      bindT(0, T.glow, P.part.u.uTex);
      gl.bindVertexArray(B.trailVAO);
      gl.drawArrays(gl.POINTS, 0, tn);
    }
    gl.useProgram(P.bill.p);
    gl.uniformMatrix4fv(P.bill.u.uVP, false, vp);
    gl.uniform3fv(P.bill.u.uRight, B.right); gl.uniform3fv(P.bill.u.uUp, B.up);
    gl.uniform1f(P.bill.u.uTime, timeS);
    const fxDraw = (key, tex) => {
      if (!fxN[key]) return;
      bindT(0, tex, P.bill.u.uTex);
      gl.bindVertexArray(B[key + 'VAO']);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, fxN[key]);
    };
    fxDraw('fxGlow', T.glow);
    fxDraw('fxStar', T.star);
    fxDraw('fxRing', T.ring);
    gl.bindVertexArray(null);

    // post: bloom + god rays + tonemap composite
    const corePr = GL3D.project(vpCPU, 0, 0, 0, 1, 1);
    let rayK = 0, rayPos = [0.5, 0.5];
    if (corePr && c.ray > 0) {
      rayPos = [corePr[0], 1 - corePr[1]];
      const off = Math.hypot(rayPos[0] - 0.5, rayPos[1] - 0.5);
      rayK = c.ray * TW.bloom * clamp(1.3 - off * 1.6, 0, 1) * fxA;
    }
    waveU.fill(0); // shockwaves → composite-shader uniforms (4 × vec4)
    const ping = pingCfg();
    let wn = 0;
    for (let i = dirtyWaves.length - 1; i >= 0; i--) {
      const wv = dirtyWaves[i];
      const age = (now - wv.t0) / (ping.sweep * 1000);
      if (age >= 1) { dirtyWaves.splice(i, 1); continue; }
      if (age < 0 || wn >= 4) continue; // staggered start / slot budget
      const pr = GL3D.project(vpCPU, posNow[wv.idx * 3], posNow[wv.idx * 3 + 1], posNow[wv.idx * 3 + 2], 1, 1);
      if (!pr) continue; // source behind the camera this frame
      waveU[wn * 4] = pr[0];
      waveU[wn * 4 + 1] = 1 - pr[1];
      waveU[wn * 4 + 2] = (1 - Math.pow(1 - age, 2)) * 1.25; // ease-out expansion past the edges
      waveU[wn * 4 + 3] = (1 - age) * ping.power;
      wn++;
    }
    env.post.run({
      b1: c.b1 * TW.bloom * fxA, b2: c.b2 * TW.bloom * fxA, thresh: 0.32,
      rayK, rayPos, rayCol: TH.core.map((x, i) => x * 0.5 + TH.accent[i] * 0.5),
      bg: TH.bg, light: TH.light, expo: 1.15, vig: TH.light ? 0.18 : 0.5,
      time: timeS, grain: c.grain,
      waves: waveU, waveCol: TH.wave, aspect: W / Math.max(1, H),
      waveW: 0.022 * ping.width,
    });

    drawLabels(now, m);
    if (pinned && hoverV && hoverV.scr) showTip(hoverV, hoverV.scr[0], hoverV.scr[1]);
  }
  const trailBufs = { p: new Float32Array(TRAIL_MAX * 3), c: new Float32Array(TRAIL_MAX * 3), d: new Float32Array(TRAIL_MAX * 2) };
  function bindT(unit, tex, loc) {
    const gl = env.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(loc, unit);
  }
  function wake() {
    if (running || !visible || !ready) return;
    running = true;
    lastT = performance.now();
    requestAnimationFrame(frame);
  }

  /* ----- sizing ----- */
  function resize() {
    const r = shell.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return;
    W = r.width; H = r.height;
    dprL = Math.min(2, devicePixelRatio || 1);
    dprGL = Math.min(QC().dpr, devicePixelRatio || 1);
    glC.width = Math.round(W * dprGL); glC.height = Math.round(H * dprGL);
    lbC.width = Math.round(W * dprL); lbC.height = Math.round(H * dprL);
    computeFit();
  }

  /* ----- public API ----- */
  async function init() {
    shell = $('#viz3d-shell');
    if (!shell) return;
    glC = $('#viz3d-gl'); lbC = $('#viz3d-labels');
    tip = $('#viz3d-tip'); tickerEl = $('#viz3d-ticker'); countEl = $('#viz3d-count');
    legendEl = $('#viz3d-legend');
    lctx = lbC.getContext('2d');
    env = GL3D.boot(glC);
    if (!env) { shell.innerHTML = '<div class="viz-empty">WebGL2 unavailable — the 3D galaxy needs it. The 2D map still works.</div>'; return; }
    new ResizeObserver(resize).observe(shell);
    resize();
    bind();
    glC.addEventListener('webglcontextlost', (e) => { e.preventDefault(); running = false; });
    if (typeof Quality !== 'undefined') Quality.onChange(() => { if (ready) { resize(); buildEnv(); } });
    let data;
    try { data = await (await fetch('/api/repotree?heat=' + (heatOn ? 1 : 0))).json(); } catch { return; }
    if (data.error) return; // a later Viz.reload() finishes the boot once a repo is set
    stats = data.stats || null;
    hasHeat = heatOn;
    tree = buildTree(data);
    annotate(tree, null, 0);
    buildVis();
    runLayout();
    buildBuffers(true);
    buildEnv();
    initFxBuffers();
    if (spotPath) buildSpot();
    resolveMarks(); // marks/pins may have arrived before the data did
    statTxt = `${((stats && stats.files) || vis.length).toLocaleString()} files · 3D`;
    if (countEl) countEl.textContent = statTxt;
    ready = true;
    cam.dist = fitD * 2.5; cam.yaw = -2.1; cam.pitch = 0.5;
    if (visible) { revealed = true; reveal(); }
  }
  function reveal() { // first show: unfurl from the core + cinematic dolly-in
    morphT0 = performance.now();
    animCam({ yaw: -0.6, pitch: 0.42, dist: fitD, tg: [0, 0, 0] }, REDUCED ? 400 : 2600);
    wake();
  }
  let revealed = false;
  function setVisible(on) {
    visible = on;
    if (!shell || !env) return; // init() hasn't run yet — it checks `visible` when it finishes
    if (on) {
      resize();
      if (ready && !revealed) { revealed = true; reveal(); }
      else wake();
    } else running = false;
  }
  function retheme(t) {
    if (t.palGroups) {
      for (const [g, hex] of Object.entries(t.palGroups)) for (const e of EXT_GROUPS[g] || []) TH.pal[e] = hex3(hex);
      palHex = expandPal(t.palGroups);
    }
    for (const k of ['link', 'accent', 'changed', 'deleted', 'success', 'comet', 'cometHead', 'neb1', 'neb2', 'neb3', 'star1', 'star2', 'core', 'ring']) {
      if (t[k]) TH[k] = hex3(t[k]);
    }
    if (t.changed) TH.changedHex = t.changed;
    if (t.success) TH.successHex = t.success;
    if (t.wave) { TH.wave = hex3(t.wave); TH.waveHex = t.wave; }
    if (t.heatStops) HEAT3 = buildHeat3(t.heatStops);
    if (t.heatEmpty) TH.heatEmpty = hex3(t.heatEmpty);
    if (t.labelDir) TH.labelDir = t.labelDir;
    if (t.labelFile) TH.labelFile = t.labelFile;
    if (t.labelHalo) TH.labelHalo = t.labelHalo;
    if (t.mono) TH.mono = t.mono;
    if (t.nebAlpha != null) TH.nebAlpha = t.nebAlpha;
    if (t.starDensity != null) TH.starDensity = t.starDensity;
    if (t.fxAlpha != null) TH.fxAlpha = t.fxAlpha;
    TH.bg = cssRGB('var(--bg0)');
    TH.light = lum(TH.bg) > 0.45 ? 1 : 0;
    if (ready) { // node + link colors live in buffers
      recolor();
      buildEnv();
    }
    if (legendEl && !legendEl.hidden) renderLegend();
  }
  function renderLegend() { // mirrors the 2D legend (galaxy.js renderLegend)
    if (!legendEl) return;
    const langs = Object.entries((stats && stats.langs) || {}).sort((a, b) => b[1] - a[1]).slice(0, 10);
    legendEl.innerHTML =
      `<div class="lg" style="color:var(--text)">node size = file size</div>` +
      `<div class="lg"><span class="sw" style="background:${palHex.dir}"></span>directory</div>` +
      langs.map(([e, c]) =>
        `<div class="lg"><span class="sw" style="background:${palHex[e] || palHex.other}"></span>${esc(e || 'no ext')} · ${c}</div>`).join('') +
      `<div class="lg"><span class="sw" style="background:${TH.changedHex}"></span>changing now</div>` +
      `<div class="lg"><span class="sw" style="background:transparent;border:1.5px solid ${TH.changedHex}"></span>uncommitted changes</div>` +
      `<div class="lg"><span class="sw" style="background:${TH.successHex}"></span>updated by a run</div>` +
      (heatOn ? `<div class="lg" style="margin-top:5px;color:var(--text)">heat: bright = recent commits</div>` : '');
  }

  function setLayout(mode) {
    if (mode === layoutMode || !ready) { layoutMode = mode; return; }
    layoutMode = mode;
    localStorage.setItem('wl.g3d.layout', mode);
    const m = morphNow(performance.now());
    updatePosNow(m);
    runLayout();
    startMorph(false);
    buildNebula();
    refit(MORPH_MS * 0.9);
  }
  function setTweak(key, val) {
    TW[key] = val;
    if (!ready) return;
    if (key === 'twist' || key === 'spread' || key === 'thick') {
      clearTimeout(setTweak._t);
      setTweak._t = setTimeout(() => {
        updatePosNow(morphNow(performance.now()));
        runLayout();
        startMorph(false);
        buildNebula();
      }, 160);
    } else if (key === 'stars' || key === 'neb') {
      clearTimeout(setTweak._e);
      setTweak._e = setTimeout(buildEnv, 200);
    } else if (key === 'fov') computeFit();
  }
  function setInsets(next) {
    insets = { ...insets, ...next };
    computeFit();
  }
  return {
    init, reload, retheme, setVisible, setInsets, setLayout, setTweak,
    runStarted, runEnded, refit,
    allPaths, flyTo, spotlight, setExtFilter, setHeat,
    setPathFilter, setTaskMarks, setPins, setDirty,
    setSelected, fileActivity,
    onHoverChange: (fn) => { hoverCb = fn; },
    onFileClick: (fn) => { fileClickCb = fn; },
    onNodeMenu: (fn) => { menuCb = fn; },
    langStats: () => (stats && stats.langs) || {},
    tweaks: () => ({ ...TW }), layout: () => layoutMode,
    debug: () => ({
      ready, visible, running, vis: vis.length, links: linkN, boundR, fitR, fitD, cam: { ...cam }, q: q(),
      trail: trail.length, comets: comets.length, pulses: pulses.length, strmN: (B && B.strmN) || 0, changed: changed.size,
      far: vis.filter((v) => Math.hypot(...v.pos) > fitR).map((v) => [v.n.path, v.pos.map((x) => Math.round(x)).join(',')]).slice(0, 40),
    }),
  };
})();
