// cards.test.mjs — pins the byte-for-byte task-card contract that scanner.mjs
// and server.mjs both depend on. The cross-instance sync compares
// JSON.stringify(current) === JSON.stringify(next), so a change to the id hash
// OR the property order silently breaks dedup. These golden values are that
// guard: if they change, update every card producer in lockstep.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cardId, backlogCard, findingCard, recomputeCounts } from '../cards.mjs';

test('cardId: stable 8-char sha1 of joined parts (golden)', () => {
  assert.equal(cardId('backlog', '0', 'do thing'), 'd4bfd051');
  assert.equal(cardId('backlog', '0', 'do thing'), cardId('backlog', '0', 'do thing')); // deterministic
  assert.equal(cardId('ts', 'a.ts', '5', 'TS2345', 'msg').length, 8);
});

test('backlogCard: exact shape, key order, and 0-based→1-based line', () => {
  const card = backlogCard('BACKLOG.md', 4, '  ship it  ');
  // JSON string equality pins property ORDER too (the sync compares stringified)
  assert.equal(JSON.stringify(card), JSON.stringify({
    id: '53ec04dc', source: 'backlog', column: 'should-implement',
    title: 'ship it', file: 'BACKLOG.md', line: 5,
    detail: 'From BACKLOG.md', verifiable: false, verifyCmd: null,
  }));
  // id is hashed off the RAW (untrimmed) title, matching the scanner
  assert.equal(card.id, cardId('backlog', '4', '  ship it  '));
});

test('findingCard: drops fd_ prefix, carries origin/findingId, in order', () => {
  const f = { id: 'fd_abc12345', source: 'chat', title: 'fix x', file: 'a.js', line: 3, detail: 'd' };
  assert.equal(JSON.stringify(findingCard(f)), JSON.stringify({
    id: 'abc12345', source: 'finding', origin: 'chat', findingId: 'fd_abc12345',
    column: 'needs-work', title: 'fix x', file: 'a.js', line: 3,
    detail: 'd', verifiable: false, verifyCmd: null,
  }));
});

test('findingCard: defaults when file/line/detail absent', () => {
  const card = findingCard({ id: 'fd_zzz99999', source: 'dev', title: 't' });
  assert.equal(card.file, null);
  assert.equal(card.line, null);
  assert.equal(card.detail, 'reported by dev');
});

test('recomputeCounts: tallies by column, tolerates empty', () => {
  assert.deepEqual(
    recomputeCounts([{ column: 'needs-work' }, { column: 'should-implement' }, { column: 'needs-work' }]),
    { needsWork: 2, shouldImplement: 1 });
  assert.deepEqual(recomputeCounts([]), { needsWork: 0, shouldImplement: 0 });
  assert.deepEqual(recomputeCounts(undefined), { needsWork: 0, shouldImplement: 0 });
});
