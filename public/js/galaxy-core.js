/* galaxy-core.js — view-independent data + math shared by the 2D (galaxy.js)
   and 3D (galaxy3d.js) renderers. Loaded before both.

   Every one of these used to be hand-mirrored in each file and kept in sync by
   "(2D parity)" comments; this is the single source of truth so a palette,
   formatter, or heat-ramp change lands once instead of being transcribed twice
   (where it had already started to drift — e.g. fmtB's GB branch). Classic
   script (window global) to match the existing <script defer> bundle; no module
   system involved. View-specific geometry (radial vs WebGL layout) and the
   stateful tree walk stay in each renderer. */
const GalaxyCore = (() => {
  // Extension → palette-group map. The 15 group colors (one per --pal-* token)
  // expand to the per-extension table the draw code reads.
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
  const expandPal = (groups) => {
    const pal = {};
    for (const [g, exts] of Object.entries(EXT_GROUPS)) for (const e of exts) pal[e] = groups[g];
    return pal;
  };
  // Default Mission-Control palette (theme.js overrides it via retheme()).
  const PAL_DEFAULT = {
    dir: '#4fd1c5', ts: '#8ab4ff', tsx: '#5e8fe6', js: '#e6cf6f', jsx: '#cdb45c',
    script: '#3fb66e', data: '#e0a33e', style: '#c08bff', markup: '#e0614b',
    docs: '#8c95a3', sql: '#d678b6', image: '#5dbb8f', config: '#7d8aa0',
    native: '#d98a68', other: '#5c6470',
  };

  // 32-step heat ramp lerped between the 5 stops. buildHeat → '#rrggbb' for the
  // 2D canvas; buildHeat3 → [r,g,b] in 0..1 for the GL renderer. Same maths, two
  // output encodings.
  const lerpStops = (stopsHex, parse) => {
    const stops = stopsHex.map(parse);
    return Array.from({ length: 32 }, (_, i) => {
      const t = (i / 31) * (stops.length - 1), a = Math.min(stops.length - 2, Math.floor(t)), f = t - a;
      return stops[a].map((v, j) => v + (stops[a + 1][j] - v) * f);
    });
  };
  const buildHeat = (stopsHex) =>
    lerpStops(stopsHex, (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)))
      .map((rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''));
  const buildHeat3 = (stopsHex) =>
    lerpStops(stopsHex, (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255));

  const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const fmtB = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B';
  const easeIO = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  // Live-trail colors + uncommitted-ping defaults (Appearance sliders override).
  const TRAILS_DEF = { hover: '#3b82f6', selected: '#3b82f6', read: '#ff9f43', edit: '#ff4d4d', done: '#22c55e', holdMs: 2000 };
  const PING_DEF = { on: true, every: 7, sweep: 3.6, width: 1, power: 1 };

  return { EXT_GROUPS, expandPal, PAL_DEFAULT, buildHeat, buildHeat3, extOf, fmtB, easeIO, TRAILS_DEF, PING_DEF };
})();
