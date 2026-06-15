#!/usr/bin/env node
// check.mjs — zero-dependency lint gate for Workloop itself.
//
// The project ships with no npm dependencies and is meant to run on Node alone,
// so its own verifier is built the same way: `node --check` every source file
// (catches syntax breakage across all of server/runner/scanner and the browser
// bundle) and surface a clear pass/fail. Pair it with `npm test` (node:test).
//
// Contributors who want deeper static analysis (no-undef across the implicit
// public/js global bundle, unused vars) can run `npx eslint .` — see eslint.config.mjs.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.git', '.workloop', '.claude', 'dist', 'build', 'coverage']);

function* sources(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) yield* sources(abs);
    else if (/\.(mjs|js|cjs)$/.test(name)) yield abs;
  }
}

const files = [...sources(root)].sort();
const failures = [];
for (const abs of files) {
  const rel = relative(root, abs);
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status !== 0) failures.push({ rel, err: (r.stderr || '').trim() });
}

if (failures.length) {
  console.error(`\n✗ syntax check failed for ${failures.length} file(s):\n`);
  for (const f of failures) console.error(`  ${f.rel}\n${f.err.split('\n').map((l) => '    ' + l).join('\n')}\n`);
  process.exit(1);
}
console.log(`✓ syntax OK — ${files.length} source files checked`);
