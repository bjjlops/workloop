/* viz-layout.test.mjs — deterministic checks on the pure layout kernels.

   public/js/viz-layout.js is a browser classic-script (global `VizLayout`) and
   the package is `type:module`, so it cannot be `import`ed as a module. We read
   the source and indirect-eval it — the trailing `VizLayout` is the program's
   completion value, which is what eval returns. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/js/viz-layout.js', import.meta.url), 'utf8');
// eslint-disable-next-line no-eval
const VizLayout = (0, eval)(src + '\n;VizLayout;');

test('exposes the kernel surface', () => {
  for (const k of ['GOLDEN_ANGLE', 'phyllotaxis', 'packSiblings', 'enclose', 'packHierarchy', 'placeAbsolute', 'squarify']) {
    assert.ok(k in VizLayout, `missing ${k}`);
  }
  assert.ok(Math.abs(VizLayout.GOLDEN_ANGLE - 2.39996) < 0.001);
});

test('phyllotaxis is deterministic and evenly spread', () => {
  const a = VizLayout.phyllotaxis(50, 3);
  const b = VizLayout.phyllotaxis(50, 3);
  assert.deepEqual(a, b, 'same input → same output');
  assert.equal(a.length, 50);
  // no two points coincide; nearest-neighbour distance is bounded below
  let minD = Infinity;
  for (let i = 1; i < a.length; i++) {
    for (let j = 0; j < i; j++) {
      minD = Math.min(minD, Math.hypot(a[i][0] - a[j][0], a[i][1] - a[j][1]));
    }
  }
  assert.ok(minD > 0.3, `points too close (minD=${minD})`);
});

test('packSiblings produces a non-overlapping, deterministic packing', () => {
  const mk = () => [3, 3, 3, 5, 8, 2, 6, 4, 7, 3, 5, 9].map((r) => ({ r }));
  const a = VizLayout.packSiblings(mk());
  for (let i = 1; i < a.length; i++) {
    for (let j = 0; j < i; j++) {
      const dx = a[i].x - a[j].x, dy = a[i].y - a[j].y;
      const d = Math.hypot(dx, dy), rr = a[i].r + a[j].r;
      assert.ok(d >= rr - 1e-3, `circles ${i},${j} overlap (d=${d.toFixed(3)} < ${rr})`);
    }
  }
  const b = VizLayout.packSiblings(mk());
  assert.deepEqual(a.map((c) => [c.x, c.y]), b.map((c) => [c.x, c.y]));
});

test('enclose contains every circle', () => {
  const circles = VizLayout.packSiblings([6, 4, 9, 3, 5, 7, 2].map((r) => ({ r })));
  const e = VizLayout.enclose(circles);
  for (const c of circles) {
    const d = Math.hypot(c.x - e.x, c.y - e.y) + c.r;
    assert.ok(d <= e.r + 1e-6, `circle escapes enclosure (${d.toFixed(3)} > ${e.r.toFixed(3)})`);
  }
});

test('packHierarchy sizes parents to contain children', () => {
  const tree = {
    children: [
      { children: [{ r: 4 }, { r: 4 }, { r: 4 }] },
      { children: [{ r: 6 }, { r: 3 }] },
      { r: 5 },
    ],
  };
  VizLayout.packHierarchy(tree, { leafR: (n) => n.r, pad: 1 });
  VizLayout.placeAbsolute(tree, 0, 0);
  assert.ok(tree.r > 0);
  for (const dir of tree.children) {
    if (!dir.children) continue;
    for (const leaf of dir.children) {
      const d = Math.hypot(leaf.x - dir.x, leaf.y - dir.y) + leaf.r;
      assert.ok(d <= dir.r + 1e-6, `child escapes its parent bubble (${d.toFixed(2)} > ${dir.r.toFixed(2)})`);
    }
  }
});

test('squarify conserves area and stays inside the rect', () => {
  const kids = [{ value: 10 }, { value: 6 }, { value: 4 }, { value: 3 }, { value: 1 }];
  VizLayout.squarify(kids, 0, 0, 100, 60);
  let area = 0;
  for (const k of kids) {
    const r = k.rect;
    area += r.w * r.h;
    assert.ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 100 + 1e-6 && r.y + r.h <= 60 + 1e-6,
      `tile escapes the rect: ${JSON.stringify(r)}`);
  }
  assert.ok(Math.abs(area - 100 * 60) < 1e-3, `area not conserved (${area} vs 6000)`);
});
