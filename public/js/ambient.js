/* ambient.js — per-theme background weather on one canvas below the stage.
   Contract: ≤2ms/frame at ≤30fps, pooled particles (no allocation in step),
   parked when the tab is hidden / reduced-motion / ui.ambientFx off.
   CSS-only ambients (aurora-line, hue-aurora, retro-grid, sun-rays,
   scanlines) are styled in themes.css off body[data-ambient=…]; this module
   only runs the canvas ones. */

const Ambient = (() => {
  const canvas = $('#ambient');
  const ctx = canvas.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let enabled = true, current = 'none', theme = null, fx = null;
  let raf = 0, last = 0, W = 0, H = 0;
  let slowFrames = 0, degraded = 0;

  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const qmul = () => (typeof Quality !== 'undefined' ? Quality.mul() : 1);
  const area = () => Math.min(1.6, (W * H) / (1440 * 900)) * qmul(); // particle budget scales with viewport × quality dial

  /* one cached radial glow sprite per color (same trick as the galaxy) */
  const sprites = new Map();
  function glow(color, size = 64) {
    let s = sprites.get(color);
    if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = size;
    const c = s.getContext('2d');
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, color); g.addColorStop(1, 'transparent');
    c.fillStyle = g; c.fillRect(0, 0, size, size);
    sprites.set(color, s);
    return s;
  }

  /* ---------- effects ---------- */
  const FX = {
    rain: {
      fps: 30,
      init(t) {
        this.far = Array.from({ length: Math.round(70 * area()) }, () => ({ x: rnd(0, W), y: rnd(0, H), l: rnd(8, 14), v: rnd(180, 260) }));
        this.near = Array.from({ length: Math.round(40 * area()) }, () => ({ x: rnd(0, W), y: rnd(0, H), l: rnd(16, 26), v: rnd(420, 560) }));
        this.col = t.accent;
        this.nextFlash = performance.now() + rnd(18000, 40000);
      },
      step(dt, now) {
        ctx.lineCap = 'round';
        for (const [layer, alpha, wid] of [[this.far, .12, 1], [this.near, .25, 1.4]]) {
          ctx.strokeStyle = this.col; ctx.globalAlpha = alpha; ctx.lineWidth = wid;
          ctx.beginPath();
          for (const p of layer) {
            p.y += p.v * dt; p.x -= p.v * dt * 0.12;
            if (p.y > H + 30) { p.y = -30; p.x = rnd(0, W + 60); }
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x + p.l * 0.12, p.y + p.l);
          }
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        if (now > this.nextFlash) { // distant lightning
          this.nextFlash = now + rnd(18000, 40000);
          document.body.classList.add('amb-flash');
          setTimeout(() => document.body.classList.remove('amb-flash'), 130);
        }
      },
    },
    embers: {
      fps: 24,
      init(t) {
        const warm = [t.comet, t.changed, t.accent];
        this.ps = Array.from({ length: Math.round(50 * area()) }, () => ({
          x: rnd(0, W), y: rnd(H * .4, H + 40), v: rnd(20, 60), drift: rnd(.5, 2), ph: rnd(0, TAU),
          s: rnd(2, 5), c: warm[(Math.random() * warm.length) | 0], a: rnd(.15, .5),
        }));
      },
      step(dt, now) {
        for (const p of this.ps) {
          p.y -= p.v * dt;
          p.x += Math.sin(now / 900 + p.ph) * p.drift * 0.4;
          if (p.y < -20) { p.y = H + rnd(10, 60); p.x = rnd(0, W); }
          ctx.globalAlpha = p.a * (0.6 + 0.4 * Math.sin(now / 400 + p.ph));
          const s = p.s * 3;
          ctx.drawImage(glow(p.c), p.x - s, p.y - s, s * 2, s * 2);
        }
        ctx.globalAlpha = 1;
      },
    },
    matrix: {
      fps: 22,
      init(t) {
        this.fs = 14;
        this.cols = Array.from({ length: Math.ceil(W / 18) }, (_, i) => ({ x: i * 18 + 4, y: rnd(-H, 0), v: rnd(60, 200) }));
        this.glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄ0123456789';
        this.col = t.accent;
        this.fade = null; // resolved on first step from the page bg
      },
      step(dt) {
        if (!this.fade) {
          const bg = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g) || [5, 10, 6];
          this.fade = `rgba(${bg[0]},${bg[1]},${bg[2]},0.18)`;
        }
        ctx.fillStyle = this.fade;
        ctx.fillRect(0, 0, W, H); // trails
        ctx.font = this.fs + 'px ' + ((theme && theme.mono) || 'monospace');
        ctx.fillStyle = this.col;
        ctx.globalAlpha = .55;
        for (const c of this.cols) {
          c.y += c.v * dt;
          if (c.y > H + 40) { c.y = rnd(-200, -20); c.v = rnd(60, 200); }
          ctx.fillText(this.glyphs[(Math.random() * this.glyphs.length) | 0], c.x, c.y);
        }
        ctx.globalAlpha = 1;
      },
      opaque: true, // paints its own trails; don't clearRect
    },
    snow: {
      fps: 30,
      init(t) {
        this.ps = Array.from({ length: Math.round(90 * area()) }, () => ({
          x: rnd(0, W), y: rnd(0, H), v: rnd(14, 50), sway: rnd(8, 26), ph: rnd(0, TAU), s: rnd(1, 2.6),
        }));
        this.col = t.labelDir || '#fff';
      },
      step(dt, now) {
        ctx.fillStyle = this.col;
        ctx.globalAlpha = .5;
        ctx.beginPath();
        for (const p of this.ps) {
          p.y += p.v * dt;
          const x = p.x + Math.sin(now / 1600 + p.ph) * p.sway;
          if (p.y > H + 6) { p.y = -6; p.x = rnd(0, W); }
          ctx.moveTo(x + p.s, p.y);
          ctx.arc(x, p.y, p.s, 0, TAU);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      },
    },
    stars: {
      fps: 20,
      init(t) {
        this.ps = Array.from({ length: Math.round(140 * area()) }, () => ({
          x: rnd(0, W), y: rnd(0, H), s: rnd(.5, 1.6), tw: Math.random() < .12, ph: rnd(0, TAU), v: rnd(1.2, 4),
        }));
        this.col = t.labelDir || '#cdd6e4';
      },
      step(dt, now) {
        ctx.fillStyle = this.col;
        ctx.beginPath();
        ctx.globalAlpha = .4;
        for (const p of this.ps) {
          p.x -= p.v * dt; // slow drift
          if (p.x < -2) p.x = W + 2;
          if (p.tw) continue;
          ctx.moveTo(p.x + p.s, p.y);
          ctx.arc(p.x, p.y, p.s, 0, TAU);
        }
        ctx.fill();
        for (const p of this.ps) { // twinklers drawn individually
          if (!p.tw) continue;
          ctx.globalAlpha = .25 + .45 * Math.abs(Math.sin(now / 700 + p.ph));
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.s + .4, 0, TAU);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      },
    },
    bubbles: {
      fps: 30,
      init(t) {
        this.ps = Array.from({ length: Math.round(40 * area()) }, () => ({
          x: rnd(0, W), y: rnd(0, H + 80), v: rnd(18, 55), w: rnd(4, 14), ph: rnd(0, TAU), s: rnd(1.5, 5),
        }));
        this.col = t.accent;
      },
      step(dt, now) {
        ctx.strokeStyle = this.col;
        ctx.globalAlpha = .22;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (const p of this.ps) {
          p.y -= p.v * dt;
          const x = p.x + Math.sin(now / 1100 + p.ph) * p.w * 0.3;
          if (p.y < -10) { p.y = H + rnd(10, 80); p.x = rnd(0, W); }
          ctx.moveTo(x + p.s, p.y);
          ctx.arc(x, p.y, p.s, 0, TAU);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    },
    fireflies: {
      fps: 24,
      init(t) {
        this.ps = Array.from({ length: Math.round(26 * area()) }, () => ({
          x: rnd(0, W), y: rnd(H * .25, H), a: rnd(0, TAU), va: rnd(-.6, .6), v: rnd(8, 22), ph: rnd(0, TAU), s: rnd(2, 4),
        }));
        this.col = t.changed; // warm glow
      },
      step(dt, now) {
        for (const p of this.ps) {
          p.a += p.va * dt;
          p.x += Math.cos(p.a) * p.v * dt;
          p.y += Math.sin(p.a) * p.v * dt * .6;
          if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10;
          if (p.y < H * .15) p.y = H * .15; if (p.y > H + 10) p.y = H * .4;
          const blink = Math.max(0, Math.sin(now / 800 + p.ph));
          if (blink < .05) continue;
          ctx.globalAlpha = .5 * blink;
          const s = p.s * 3;
          ctx.drawImage(glow(this.col), p.x - s, p.y - s, s * 2, s * 2);
        }
        ctx.globalAlpha = 1;
      },
    },
    petals: {
      fps: 30,
      init(t) {
        this.ps = Array.from({ length: Math.round(36 * area()) }, () => ({
          x: rnd(0, W), y: rnd(-H, 0), v: rnd(26, 60), sway: rnd(14, 40), ph: rnd(0, TAU), s: rnd(3, 6), rot: rnd(0, TAU), vr: rnd(-1.5, 1.5),
        }));
        this.col = t.accent;
      },
      step(dt, now) {
        ctx.fillStyle = this.col;
        ctx.globalAlpha = .35;
        for (const p of this.ps) {
          p.y += p.v * dt;
          p.rot += p.vr * dt;
          const x = p.x + Math.sin(now / 1300 + p.ph) * p.sway * .5;
          if (p.y > H + 10) { p.y = rnd(-60, -10); p.x = rnd(0, W); }
          ctx.save();
          ctx.translate(x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.ellipse(0, 0, p.s, p.s * .55, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      },
    },
    /* ---------- second-generation effects ---------- */
    aurora: { // northern-light curtains: glow stamps riding layered sine ribbons
      fps: 30,
      init(t) {
        this.cols = [t.accent, t.neb2 || t.changed, t.neb3 || t.accent];
        this.bands = Array.from({ length: Math.max(2, Math.round(3 * Math.min(1.2, area() + .3))) }, (_, i) => ({
          y: H * (.1 + .15 * i), amp: rnd(28, 64), ph: rnd(0, TAU), sp: rnd(.45, .9), wl: rnd(.0022, .0042),
        }));
      },
      step(dt, now) {
        ctx.globalCompositeOperation = 'lighter';
        for (let bi = 0; bi < this.bands.length; bi++) {
          const b = this.bands[bi];
          const g = glow(this.cols[bi % this.cols.length]);
          for (let x = -20; x <= W + 20; x += 34) {
            const y = b.y + Math.sin(x * b.wl + now / 1000 * b.sp + b.ph) * b.amp
              + Math.sin(x * b.wl * 2.6 - now / 1400 * b.sp) * b.amp * .4;
            ctx.globalAlpha = .05 + .035 * Math.sin(x * .011 + now / 900 + b.ph);
            ctx.drawImage(g, x - 44, y - 44, 88, 88);     // soft body
            ctx.globalAlpha *= .8;
            ctx.drawImage(g, x - 11, y - 6, 22, 110);     // hanging curtain streak
          }
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    },
    accretion: { // a black hole behind the UI: tilted glowing disc, doppler-shaded
      fps: 30,
      init(t) {
        this.cx = W * .5; this.cy = H * .44;
        this.hole = Math.min(W, H) * .045 + 12;
        this.cols = [t.accent, t.cometHead || t.accent, t.changed];
        const max = Math.min(W, H) * .52;
        this.ps = Array.from({ length: Math.round(110 * area()) }, () => ({
          r: rnd(this.hole * 1.4, max), a: rnd(0, TAU), s: rnd(1.4, 4),
          c: this.cols[(Math.random() * this.cols.length) | 0],
        }));
        this.max = max;
      },
      step(dt, now) {
        ctx.globalCompositeOperation = 'lighter';
        for (const p of this.ps) {
          p.a += (90 / p.r) * dt;            // Kepler-ish: inner orbits race
          p.r -= 3.2 * dt;                   // slow infall
          if (p.r < this.hole * 1.15) { p.r = this.max * rnd(.85, 1); p.a = rnd(0, TAU); }
          const x = this.cx + Math.cos(p.a) * p.r * 1.16;
          const y = this.cy + Math.sin(p.a) * p.r * .42;  // tilted disc
          const front = Math.sin(p.a) > 0;
          const heat = Math.max(0, 1 - (p.r - this.hole) / (this.max - this.hole));
          ctx.globalAlpha = (front ? .3 : .12) * (.35 + heat * .65);
          const s = p.s * (1 + heat * 1.6);
          ctx.drawImage(glow(p.c), x - s * 2, y - s * 2, s * 4, s * 4);
        }
        /* the event horizon: black core + thin photon ring */
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = .92;
        ctx.fillStyle = '#000';
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, this.hole, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = .5 + .15 * Math.sin(now / 800);
        ctx.strokeStyle = this.cols[0];
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(this.cx, this.cy, this.hole + 1.5, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
    },
    plankton: { // bioluminescent motes + occasional jelly pulse rings
      fps: 24,
      init(t) {
        this.cols = [t.accent, t.neb3 || t.changed];
        this.ps = Array.from({ length: Math.round(55 * area()) }, () => ({
          x: rnd(0, W), y: rnd(0, H), vx: rnd(-6, 6), vy: rnd(-10, -2), ph: rnd(0, TAU), s: rnd(1.5, 3.6),
          c: this.cols[(Math.random() * 10) | 0 ? 0 : 1],
        }));
        this.pulses = [];
        this.next = performance.now() + rnd(3000, 8000);
      },
      step(dt, now) {
        ctx.globalCompositeOperation = 'lighter';
        for (const p of this.ps) {
          p.x += (p.vx + Math.sin(now / 1600 + p.ph) * 4) * dt;
          p.y += p.vy * dt;
          if (p.y < -8) { p.y = H + 8; p.x = rnd(0, W); }
          if (p.x < -8) p.x = W + 8; if (p.x > W + 8) p.x = -8;
          const blink = .35 + .65 * Math.max(0, Math.sin(now / 1100 + p.ph));
          ctx.globalAlpha = .3 * blink;
          const s = p.s * 3;
          ctx.drawImage(glow(p.c), p.x - s, p.y - s, s * 2, s * 2);
        }
        if (now > this.next) {
          this.next = now + rnd(4000, 10000);
          this.pulses.push({ x: rnd(W * .15, W * .85), y: rnd(H * .2, H * .85), t0: now, c: this.cols[1] });
        }
        for (let i = this.pulses.length - 1; i >= 0; i--) {
          const u = this.pulses[i];
          const p = (now - u.t0) / 2600;
          if (p >= 1) { this.pulses.splice(i, 1); continue; }
          ctx.globalAlpha = (1 - p) * .3;
          ctx.strokeStyle = u.c;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(u.x, u.y, 8 + p * 90, 0, TAU);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    },
    ash: { // eclipse fallout: grey flakes sinking, a few embers glowing through
      fps: 30,
      init(t) {
        this.ps = Array.from({ length: Math.round(70 * area()) }, () => ({
          x: rnd(0, W), y: rnd(0, H), v: rnd(12, 40), sway: rnd(6, 22), ph: rnd(0, TAU),
          s: rnd(.8, 2.2), hot: Math.random() < .14,
        }));
        this.ember = t.accent;
      },
      step(dt, now) {
        ctx.fillStyle = 'rgba(216, 196, 200, .8)';
        ctx.globalAlpha = .22;
        ctx.beginPath();
        for (const p of this.ps) {
          p.y += p.v * dt;
          const x = p.x + Math.sin(now / 1700 + p.ph) * p.sway * .4;
          if (p.y > H + 6) { p.y = -6; p.x = rnd(0, W); }
          if (p.hot) continue;
          ctx.moveTo(x + p.s, p.y);
          ctx.arc(x, p.y, p.s, 0, TAU);
        }
        ctx.fill();
        for (const p of this.ps) { // embers drawn with glow, individually
          if (!p.hot) continue;
          const x = p.x + Math.sin(now / 1700 + p.ph) * p.sway * .4;
          ctx.globalAlpha = .3 * (.5 + .5 * Math.sin(now / 500 + p.ph));
          const s = p.s * 4;
          ctx.drawImage(glow(this.ember), x - s, p.y - s, s * 2, s * 2);
        }
        ctx.globalAlpha = 1;
      },
    },
    golddust: { // slow shimmering gold motes, sinking like dust in candlelight
      fps: 24,
      init(t) {
        this.ps = Array.from({ length: Math.round(50 * area()) }, () => ({
          x: rnd(0, W), y: rnd(0, H), v: rnd(6, 22), sway: rnd(4, 14), ph: rnd(0, TAU), s: rnd(1, 2.6),
        }));
        this.col = t.accent;
      },
      step(dt, now) {
        ctx.globalCompositeOperation = 'lighter';
        const g = glow(this.col);
        for (const p of this.ps) {
          p.y += p.v * dt;
          const x = p.x + Math.sin(now / 2100 + p.ph) * p.sway;
          if (p.y > H + 6) { p.y = -6; p.x = rnd(0, W); }
          ctx.globalAlpha = .28 * (.3 + .7 * Math.abs(Math.sin(now / 900 + p.ph * 2)));
          const s = p.s * 3;
          ctx.drawImage(g, x - s, p.y - s, s * 2, s * 2);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    },
    nebdrift: { // huge gas pools breathing across the page
      fps: 20,
      init(t) {
        this.cols = [t.neb1 || t.accent, t.neb2 || t.changed, t.neb3 || t.accent];
        this.ps = Array.from({ length: Math.max(4, Math.round(7 * Math.min(1.2, area() + .3))) }, (_, i) => ({
          x: rnd(0, W), y: rnd(0, H), r: rnd(140, 340), ph: rnd(0, TAU), sp: rnd(.3, .8),
          c: this.cols[i % this.cols.length],
        }));
      },
      step(dt, now) {
        ctx.globalCompositeOperation = 'lighter';
        for (const p of this.ps) {
          const x = p.x + Math.sin(now / 9000 * p.sp + p.ph) * 70;
          const y = p.y + Math.cos(now / 11000 * p.sp + p.ph * 1.7) * 50;
          ctx.globalAlpha = .05 + .025 * Math.sin(now / 4000 + p.ph);
          ctx.drawImage(glow(p.c), x - p.r, y - p.r, p.r * 2, p.r * 2);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    },
  };

  /* ---------- engine ---------- */
  function resize() {
    W = innerWidth; H = innerHeight;
    const dpr = 1; // background weather doesn't need retina
    canvas.width = W * dpr; canvas.height = H * dpr;
    if (fx && fx.init) fx.init(theme || {});
  }

  function frame(now) {
    raf = 0;
    if (!fx) return;
    const interval = 1000 / (fx.fps || 30);
    if (now - last >= interval) {
      const dt = Math.min(0.1, (now - last) / 1000) || 0.033;
      last = now;
      const t0 = performance.now();
      if (!fx.opaque) ctx.clearRect(0, 0, W, H);
      fx.step.call(fx, dt, now);
      // self-throttle: stay under the 2ms budget or shrink, then bail
      if (performance.now() - t0 > 2) {
        if (++slowFrames > 60) {
          slowFrames = 0;
          degraded++;
          for (const k of ['ps', 'far', 'near', 'cols']) if (fx[k]) fx[k] = fx[k].filter((_, i) => i % 2 === 0);
          if (degraded > 2) { console.info('ambient: over budget — disabled for this session'); stop(); return; }
        }
      } else slowFrames = Math.max(0, slowFrames - 1);
    }
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (raf || !fx) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    ctx.clearRect(0, 0, W, H);
  }

  function set(id, t) {
    theme = t || theme;
    current = id || 'none';
    const live = enabled && !reduced.matches && qmul() > 0;
    // gate the attribute too — the CSS-only ambients key off body[data-ambient],
    // so when effects are off this must read 'none' or they keep animating
    document.body.dataset.ambient = live ? current : 'none';
    stop();
    fx = null;
    degraded = 0; slowFrames = 0;
    sprites.clear();
    if (!live) return;
    const e = FX[current];
    if (!e) return; // CSS-only or none
    fx = e;
    resize();
    start();
  }

  function setEnabled(b) {
    enabled = !!b;
    set(current, theme); // re-applies the data-ambient gate for CSS-only effects too
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (fx) start();
  });
  reduced.addEventListener?.('change', () => set(current, theme));
  addEventListener('resize', () => { if (fx) resize(); });
  if (typeof Quality !== 'undefined') Quality.onChange(() => set(current, theme)); // re-init with the new particle budget

  return { set, setEnabled };
})();
