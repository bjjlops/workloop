#!/usr/bin/env node
// scanner.mjs — inspect the repo and produce work-loop task cards.
// Writes .workloop/tasks.json. No dependencies.

import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { childEnv } from './env.mjs';
import { userShell } from './platform.mjs';
import { writeJsonAtomic } from './watch.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(__dirname, 'workloop.config.json'), 'utf8'));
const repo = cfg.repoPath;
const stateDir = join(__dirname, '.workloop');
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });

if (!repo || !existsSync(repo)) {
  console.error(`workloop: repoPath not set or not found -> ${repo}`);
  writeJsonAtomic(join(stateDir, 'tasks.json'),
    { meta: { repo, counts: { needsWork: 0, shouldImplement: 0 }, notes: ['repoPath not set — open Settings'] }, tasks: [] });
  process.exit(1);
}

const ENV = childEnv();
function sh(cmd, cwd = repo) { // user-authored verifier commands — a shell is correct here
  const s = userShell(cmd);
  const r = spawnSync(s.bin, s.args, { ...s.opts, cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 30, env: ENV });
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
// Pure-Node walk (grep doesn't exist on Windows; this also drops the last
// external tool the scanner needed besides git).
if (cfg.sources.todos) {
  // user-dismissed TODOs stay in code but are hidden from the board
  let dismissed = [];
  try { dismissed = JSON.parse(readFileSync(join(stateDir, 'dismissed.json'), 'utf8')); } catch { /* none */ }
  const dismissedKeys = new Set(dismissed.map((d) => `${d.file}|${d.title}`));
  const TODO_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'css', 'scss', 'md']);
  const TODO_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.expo', '.turbo', '.cache', 'out']);
  const TODO_RE = /(TODO|FIXME|HACK)/;
  const hits = [];
  const stack = [''];
  while (stack.length && hits.length < 60) {
    const rel = stack.pop();
    let entries = [];
    try { entries = readdirSync(join(repo, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (hits.length >= 60) break;
      if (e.isSymbolicLink()) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!TODO_SKIP.has(e.name) && !e.name.startsWith('.')) stack.push(p); continue; }
      const dot = e.name.lastIndexOf('.');
      if (dot <= 0 || !TODO_EXT.has(e.name.slice(dot + 1).toLowerCase())) continue;
      let text;
      try { text = readFileSync(join(repo, p), 'utf8'); } catch { continue; }
      if (!TODO_RE.test(text)) continue;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < 60; i++) {
        if (TODO_RE.test(lines[i])) hits.push({ file: p, line: i + 1, content: lines[i] });
      }
    }
  }
  for (const h of hits) {
    const title = h.content.trim().slice(0, 140);
    if (dismissedKeys.has(`${h.file}|${title}`)) continue;
    add({
      id: id('todo', h.file, String(h.line)), source: 'todo', column: 'should-implement',
      title, file: h.file, line: h.line,
      detail: `${h.file}:${h.line}`, verifiable: false, verifyCmd: null,
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
writeJsonAtomic(join(stateDir, 'tasks.json'),
  { meta: { repo, generatedAt: new Date().toISOString(), counts, notes }, tasks });

console.log(`workloop: ${tasks.length} task(s) — ${counts.needsWork} needs-work, ${counts.shouldImplement} should-implement${notes.length ? ' | ' + notes.join('; ') : ''}`);
