/* quality.js — the graphics-complexity dial. One global level (0–3) that
   every visual system reads: the galaxy scenery, the fx layer, the ambient
   weather canvas, and the CSS-only ambients (via html[data-fx]).
     0 Lite      — flat map, no atmosphere, no ambient weather (original look)
     1 Balanced  — starfield + orbits + spikes, light ambient
     2 High      — everything on (default)
     3 Ultra     — denser starfield, richer nebulae, max particles */
const Quality = (() => {
  const NAMES = ['Lite', 'Balanced', 'High', 'Ultra'];
  const AMBIENT_MUL = [0, 0.55, 1, 1.6]; // particle-count multiplier for ambient.js
  const listeners = [];
  let level = parseInt(localStorage.getItem('wl.fx-level') ?? '2', 10);
  if (!(level >= 0 && level <= 3)) level = 2;

  function applyAttr() { document.documentElement.dataset.fx = String(level); }
  applyAttr();

  function set(l, persist = true) {
    l = Math.max(0, Math.min(3, l | 0));
    if (l === level) return;
    level = l;
    applyAttr();
    if (persist) localStorage.setItem('wl.fx-level', String(level));
    sync();
    for (const fn of listeners) fn(level);
  }

  /* slider wiring — present only on pages that show the control */
  function sync() {
    const r = $('#f-quality'), n = $('#q-name');
    if (r) r.value = String(level);
    if (n) n.textContent = NAMES[level];
  }

  let wired = false;
  function init() {
    if (wired) return;
    const r = $('#f-quality');
    if (r) {
      wired = true;
      sync();
      r.addEventListener('input', () => set(parseInt(r.value, 10)));
    }
  }

  /* self-init so no boot-sequence change is needed in main.js */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    init, set, sync,
    level: () => level,
    name: () => NAMES[level],
    mul: () => AMBIENT_MUL[level],
    onChange: (fn) => listeners.push(fn),
  };
})();
