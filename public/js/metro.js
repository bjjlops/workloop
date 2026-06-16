/* metro.js — "Metro" mode: a transit-diagram of the repo.
   The biggest top-level folders become coloured lines radiating in 8 compass
   directions; their files are stations laid out along the line, nested folders
   step sideways; everything left over clusters near the interchange at the
   centre. Connectors snap to 8 directions, so no in-between angle is possible. */
const RepoMetro = makeFlatViz({
  id: 'metro',
  label: 'Metro',
  layout(root, vis, ctx) {
    const GAP = 48;
    const D = [];
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 - Math.PI / 2; D.push([Math.cos(a), Math.sin(a)]); }
    const sizeOf = (v) => (v.n ? v.n.leaf || 1 : v.aggCount || 1);
    root.tx = 0; root.ty = 0; root._line = -1;
    const tops = root.kids.slice().sort((a, b) => sizeOf(b) - sizeOf(a));
    const lines = tops.filter((v) => !v.isAgg && v.n.type === 'dir' && v.kids.length).slice(0, 8);
    const rest = tops.filter((v) => !lines.includes(v));
    const PALS = ['ts', 'js', 'script', 'style', 'markup', 'sql', 'image', 'native'];
    lines.forEach((lv, li) => {
      const [dx, dy] = D[li], px = -dy, py = dx;
      const order = [];
      (function walk(v, depth) { order.push([v, depth]); for (const c of v.kids) walk(c, depth + 1); })(lv, 1);
      order.forEach(([v, depth], k) => {
        const along = (k < 40 ? k + 1 : 40 + Math.sqrt(k - 39) * 3) * GAP; // compress long tails
        const lvl = Math.min(4, depth - 1);
        const perp = lvl > 0 ? lvl * GAP * 0.5 * (depth % 2 ? 1 : -1) : 0;
        v.tx = dx * along + px * perp; v.ty = dy * along + py * perp;
        v._line = li; v._lineCol = ctx.THEME.pal[PALS[li % PALS.length]];
      });
    });
    const cen = VizLayout.phyllotaxis(rest.length, GAP * 0.8);
    rest.forEach((v, i) => {
      v.tx = cen[i][0]; v.ty = cen[i][1]; v._line = -1; v._lineCol = ctx.THEME.link;
      const sub = [];
      (function w(u) { for (const c of u.kids) { sub.push(c); w(c); } })(v);
      const off = VizLayout.phyllotaxis(sub.length, 11, i * 1.3);
      sub.forEach((c, j) => { c.tx = v.tx + off[j][0]; c.ty = v.ty + off[j][1]; c._line = -1; c._lineCol = ctx.THEME.link; });
    });
  },
  drawWorld(g, api) {
    const { vis, withAlpha, dimOf, inView, cam, THEME } = api;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const route = (x0, y0, x1, y1) => { // 45° diagonal then orthogonal — octolinear
      const dx = x1 - x0, dy = y1 - y0, diag = Math.min(Math.abs(dx), Math.abs(dy));
      const sx = x0 + Math.sign(dx) * diag, sy = y0 + Math.sign(dy) * diag;
      g.moveTo(x0, y0); g.lineTo(sx, sy); g.lineTo(x1, y1);
    };
    for (const v of vis) { // coloured lines between a station and its parent
      if (!v.parentV || (!inView(v) && !inView(v.parentV))) continue;
      const col = v._lineCol || THEME.link;
      g.strokeStyle = withAlpha(col, dimOf(v) ? 0.12 : 0.9);
      g.lineWidth = (v._line >= 0 ? 4.5 : 1.6) / cam.k;
      g.beginPath(); route(v.parentV.x, v.parentV.y, v.x, v.y); g.stroke();
    }
    for (const v of vis) { // stations: white core + coloured ring; interchanges (dirs) bigger
      if (!inView(v)) continue;
      const isHub = v.isAgg || (v.n && v.n.type === 'dir');
      const r = (isHub ? 4.5 : 3) / cam.k + (isHub ? 1.2 : 0);
      const col = v._lineCol || THEME.link, dim = dimOf(v);
      g.globalAlpha = dim ? 0.2 : 1;
      g.fillStyle = THEME.core; g.beginPath(); g.arc(v.x, v.y, r, 0, 6.2832); g.fill();
      g.strokeStyle = col; g.lineWidth = 1.8 / cam.k; g.beginPath(); g.arc(v.x, v.y, r, 0, 6.2832); g.stroke();
    }
    g.globalAlpha = 1;
  },
});
if (typeof VizMode !== 'undefined') VizMode.register('metro', RepoMetro, 'Metro');
