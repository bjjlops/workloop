#!/usr/bin/env node
// scanner.mjs — inspect the repo and produce work-loop task cards.
// Writes .workloop/tasks.json. No dependencies.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv } from './env.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'workloop.config.json'), 'utf8'));
const repo = cfg.repoPath;
const stateDir = join(__dirname, '.workloop');
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

if (!repo || !existsSync(repo)) {
  console.error(`workloop: repoPath not set or not found -> ${repo}`);
  writeFileSync(join(stateDir, 'tasks.json'),
    JSON.stringify({ meta: { repo, counts: { needsWork: 0, shouldImplement: 0 }, notes: ['repoPath not set — open Settings'] }, tasks: [] }, null, 2));
  process.exit(1);
}

const ENV = childEnv();
function sh(cmd, cwd = repo) {
  const r = spawnSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 30, env: ENV });
  return { code: r.status ?? 1, out: r.stdout || '', err: r.stderr || '' };
}
const id = (...p) => createHash('sha1').update(p.join('|')).digest('hex').slice(0, 8);
const tail = (s, n = 24) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');

// package.json scripts — so a missing npm script is skipped, not shown as "failing"
let scripts = {};
try { scripts = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).scripts || {}; } catch { /* no package.json */ }
const notes = [];
function runnable(cmd, label) {
  if (!cmd) return false;
  const m = cmd.match(/^npm\s+(?:run\s+)?([\w:.-]+)/);
  if (m) {
    const name = m[1];
    const s = scripts[name];
    if (!s || (name === 'test' && /no test specified/i.test(s))) {
      notes.push(`skipped ${label} — no "${name}" script in package.json`);
      return false;
    }
  }
  return true;
}

const tasks = [];
const add = (t) => tasks.push(t);

// --- TypeScript errors (one card each when parseable) ---
if (cfg.sources.typeErrors && runnable(cfg.verifier.typecheck, 'typecheck')) {
  const { out, err, code } = sh(cfg.verifier.typecheck);
  // drop npm/yarn script-echo lines (e.g. "> tsc --noEmit") so they can't look like errors
  const text = `${out}\n${err}`.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  const re = /^(.*?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.*)$/gm;
  let m, found = 0;
  while ((m = re.exec(text))) {
    found++;
    const [, file, line, col, ts, msg] = m;
    add({
      id: id('ts', file, line, ts, msg), source: 'typescript', column: 'needs-work',
      title: msg.trim(), file: file.trim(), line: Number(line),
      detail: `${ts} at ${file.trim()}:${line}:${col}`,
      verifiable: true, verifyCmd: cfg.verifier.typecheck,
    });
  }
  if (!found && code !== 0) {
    add({
      id: id('ts', 'aggregate'), source: 'typescript', column: 'needs-work',
      title: 'Typecheck is failing', file: null, line: null,
      detail: tail(text), verifiable: true, verifyCmd: cfg.verifier.typecheck,
    });
  }
}

// --- Failing tests (aggregate, exit-code based) ---
if (cfg.sources.failingTests && runnable(cfg.verifier.test, 'tests')) {
  const { out, err, code } = sh(cfg.verifier.test);
  if (code !== 0) add({
    id: id('test'), source: 'test', column: 'needs-work',
    title: 'Failing tests', file: null, line: null,
    detail: tail(`${out}\n${err}`), verifiable: true, verifyCmd: cfg.verifier.test,
  });
}

// --- Lint errors (aggregate, exit-code based) ---
if (cfg.sources.lint && runnable(cfg.verifier.lint, 'lint')) {
  const { out, err, code } = sh(cfg.verifier.lint);
  if (code !== 0) add({
    id: id('lint'), source: 'lint', column: 'needs-work',
    title: 'Lint is failing', file: null, line: null,
    detail: tail(`${out}\n${err}`), verifiable: true, verifyCmd: cfg.verifier.lint,
  });
}

// --- Build (optional) ---
if (cfg.sources.build && runnable(cfg.verifier.build, 'build')) {
  const { out, err, code } = sh(cfg.verifier.build);
  if (code !== 0) add({
    id: id('build'), source: 'build', column: 'needs-work',
    title: 'Build is failing', file: null, line: null,
    detail: tail(`${out}\n${err}`), verifiable: true, verifyCmd: cfg.verifier.build,
  });
}

// --- TODO / FIXME / HACK comments (review-only) ---
if (cfg.sources.todos) {
  // user-dismissed TODOs stay in code but are hidden from the board
  let dismissed = [];
  try { dismissed = JSON.parse(readFileSync(join(stateDir, 'dismissed.json'), 'utf8')); } catch { /* none */ }
  const dismissedKeys = new Set(dismissed.map((d) => `${d.file}|${d.title}`));
  const inc = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'css', 'scss', 'md']
    .map((e) => `--include="*.${e}"`).join(' ');
  const { out } = sh(`grep -rInE "(TODO|FIXME|HACK)" ${inc} . 2>/dev/null | grep -v node_modules | head -n 60 || true`);
  for (const ln of out.split('\n').filter(Boolean)) {
    const m = ln.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    const [, file, line, content] = m;
    const cleanFile = file.replace(/^\.\//, '');
    const title = content.trim().slice(0, 140);
    if (dismissedKeys.has(`${cleanFile}|${title}`)) continue;
    add({
      id: id('todo', file, line), source: 'todo', column: 'should-implement',
      title, file: cleanFile, line: Number(line),
      detail: `${cleanFile}:${line}`, verifiable: false, verifyCmd: null,
    });
  }
}

// --- BACKLOG.md unchecked items (review-only) ---
if (cfg.sources.backlog) {
  const p = join(repo, cfg.sources.backlog);
  if (existsSync(p)) {
    readFileSync(p, 'utf8').split('\n').forEach((ln, i) => {
      const m = ln.match(/^\s*[-*]\s+\[ \]\s+(.*)$/);
      if (m && m[1].trim()) add({
        id: id('backlog', String(i), m[1]), source: 'backlog', column: 'should-implement',
        title: m[1].trim(), file: cfg.sources.backlog, line: i + 1,
        detail: `From ${cfg.sources.backlog}`, verifiable: false, verifyCmd: null,
      });
    });
  }
}

const counts = {
  needsWork: tasks.filter((t) => t.column === 'needs-work').length,
  shouldImplement: tasks.filter((t) => t.column === 'should-implement').length,
};
writeFileSync(join(stateDir, 'tasks.json'),
  JSON.stringify({ meta: { repo, generatedAt: new Date().toISOString(), counts, notes }, tasks }, null, 2));

console.log(`workloop: ${tasks.length} task(s) — ${counts.needsWork} needs-work, ${counts.shouldImplement} should-implement${notes.length ? ' | ' + notes.join('; ') : ''}`);
