/* viz-layout.js — pure, view-independent layout kernels shared by the flat
   visualization modes (pack.js / heartwood.js / metro.js / treemap.js) and the
   galaxy's spiral layout. No DOM, no canvas, no globals beyond the one this
   file defines — so the SAME source loads in the browser as a classic-script
   global (`VizLayout`, like GalaxyCore) AND can be indirect-eval'd by the
   node:test net (the package is `type:module`, so a `.js` CommonJS export would
   be misread — the test reads this file and evaluates it instead).

   Everything here is deterministic: given the same input it returns the same
   geometry, so layouts don't reshuffle between reloads and the unit tests can
   assert exact invariants. */
const VizLayout = (() => {
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // ≈2.39996 rad — the sunflower angle
  const TAU = Math.PI * 2;

  /* ---- phyllotaxis: even "sunflower" offsets around an origin ----
     Point i sits at angle i·GOLDEN_ANGLE and radius scale·√i, which spreads
     points at constant areal density — no two share an angle, so nothing gets
     the thin arbitrary wedge the radial galaxy suffers from. */
  function phyllotaxis(n, scale, base) {
    base = base || 0; scale = scale || 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const a = base + i * GOLDEN_ANGLE;
      const r = scale * Math.sqrt(i + 0.5);
      out.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    return out;
  }

  /* ---- circle packing ----
     packSiblings places a set of circles (each {r}) with NO overlap by spiralling
     each one outward from the centre until it finds a free spot. Greedy and a hair
     looser than d3's front-chain packer, but it is short, obviously correct, and
     deterministic — the properties the synthesis flagged as load-bearing. Largest
     circles are placed first so the small ones fill the gaps. Mutates x,y on input. */
  function packSiblings(circles) {
    const placed = [];
    const order = circles
      .map((c, i) => [c, i])
      .sort((p, q) => q[0].r - p[0].r || p[1] - q[1]);
    for (const [c] of order) {
      if (!placed.length) { c.x = 0; c.y = 0; placed.push(c); continue; }
      const step = Math.max(0.5, c.r * 0.5);
      let fx = 0, fy = 0, found = false;
      for (let t = 0; t < 6000; t++) {
        const a = t * GOLDEN_ANGLE, rad = step * Math.sqrt(t);
        const x = rad * Math.cos(a), y = rad * Math.sin(a);
        let ok = true;
        for (const p of placed) {
          const dx = x - p.x, dy = y - p.y, rr = c.r + p.r;
          if (dx * dx + dy * dy < rr * rr - 1e-6) { ok = false; break; }
        }
        if (ok) { fx = x; fy = y; found = true; break; }
      }
      c.x = found ? fx : 0; c.y = found ? fy : 0;
      placed.push(c);
    }
    return circles;
  }

  /* A valid (area-weighted-centred) enclosing circle. Not the strict minimum,
     but always contains every input circle — which is all a container bubble or
     hit-test needs, and it can never produce the wrong (too-small) answer. */
  function enclose(circles) {
    if (!circles.length) return { x: 0, y: 0, r: 0 };
    let cx = 0, cy = 0, wsum = 0;
    for (const c of circles) { const w = c.r * c.r || 1; cx += c.x * w; cy += c.y * w; wsum += w; }
    cx /= wsum; cy /= wsum;
    let r = 0;
    for (const c of circles) r = Math.max(r, Math.hypot(c.x - cx, c.y - cy) + c.r);
    return { x: cx, y: cy, r };
  }

  /* Recursively pack a hierarchy. leafR(node)→radius for leaves; kids(node)→child
     array (defaults to node.children). Sets node.r on every node and, on each
     child, _dx/_dy = offset from its parent container's centre. Call placeAbsolute
     afterwards to turn those offsets into world coordinates. */
  function packHierarchy(root, opts) {
    opts = opts || {};
    const pad = opts.pad == null ? 2 : opts.pad;
    const leafR = opts.leafR || ((n) => n.r || 4);
    const kids = opts.kids || ((n) => n.children || []);
    const rec = (node) => {
      const ch = kids(node);
      if (!ch || !ch.length) { node.r = Math.max(1, leafR(node)); return node.r; }
      for (const c of ch) rec(c);
      const circles = ch.map((c) => ({ r: c.r + pad, ref: c, x: 0, y: 0 }));
      packSiblings(circles);
      const e = enclose(circles);
      for (const c of circles) { c.ref._dx = c.x - e.x; c.ref._dy = c.y - e.y; }
      node.r = Math.max(1, e.r + pad);
      return node.r;
    };
    rec(root);
    return root;
  }

  function placeAbsolute(root, x, y, opts) {
    opts = opts || {};
    const kids = opts.kids || ((n) => n.children || []);
    const rec = (node, px, py) => {
      node.x = px; node.y = py;
      for (const c of kids(node)) rec(c, px + (c._dx || 0), py + (c._dy || 0));
    };
    rec(root, x, y);
    return root;
  }

  /* ---- squarified treemap (Bruls/Huizing/van Wijk) ----
     One level: lays `children` (each {value}) into the rect (x,y,w,h) as tiles
     whose AREA is proportional to value and whose aspect ratio is kept as close
     to square as the running row allows. Sets child.rect = {x,y,w,h}. Recurse by
     calling again on a dir's own children inside its rect. Position is derived
     only from value-vs-siblings, so there is no angle to look arbitrary. */
  function squarify(children, x, y, w, h) {
    for (const c of children) c.rect = { x, y, w: 0, h: 0 };
    const nodes = children.filter((c) => c.value > 0);
    const total = nodes.reduce((s, c) => s + c.value, 0);
    if (total <= 0 || w <= 0 || h <= 0) return children;
    const scale = (w * h) / total;
    const items = nodes.map((c) => ({ c, a: c.value * scale }));
    let rx = x, ry = y, rw = w, rh = h, i = 0, row = [];
    const worst = (arr, len) => {
      if (!arr.length) return Infinity;
      let mx = -Infinity, mn = Infinity, sum = 0;
      for (const r of arr) { sum += r.a; if (r.a > mx) mx = r.a; if (r.a < mn) mn = r.a; }
      const s2 = sum * sum, l2 = len * len;
      return Math.max((l2 * mx) / s2, s2 / (l2 * mn));
    };
    const flush = (arr, vert) => {
      const sum = arr.reduce((s, r) => s + r.a, 0);
      const len = vert ? rh : rw;
      const thick = sum / len;
      let off = vert ? ry : rx;
      for (const r of arr) {
        const sz = r.a / thick;
        if (vert) { r.c.rect = { x: rx, y: off, w: thick, h: sz }; }
        else { r.c.rect = { x: off, y: ry, w: sz, h: thick }; }
        off += sz;
      }
      if (vert) { rx += thick; rw -= thick; } else { ry += thick; rh -= thick; }
    };
    while (i < items.length) {
      const vert = rw < rh;            // grow a column when the box is taller than wide
      const len = vert ? rh : rw;
      const next = items[i];
      if (row.length && worst([...row, next], len) > worst(row, len)) {
        flush(row, vert); row = [];
      } else { row.push(next); i++; }
    }
    if (row.length) flush(row, rw < rh);
    return children;
  }

  return { GOLDEN_ANGLE, TAU, phyllotaxis, packSiblings, enclose, packHierarchy, placeAbsolute, squarify };
})();

/* node:test reads this file and indirect-evals it; the browser ignores this line
   because `module` is undefined in a classic script. */
if (typeof module !== 'undefined' && module.exports) module.exports = VizLayout;
