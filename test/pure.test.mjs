// pure.test.mjs — node:test (zero-dependency) coverage for the pure parsers and
// helpers Workloop relies on. These are imported directly; none of them touch
// .workloop/ state, so the suite is safe to run against a live install.
//
// Stateful modules (scanner.mjs runs a scan on import; handoffs/findings write
// to .workloop/) are intentionally NOT imported here. The byte-for-byte id-hash
// and task-card contracts are pinned in cards.test.mjs instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitCommand } from '../env.mjs';
import { fixesFromText, hasWriteTools } from '../chat.mjs';

test('splitCommand: bare binary', () => {
  assert.deepEqual(splitCommand('claude'), { bin: 'claude', extraArgs: [] });
});

test('splitCommand: binary with flags', () => {
  assert.deepEqual(splitCommand('claude --model claude-opus-4-8 --effort max'),
    { bin: 'claude', extraArgs: ['--model', 'claude-opus-4-8', '--effort', 'max'] });
});

test('splitCommand: empty/blank falls back to claude', () => {
  assert.deepEqual(splitCommand(''), { bin: 'claude', extraArgs: [] });
  assert.deepEqual(splitCommand('   '), { bin: 'claude', extraArgs: [] });
  assert.deepEqual(splitCommand(undefined), { bin: 'claude', extraArgs: [] });
});

test('splitCommand: collapses extra whitespace', () => {
  assert.deepEqual(splitCommand('  claude   --foo    bar '),
    { bin: 'claude', extraArgs: ['--foo', 'bar'] });
});

test('hasWriteTools: write toolsets', () => {
  assert.equal(hasWriteTools('Read,Edit,Bash'), true);
  assert.equal(hasWriteTools('Read,Write'), true);
  assert.equal(hasWriteTools('Read,NotebookEdit'), true);
});

test('hasWriteTools: read-only toolset', () => {
  assert.equal(hasWriteTools('Read,Glob,Grep'), false);
  assert.equal(hasWriteTools(''), false);
  assert.equal(hasWriteTools(null), false);
});

test('fixesFromText: no fence yields nothing', () => {
  assert.deepEqual(fixesFromText('just some prose, no fences'), []);
  assert.deepEqual(fixesFromText(''), []);
});

test('fixesFromText: plain issue lines (no location)', () => {
  const out = fixesFromText('```fix\nfix the broken import\nremove the dead flag\n```');
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { title: 'fix the broken import', file: null, line: null, detail: 'fix the broken import' });
  assert.equal(out[1].title, 'remove the dead flag');
});

test('fixesFromText: location prefix with line number', () => {
  const [f] = fixesFromText('```fix\nsrc/app.ts:42 — handle the null case\n```');
  assert.equal(f.title, 'handle the null case');
  assert.equal(f.file, 'src/app.ts');
  assert.equal(f.line, 42);
});

test('fixesFromText: location prefix without line number', () => {
  const [f] = fixesFromText('```fix\nsrc/util.js - drop the unused export\n```');
  assert.equal(f.title, 'drop the unused export');
  assert.equal(f.file, 'src/util.js');
  assert.equal(f.line, null);
});

test('fixesFromText: a bare word before a dash is NOT treated as a file', () => {
  // "foo" has no slash or dot, so it stays part of the title rather than a path
  const [f] = fixesFromText('```fix\nfoo — bar\n```');
  assert.equal(f.file, null);
  assert.equal(f.title, 'foo — bar');
});

test('fixesFromText: strips list markers', () => {
  const out = fixesFromText('```fix\n1. first thing\n- second thing\n```');
  assert.deepEqual(out.map((f) => f.title), ['first thing', 'second thing']);
});
