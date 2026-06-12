/* theme.js — the theme engine. CSS custom properties are the single source
   of truth: flipping html[data-theme] restyles the DOM via the cascade, then
   readThemeFromCSS() resolves the galaxy/ambient tokens into a plain object
   and hands it to RepoViz.retheme() + Ambient.set(). */

const Themes = (() => {
  const CATALOG = [
    { id: 'mission-control', label: 'Mission Control' },
    /* —— deep space pack —— */
    { id: 'nebula', label: 'Nebula' },
    { id: 'singularity', label: 'Singularity' },
    { id: 'aurora', label: 'Aurora' },
    { id: 'deep-space', label: 'Deep Space' },
    { id: 'ultraviolet', label: 'Ultraviolet' },
    /* —— neon pack —— */
    { id: 'tron', label: 'Tron Grid' },
    { id: 'synthwave', label: 'Synthwave' },
    { id: 'cyberpunk', label: 'Cyberpunk' },
    { id: 'vaporwave', label: 'Vaporwave' },
    { id: 'holo', label: 'Holograph' },
    { id: 'hacker', label: 'Hacker' },
    { id: 'rainbow', label: 'Rainbow' },
    /* —— elemental pack —— */
    { id: 'lava', label: 'Lava' },
    { id: 'fire', label: 'Fire' },
    { id: 'blood-moon', label: 'Blood Moon' },
    { id: 'abyss', label: 'Abyss' },
    { id: 'ocean', label: 'Ocean' },
    { id: 'glacier', label: 'Glacier' },
    { id: 'arctic', label: 'Arctic' },
    { id: 'rainy', label: 'Rainy' },
    { id: 'forest', label: 'Forest' },
    /* —— stately pack —— */
    { id: 'royal', label: 'Royal' },
    { id: 'midnight', label: 'Midnight' },
    { id: 'solar', label: 'Solar', light: true },
    { id: 'sakura', label: 'Sakura', light: true },
    { id: 'opal', label: 'Opal', light: true },
    { id: 'paper', label: 'Paper', light: true },
  ];
  const GROUPS = ['dir', 'ts', 'tsx', 'js', 'jsx', 'script', 'data', 'style', 'markup', 'docs', 'sql', 'image', 'config', 'native', 'other'];
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let lastPersisted = localStorage.getItem('wl.theme') || 'mission-control';
  let saveTimer = null;

  /* a hidden probe div resolves any CSS color (var chains, color-mix, …)
     to rgb()/rgba() through the cascade — works in every engine */
  let probe = null;
  function resolveColor(expr) {
    if (!probe) { probe = document.createElement('div'); probe.style.display = 'none'; document.body.appendChild(probe); }
    probe.style.color = '';
    probe.style.color = expr;
    return getComputedStyle(probe).color || 'rgb(0,0,0)';
  }
  function toHex(expr) { // opaque hex for canvas sprite-cache keys + heat lerp
    const n = (resolveColor(expr).match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
    return '#' + n.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
  }

  function complementOf(hex, bgIsLight) { // hue-opposite of the accent — pops on any palette
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    h = (h + 180) % 360;
    const s = Math.max(0.75, d ? d / (1 - Math.abs(mx + mn - 1) || 1) : 0);
    const l = bgIsLight ? 0.38 : 0.62;
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [rr, gg, bb] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return '#' + [rr, gg, bb].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
  }

  function readThemeFromCSS() {
    const cs = getComputedStyle(document.documentElement);
    const raw = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
    const palGroups = {};
    for (const g of GROUPS) palGroups[g] = toHex(`var(--pal-${g})`);
    const accentHex = toHex('var(--accent)');
    const bgHex = toHex('var(--bg0)');
    const bgLum = (parseInt(bgHex.slice(1, 3), 16) * 0.299 + parseInt(bgHex.slice(3, 5), 16) * 0.587 + parseInt(bgHex.slice(5, 7), 16) * 0.114) / 255;
    return {
      palGroups,
      wave: complementOf(accentHex, bgLum > 0.45), // dirty-shockwave front — contrasts the theme, never tone-on-tone
      heatStops: [0, 1, 2, 3, 4].map((i) => toHex(`var(--viz-heat-${i})`)),
      heatEmpty: toHex('var(--viz-heat-empty)'),
      link: toHex('var(--viz-link)'),
      accent: toHex('var(--accent)'),
      changed: toHex('var(--viz-changed)'),
      deleted: toHex('var(--viz-deleted)'),
      success: toHex('var(--viz-success)'),
      successBright: toHex('color-mix(in srgb, var(--viz-success) 45%, white)'),
      comet: toHex('var(--viz-comet)'),
      cometHead: toHex('var(--viz-comet-head)'),
      labelDir: resolveColor('var(--viz-label-dir)'),
      labelFile: resolveColor('var(--viz-label-file)'),
      labelHalo: resolveColor('var(--viz-label-halo)'),
      fxComposite: raw('--viz-fx-composite', 'lighter'),
      fxAlpha: parseFloat(raw('--viz-fx-alpha', '1')) || 1,
      mono: raw('--mono', 'ui-monospace,"SF Mono",Menlo,monospace'),
      ambient: raw('--ambient', 'none').replace(/["']/g, ''),
      /* scenery tokens — the galaxy's atmosphere retints per theme */
      neb1: toHex('var(--viz-neb-1)'),
      neb2: toHex('var(--viz-neb-2)'),
      neb3: toHex('var(--viz-neb-3)'),
      nebAlpha: parseFloat(raw('--viz-neb-alpha', '.16')) || 0,
      star1: toHex('var(--viz-star-1)'),
      star2: toHex('var(--viz-star-2)'),
      starDensity: parseFloat(raw('--viz-star-density', '1')) || 0,
      spike: toHex('var(--viz-spike)'),
      spikeAlpha: parseFloat(raw('--viz-spike-alpha', '.5')) || 0,
      ring: toHex('var(--viz-ring)'),
      ringAlpha: parseFloat(raw('--viz-ring-alpha', '.07')) || 0,
      core: toHex('var(--viz-core)'),
      shape: raw('--viz-node-shape', 'circle').replace(/["']/g, ''),
    };
  }

  function apply(id, persist = true) {
    if (!CATALOG.some((t) => t.id === id)) id = 'mission-control';
    const flip = () => {
      document.documentElement.dataset.theme = id;
      // read AFTER the flip — computed styles must reflect the new theme (G7)
      const t = readThemeFromCSS();
      RepoViz.retheme(t);
      if (typeof Repo3D !== 'undefined') Repo3D.retheme(t);
      if (typeof Ambient !== 'undefined') Ambient.set(t.ambient, t);
      document.querySelectorAll('.theme-card').forEach((c) => {
        const on = c.dataset.id === id;
        c.setAttribute('aria-checked', String(on));
        c.tabIndex = on ? 0 : -1;
      });
    };
    // flip must run exactly once even if the view transition aborts (e.g. the
    // page loaded in a hidden/background tab) — otherwise the canvas + ambient
    // would stay on the previous palette while the CSS shows the new theme.
    let ran = false;
    const safeFlip = () => { if (ran) return; ran = true; flip(); };
    if (document.startViewTransition && !REDUCED && !document.hidden) {
      try {
        const vt = document.startViewTransition(safeFlip);
        vt.ready?.catch(() => {});
        vt.finished?.catch(() => {}).then?.(safeFlip);
        vt.updateCallbackDone?.catch(safeFlip);
        // visible-but-not-rendering embeds never give the VT a frame: its
        // promises stay pending forever, so a timer is the only guarantee
        setTimeout(safeFlip, 350);
      } catch { safeFlip(); }
    } else safeFlip();
    if (persist) {
      lastPersisted = id;
      localStorage.setItem('wl.theme', id);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => post('/api/config', { ui: { theme: id } }), 800);
    }
  }

  function buildPicker() {
    const grid = $('#theme-grid');
    grid.innerHTML = '';
    const current = document.documentElement.dataset.theme;
    for (const t of CATALOG) {
      const b = document.createElement('button');
      b.className = 'theme-card';
      b.dataset.theme = t.id; // the cascade themes the card itself = free live preview
      b.dataset.id = t.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(t.id === current));
      b.tabIndex = t.id === current ? 0 : -1;
      b.innerHTML = `<span class="tc-prev"><span class="tc-neb"></span><span class="tc-stars"></span><span class="tc-aurora"></span><span class="tc-dots"><i></i><i></i><i></i><i></i></span></span><span class="tc-name">${esc(t.label)}</span>`;
      b.addEventListener('click', () => apply(t.id));
      grid.appendChild(b);
    }
    grid.addEventListener('keydown', (e) => {
      const cards = [...grid.querySelectorAll('.theme-card')];
      const i = cards.indexOf(document.activeElement);
      if (i < 0) return;
      let j = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % cards.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + cards.length) % cards.length;
      else if (e.key === 'Escape') { apply(lastPersisted); return; }
      if (j !== null) { e.preventDefault(); cards[j].focus(); apply(cards[j].dataset.id, false); } // live preview
      if (e.key === 'Enter' && i >= 0) apply(cards[i].dataset.id); // confirm
    });
  }

  function syncFromConfig(c) {
    const box = $('#f-ambient');
    if (box) {
      box.checked = c.ui?.ambientFx !== false;
      if (typeof Ambient !== 'undefined') Ambient.setEnabled(box.checked);
    }
    // config is the machine default; an explicit local choice wins
    if (!localStorage.getItem('wl.theme') && c.ui?.theme && c.ui.theme !== document.documentElement.dataset.theme) {
      apply(c.ui.theme, false);
    }
  }

  function init() {
    buildPicker();
    apply(document.documentElement.dataset.theme, false); // CSS becomes the source of truth at boot
    $('#f-ambient').addEventListener('change', (e) => {
      if (typeof Ambient !== 'undefined') Ambient.setEnabled(e.target.checked);
      post('/api/config', { ui: { ambientFx: e.target.checked } });
    });
  }

  return { init, apply, syncFromConfig, readThemeFromCSS, CATALOG };
})();
