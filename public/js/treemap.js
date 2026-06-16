/* treemap.js — "Treemap" mode: squarified nested rectangles.
   Every folder is a padded frame; every file is a tile whose AREA is its byte
   size, coloured by type. A tile's position derives only from its value versus
   its siblings, recursively — so arbitrariness is impossible by construction.
   The most legible mode at thousands of files. */
const RepoTreemap = makeFlatViz({
  id: 'treemap',
  label: 'Treemap',
  pickMode: 'rect',
  layout(root) {
    const SIZE = 900;
    const valOf = (v) => Math.max(1, v.isAgg ? v.aggSize : (v.n.type === 'dir' ? v.n.total : v.n.size));
    const setNode = (v, r) => { v.rect = r; v.tx = r.x + r.w / 2; v.ty = r.y + r.h / 2; v.r = Math.max(1, Math.min(r.w, r.h) / 2); };
    setNode(root, { x: -SIZE / 2, y: -SIZE / 2, w: SIZE, h: SIZE });
    const rec = (v) => {
      if (!v.kids.length) return;
      const r = v.rect;
      const pad = Math.min(7, Math.min(r.w, r.h) * 0.05);
      const head = v.depth > 0 ? Math.min(16, r.h * 0.10) : 4;
      const ix = r.x + pad, iy = r.y + pad + head, iw = r.w - 2 * pad, ih = r.h - 2 * pad - head;
      if (iw <= 1 || ih <= 1) { for (const c of v.kids) setNode(c, { x: v.tx, y: v.ty, w: 0, h: 0 }); return; }
      const items = v.kids.map((c) => ({ value: valOf(c), ref: c }));
      VizLayout.squarify(items, ix, iy, iw, ih);
      for (const it of items) { setNode(it.ref, it.rect); rec(it.ref); }
    };
    rec(root);
  },
  drawWorld(g, api) {
    const { vis, colorOf, withAlpha, dimOf, inView, cam, THEME } = api;
    for (const v of vis) { // dir frames first
      const r = v.rect; if (!r || !v.kids.length || !inView(v) || r.w < 1) continue;
      const col = colorOf(v), dim = dimOf(v);
      g.globalAlpha = dim ? 0.03 : 0.06; g.fillStyle = col;
      g.fillRect(r.x, r.y, r.w, r.h);
      g.globalAlpha = dim ? 0.12 : 0.45; g.strokeStyle = col; g.lineWidth = Math.max(0.5 / cam.k, 0.8 / cam.k);
      g.strokeRect(r.x, r.y, r.w, r.h);
    }
    g.globalAlpha = 1;
    for (const v of vis) { // leaf tiles on top
      const r = v.rect; if (!r || v.kids.length || !inView(v) || r.w < 0.6) continue;
      g.globalAlpha = dimOf(v) ? 0.12 : 0.9; g.fillStyle = colorOf(v);
      const gap = Math.min(1 / cam.k, r.w * 0.08, r.h * 0.08);
      g.fillRect(r.x + gap, r.y + gap, Math.max(0, r.w - 2 * gap), Math.max(0, r.h - 2 * gap));
    }
    g.globalAlpha = 1;
    void withAlpha; void THEME;
  },
});
if (typeof VizMode !== 'undefined') VizMode.register('treemap', RepoTreemap, 'Treemap');
