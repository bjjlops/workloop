/* pack.js — "Bubbles" mode: nested circle packing.
   Each folder is a translucent bubble that encloses its children; files are leaf
   circles sized by bytes. Position comes only from packing radii relative to
   siblings, so there is no angular slot that can look arbitrary. */
const RepoPack = makeFlatViz({
  id: 'pack',
  label: 'Bubbles',
  layout(root) {
    VizLayout.packHierarchy(root, { leafR: (n) => n.r, pad: 2.5, kids: (n) => n.kids });
    const walk = (v, px, py) => { v.tx = px; v.ty = py; for (const c of v.kids) walk(c, px + (c._dx || 0), py + (c._dy || 0)); };
    walk(root, 0, 0);
  },
  drawWorld(g, api) {
    const { vis, colorOf, dimOf, inView, cam } = api;
    for (const v of vis) { // container bubbles first (painter's order: parents behind)
      if (!v.kids.length || !inView(v)) continue;
      const col = colorOf(v), dim = dimOf(v);
      g.globalAlpha = dim ? 0.04 : 0.10; g.fillStyle = col;
      g.beginPath(); g.arc(v.x, v.y, v.r, 0, 6.2832); g.fill();
      g.globalAlpha = dim ? 0.12 : 0.5; g.strokeStyle = col;
      g.lineWidth = Math.max(0.6 / cam.k, v.r * 0.012);
      g.beginPath(); g.arc(v.x, v.y, v.r, 0, 6.2832); g.stroke();
    }
    g.globalAlpha = 1;
    const groups = new Map(); // leaves batched per color on top
    for (const v of vis) {
      if (v.kids.length || !inView(v)) continue;
      const col = colorOf(v), dim = dimOf(v), key = (dim ? 'd' : 'n') + col;
      let gr = groups.get(key); if (!gr) groups.set(key, (gr = { col, dim, arr: [] }));
      gr.arr.push(v);
    }
    for (const gr of groups.values()) {
      g.fillStyle = gr.col; g.globalAlpha = gr.dim ? 0.12 : 1;
      g.beginPath();
      for (const v of gr.arr) { g.moveTo(v.x + v.r, v.y); g.arc(v.x, v.y, v.r, 0, 6.2832); }
      g.fill();
    }
    g.globalAlpha = 1;
  },
});
if (typeof VizMode !== 'undefined') VizMode.register('pack', RepoPack, 'Bubbles');
