/* galaxy-scenery.js — the atmosphere behind (and on) the repo galaxy.
   Pure decoration, all theme-token driven, all deterministic:
     · parallax starfield (hash-gridded, infinite, no per-frame allocation)
     · nebula gas clouds (world-anchored, parallax 0.3)
     · cluster gas behind directory hubs (the tree itself glows)
     · orbital guide rings on the true layout radii
     · the Core — a hot glow where the repo root sits
     · diffraction spikes on big nodes + shaped node sprites per theme
   Colors come from RepoViz.retheme() → VizScenery.retheme(); density and
   feature gates come from Quality (0 Lite … 3 Ultra).
   Everything here is drawn into the galaxy's base layer, so it costs nothing
   while the map is idle. */
const VizScenery = (() => {
  let T = {
    neb1: '#5e8fe6', neb2: '#4fd1c5', neb3: '#2b3a6e', nebAlpha: 0.16,
    star1: '#cdd6e4', star2: '#7f8aa0', starDensity: 1,
    spike: '#dff7f4', spikeAlpha: 0.5,
    ring: '#4fd1c5', ringAlpha: 0.07,
    core: '#ffffff', shape: 'circle',
    fxComposite: 'lighter', fxAlpha: 1,
    mono: 'ui-monospace,"SF Mono",Menlo,monospace',
  };
  let Q = 2;

  /* deterministic 0..1 hash per (cell, salt) — the whole starfield is math */
  const hash = (ix, iy, s) => {
    let h = (ix * 374761393 + iy * 668265263 + (s + 1) * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  /* ----- sprite caches (cleared on retheme) ----- */
  const cache = new Map();
  const mk = (key, size, draw) => {
    let c = cache.get(key);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = size;
    draw(c.getContext('2d'), size);
    cache.set(key, c);
    return c;
  };

  const glow = (color) => mk('g|' + color, 96, (c, S) => {
    const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, color + 'ff');
    g.addColorStop(0.35, color + '55');
    g.addColorStop(1, color + '00');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  });

  /* gaseous blob: three offset radial pools so it doesn't read as a perfect disc */
  const neb = (color) => mk('n|' + color, 256, (c, S) => {
    const pool = (x, y, r, a) => {
      const g = c.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color + a);
      g.addColorStop(1, color + '00');
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);
    };
    pool(S * 0.5, S * 0.5, S * 0.5, '40');
    pool(S * 0.36, S * 0.42, S * 0.3, '36');
    pool(S * 0.64, S * 0.6, S * 0.26, '30');
  });

  /* 4-arm diffraction spike (plus a faint 45° pair) */
  const spikeSprite = (color) => mk('s|' + color, 160, (c, S) => {
    const half = S / 2;
    const arm = (rot, len, w, a) => {
      c.save();
      c.translate(half, half);
      c.rotate(rot);
      const g = c.createLinearGradient(-len, 0, len, 0);
      g.addColorStop(0, color + '00');
      g.addColorStop(0.5, color + a);
      g.addColorStop(1, color + '00');
      c.strokeStyle = g;
      c.lineWidth = w;
      c.beginPath();
      c.moveTo(-len, 0);
      c.lineTo(len, 0);
      c.stroke();
      c.restore();
    };
    arm(0, half, 2.4, 'e6');
    arm(Math.PI / 2, half, 2.4, 'e6');
    arm(Math.PI / 4, half * 0.55, 1.4, '88');
    arm(-Math.PI / 4, half * 0.55, 1.4, '88');
    const g = c.createRadialGradient(half, half, 0, half, half, 14);
    g.addColorStop(0, color + 'cc');
    g.addColorStop(1, color + '00');
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
  });

  /* ----- themed node shapes (files render as these instead of plain discs) ----- */
  const GLYPHS = ['0', '1', 'λ', '{', '}', '<', '>', '#', '$', ';', '*', '&'];
  function nodeSprite(shape, color, seed) {
    const variant = shape === 'glyph' ? (seed % GLYPHS.length) : 0;
    return mk('p|' + shape + '|' + variant + '|' + color, 64, (c, S) => {
      const m = S / 2;
      c.fillStyle = color;
      c.strokeStyle = color;
      c.lineCap = 'round';
      c.lineJoin = 'round';
      const core = (r, a) => {
        const g = c.createRadialGradient(m, m, 0, m, m, r);
        g.addColorStop(0, 'rgba(255,255,255,' + a + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, S, S);
        c.fillStyle = color;
      };
      switch (shape) {
        case 'star': // 4-point sparkle
          c.beginPath();
          c.moveTo(m, 2);
          c.quadraticCurveTo(m + 5, m - 5, S - 2, m);
          c.quadraticCurveTo(m + 5, m + 5, m, S - 2);
          c.quadraticCurveTo(m - 5, m + 5, 2, m);
          c.quadraticCurveTo(m - 5, m - 5, m, 2);
          c.fill();
          core(10, 0.9);
          break;
        case 'spark': // thinner sparkle
          c.beginPath();
          c.moveTo(m, 0);
          c.quadraticCurveTo(m + 3, m - 3, S, m);
          c.quadraticCurveTo(m + 3, m + 3, m, S);
          c.quadraticCurveTo(m - 3, m + 3, 0, m);
          c.quadraticCurveTo(m - 3, m - 3, m, 0);
          c.fill();
          core(8, 0.95);
          break;
        case 'flake': { // 6-arm snowflake
          c.lineWidth = 4;
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const dx = Math.cos(a), dy = Math.sin(a);
            c.beginPath();
            c.moveTo(m, m);
            c.lineTo(m + dx * 26, m + dy * 26);
            c.stroke();
            const px = m + dx * 15, py = m + dy * 15;
            const b1 = a + 0.62, b2 = a - 0.62;
            c.lineWidth = 2.6;
            c.beginPath();
            c.moveTo(px, py);
            c.lineTo(px + Math.cos(b1) * 9, py + Math.sin(b1) * 9);
            c.moveTo(px, py);
            c.lineTo(px + Math.cos(b2) * 9, py + Math.sin(b2) * 9);
            c.stroke();
            c.lineWidth = 4;
          }
          core(8, 0.8);
          break;
        }
        case 'glyph': // terminal character
          c.font = '700 46px ' + T.mono;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(GLYPHS[variant], m, m + 2);
          break;
        case 'diamond':
          c.beginPath();
          c.moveTo(m, 4);
          c.lineTo(S - 4, m);
          c.lineTo(m, S - 4);
          c.lineTo(4, m);
          c.closePath();
          c.fill();
          core(9, 0.7);
          break;
        case 'square':
          c.beginPath();
          c.rect(11, 11, S - 22, S - 22);
          c.fill();
          c.strokeStyle = 'rgba(255,255,255,.55)';
          c.lineWidth = 2;
          c.strokeRect(16, 16, S - 32, S - 32);
          break;
        case 'petal':
          c.save();
          c.translate(m, m);
          c.rotate(0.5 + (seed % 5) * 0.5);
          c.beginPath();
          c.ellipse(0, 0, 26, 13, 0, 0, Math.PI * 2);
          c.fill();
          c.globalAlpha = 0.5;
          c.strokeStyle = 'rgba(255,255,255,.7)';
          c.lineWidth = 1.6;
          c.beginPath();
          c.moveTo(-22, 0);
          c.quadraticCurveTo(0, -3, 22, 0);
          c.stroke();
          c.restore();
          break;
        case 'drop': // bubble — ring + specular highlight
          c.lineWidth = 5.5;
          c.beginPath();
          c.arc(m, m, 23, 0, Math.PI * 2);
          c.stroke();
          c.globalAlpha = 0.28;
          c.beginPath();
          c.arc(m, m, 19, 0, Math.PI * 2);
          c.fill();
          c.globalAlpha = 0.85;
          c.strokeStyle = 'rgba(255,255,255,.9)';
          c.lineWidth = 3.4;
          c.beginPath();
          c.arc(m, m, 16.5, -2.3, -1.1);
          c.stroke();
          break;
        case 'gem': { // faceted crystal
          c.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
            const r = k % 2 ? 22 : 27;
            const x = m + Math.cos(a) * r, y = m + Math.sin(a) * r;
            k ? c.lineTo(x, y) : c.moveTo(x, y);
          }
          c.closePath();
          c.fill();
          c.strokeStyle = 'rgba(255,255,255,.5)';
          c.lineWidth = 1.6;
          c.beginPath();
          c.moveTo(m, m - 27);
          c.lineTo(m, m + 22);
          c.moveTo(m - 19, m - 11);
          c.lineTo(m + 19, m + 9);
          c.moveTo(m + 19, m - 11);
          c.lineTo(m - 19, m + 9);
          c.stroke();
          break;
        }
        default: // circle fallback (shouldn't be hit — circles stay batched)
          c.beginPath();
          c.arc(m, m, 24, 0, Math.PI * 2);
          c.fill();
      }
    });
  }

  /* ----- starfield: parallax layers of hash-placed stars ----- */
  function starLayers() {
    if (Q <= 0) return [];
    if (Q === 1) {
      return [
        { p: 0.1, tile: 300, n: 4, s: 1.0, a: 0.35, col: () => T.star2, seed: 11 },
      ];
    }
    const L = [
      { p: 0.045, tile: 280, n: 6, s: 0.8, a: 0.3, col: () => T.star2, seed: 11 },
      { p: 0.11, tile: 300, n: 5, s: 1.15, a: 0.42, col: () => T.star1, seed: 23 },
    ];
    if (Q >= 3) L.push({ p: 0.2, tile: 340, n: 4, s: 1.5, a: 0.5, col: () => T.star1, seed: 37 });
    return L;
  }

  function drawBack(ctx, cam, W, H) {
    if (Q <= 0) return;
    const d = Math.max(0, +T.starDensity || 0);
    ctx.save();
    /* stars */
    if (d > 0) {
      for (const L of starLayers()) {
        const ox = cam.x * cam.k * L.p, oy = cam.y * cam.k * L.p;
        const i0 = Math.floor(ox / L.tile), j0 = Math.floor(oy / L.tile);
        ctx.fillStyle = L.col();
        ctx.globalAlpha = L.a * T.fxAlpha;
        ctx.beginPath();
        for (let i = i0; i * L.tile < ox + W + L.tile; i++) {
          for (let j = j0; j * L.tile < oy + H + L.tile; j++) {
            const cnt = Math.round(L.n * d * (0.4 + hash(i, j, L.seed) * 1.2));
            for (let s = 0; s < cnt; s++) {
              const x = (i + hash(i, j, L.seed + s * 3 + 1)) * L.tile - ox;
              const y = (j + hash(i, j, L.seed + s * 3 + 2)) * L.tile - oy;
              if (x < -4 || x > W + 4 || y < -4 || y > H + 4) continue;
              const r = L.s * (0.35 + hash(i, j, L.seed + s * 3 + 3) * 1.05);
              ctx.moveTo(x + r, y);
              ctx.arc(x, y, r, 0, 6.2832);
            }
          }
        }
        ctx.fill();
      }
      /* a few bright "named" stars with spikes (Q≥2) */
      if (Q >= 2) {
        ctx.globalCompositeOperation = T.fxComposite;
        const p = 0.16, tile = 620;
        const ox = cam.x * cam.k * p, oy = cam.y * cam.k * p;
        const i0 = Math.floor(ox / tile), j0 = Math.floor(oy / tile);
        const sp = spikeSprite(T.star1);
        for (let i = i0; i * tile < ox + W + tile; i++) {
          for (let j = j0; j * tile < oy + H + tile; j++) {
            if (hash(i, j, 51) > 0.38 * d) continue;
            const x = (i + hash(i, j, 52)) * tile - ox;
            const y = (j + hash(i, j, 53)) * tile - oy;
            if (x < -30 || x > W + 30 || y < -30 || y > H + 30) continue;
            const s = 7 + hash(i, j, 54) * 12;
            ctx.globalAlpha = (0.3 + hash(i, j, 55) * 0.4) * T.fxAlpha;
            ctx.drawImage(sp, x - s, y - s, s * 2, s * 2);
          }
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    /* nebula gas */
    if (T.nebAlpha > 0 && Q >= 1) {
      ctx.globalCompositeOperation = T.fxComposite;
      const p = 0.3, tile = 760;
      const ox = cam.x * cam.k * p, oy = cam.y * cam.k * p;
      const i0 = Math.floor((ox - 400) / tile), j0 = Math.floor((oy - 400) / tile);
      const cols = [T.neb1, T.neb2, T.neb3];
      let budget = Q >= 3 ? 18 : 11;
      for (let i = i0; i * tile < ox + W + 400 && budget > 0; i++) {
        for (let j = j0; j * tile < oy + H + 400 && budget > 0; j++) {
          const h0 = hash(i, j, 71);
          const n = h0 < 0.3 ? 0 : h0 < 0.82 ? 1 : 2;
          for (let s = 0; s < n && budget > 0; s++, budget--) {
            const x = (i + hash(i, j, 72 + s * 4)) * tile - ox;
            const y = (j + hash(i, j, 73 + s * 4)) * tile - oy;
            const R = (170 + hash(i, j, 74 + s * 4) * 280) * (Q >= 3 ? 1.2 : 1);
            if (x < -R || x > W + R || y < -R || y > H + R) continue;
            ctx.globalAlpha = T.nebAlpha * (0.45 + hash(i, j, 75 + s * 4) * 0.55) * T.fxAlpha;
            ctx.drawImage(neb(cols[(hash(i, j, 76 + s * 4) * 3) | 0]), x - R, y - R, R * 2, R * 2);
          }
        }
      }
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  /* ----- orbital guide rings on the true layout radii (world space) ----- */
  function drawOrbits(ctx, cam, ring0, ring, maxDepth, W, H) {
    if (Q <= 0 || T.ringAlpha <= 0 || maxDepth < 1) return;
    ctx.strokeStyle = T.ring;
    ctx.globalAlpha = T.ringAlpha * T.fxAlpha * 2;
    ctx.lineWidth = 1 / cam.k;
    ctx.setLineDash([2 / cam.k, 7 / cam.k]);
    ctx.beginPath();
    for (let dpt = 1; dpt <= maxDepth; dpt++) {
      const R = ring0 + ring * (dpt - 1);
      const sr = R * cam.k;
      if (sr < 26 || sr > Math.max(W, H) * 2.2) continue;
      ctx.moveTo(R, 0);
      ctx.arc(0, 0, R, 0, 6.2832);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /* ----- the Core: the repo root burns at the center (world space) ----- */
  function drawCore(ctx, color) {
    if (Q <= 0) return;
    ctx.globalCompositeOperation = T.fxComposite;
    let s = 64;
    ctx.globalAlpha = 0.4 * T.fxAlpha;
    ctx.drawImage(glow(color), -s, -s, s * 2, s * 2);
    s = 26;
    ctx.globalAlpha = 0.5 * T.fxAlpha;
    ctx.drawImage(glow(T.core), -s, -s, s * 2, s * 2);
    if (Q >= 2) {
      s = 110;
      ctx.globalAlpha = 0.65 * T.fxAlpha;
      ctx.drawImage(spikeSprite(color), -s, -s, s * 2, s * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ----- cluster gas behind directory hubs (world space) ----- */
  function clusterGas(ctx, v, color) {
    if (Q < 2 || T.nebAlpha <= 0 || v.kids.length < 4) return;
    const s = Math.min(170, 34 + v.r * 7) * Math.max(0, Math.min(1, v.grow));
    if (s <= 0) return;
    ctx.globalCompositeOperation = T.fxComposite;
    ctx.globalAlpha = T.nebAlpha * 0.7 * T.fxAlpha;
    ctx.drawImage(neb(color), v.x - s, v.y - s, s * 2, s * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /* ----- diffraction spike on a node (world space) ----- */
  function drawSpike(ctx, v, color) {
    if (T.spikeAlpha <= 0) return;
    const s = v.r * 4.2 * Math.max(0, Math.min(1, v.grow));
    if (s <= 0) return;
    ctx.globalCompositeOperation = T.fxComposite;
    ctx.globalAlpha = T.spikeAlpha * T.fxAlpha;
    ctx.drawImage(spikeSprite(color), v.x - s, v.y - s, s * 2, s * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function retheme(next) {
    for (const k of ['neb1', 'neb2', 'neb3', 'nebAlpha', 'star1', 'star2', 'starDensity',
      'spike', 'spikeAlpha', 'ring', 'ringAlpha', 'core', 'shape', 'fxComposite', 'fxAlpha', 'mono']) {
      if (next[k] !== undefined) T[k] = next[k];
    }
    cache.clear();
  }

  return {
    retheme,
    setQuality: (q) => { Q = Math.max(0, Math.min(3, q | 0)); cache.clear(); },
    q: () => Q,
    shape: () => T.shape,
    core: () => T.core,
    drawBack, drawOrbits, drawCore, clusterGas, drawSpike, nodeSprite,
  };
})();
