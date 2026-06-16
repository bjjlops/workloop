/* heartwood.js — "Tree" mode: a literal branching tree.
   The root is the base; directories are boughs that fork upward by a fixed fan
   rule (deterministic, name-ordered), files are leaves at the tips. Branch length
   and thickness grow with the subtree's size — a lopsided folder gets a longer,
   heavier bough, never a skewed angle, which is the actual fix for "funny folders". */
const RepoTree = makeFlatViz({
  id: 'tree',
  label: 'Tree',
  layout(root) {
    const BASE = 130;
    const place = (v, x, y, dir, len, depth) => {
      v.tx = x; v.ty = y;
      const ch = v.kids, n = ch.length;
      if (!n) return;
      const spread = depth === 0 ? Math.PI * 1.25 : Math.min(Math.PI * 0.85, 1.15);
      ch.forEach((c, i) => {
        const f = n === 1 ? 0.5 : i / (n - 1);
        const ang = dir - spread / 2 + spread * f;
        const sz = c.n ? (c.n.type === 'dir' ? c.n.leaf : 1) : (c.aggCount || 1);
        const cl = len * (0.7 + 0.18 * Math.min(2, Math.log2(1 + sz) / 3));
        place(c, x + Math.cos(ang) * cl, y + Math.sin(ang) * cl, ang, len * 0.7, depth + 1);
      });
    };
    place(root, 0, 0, -Math.PI / 2, BASE, 0); // grow upward from the base
  },
  drawWorld(g, api) {
    const { vis, colorOf, withAlpha, dimOf, inView, THEME } = api;
    g.lineCap = 'round';
    for (const v of vis) { // boughs: thickness by subtree size, world units so they zoom
      if (!v.parentV || (!inView(v) && !inView(v.parentV))) continue;
      const leaf = v.n ? (v.n.type === 'dir' ? v.n.leaf : 1) : (v.aggCount || 1);
      g.strokeStyle = withAlpha(THEME.link, dimOf(v) ? 0.12 : 0.85);
      g.lineWidth = Math.max(0.5, Math.min(9, Math.sqrt(leaf) * 0.7));
      g.beginPath(); g.moveTo(v.parentV.x, v.parentV.y); g.lineTo(v.x, v.y); g.stroke();
    }
    const groups = new Map(); // leaves + joints as colored dots
    for (const v of vis) {
      if (!inView(v)) continue;
      const isLeaf = !v.kids.length, col = colorOf(v), dim = dimOf(v);
      const key = (dim ? 'd' : 'n') + col + (isLeaf ? 'L' : 'D');
      let gr = groups.get(key); if (!gr) groups.set(key, (gr = { col, dim, isLeaf, arr: [] }));
      gr.arr.push(v);
    }
    for (const gr of groups.values()) {
      g.fillStyle = gr.col; g.globalAlpha = gr.dim ? 0.12 : 1;
      g.beginPath();
      for (const v of gr.arr) { const r = v.r * (gr.isLeaf ? 1.15 : 0.8); g.moveTo(v.x + r, v.y); g.arc(v.x, v.y, r, 0, 6.2832); }
      g.fill();
    }
    g.globalAlpha = 1;
  },
});
if (typeof VizMode !== 'undefined') VizMode.register('tree', RepoTree, 'Tree');
