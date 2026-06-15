// cards.mjs — the single source of truth for task-card identity and shape.
//
// scanner.mjs (a full rescan) and server.mjs (surgical backlog/finding syncs)
// MUST emit byte-for-byte identical cards: the cross-instance sync compares
// JSON.stringify(current) === JSON.stringify(next), so both the id hash AND the
// property order have to agree, or two Workloop instances rewrite tasks.json at
// each other forever. Every card builder lives here so that contract is one
// definition, not three hand-mirrored copies.

import { createHash } from 'node:crypto';

// One definition of "an unchecked BACKLOG.md item" — the scanner, the surgical
// backlog sync, the queue-diff, and the runner's check-off all matched this with
// their own copy of the regex. Capture group 1 is the (untrimmed) item text.
export const BACKLOG_UNCHECKED_RE = /^\s*[-*]\s+\[ \]\s+(.*)$/;

// 8-char sha1 over '|'-joined parts — the stable card id used everywhere.
export const cardId = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 8);

// An unchecked BACKLOG.md item. `lineIdx0` is the 0-based file line (the id
// basis, matching the scanner); the card's human-facing `line` is 1-based.
// `rawTitle` is hashed as-is (the scanner ids off the raw capture) but trimmed
// for display.
export const backlogCard = (rel, lineIdx0, rawTitle) => ({
  id: cardId('backlog', String(lineIdx0), rawTitle),
  source: 'backlog', column: 'should-implement',
  title: String(rawTitle).trim(), file: rel, line: lineIdx0 + 1,
  detail: `From ${rel}`, verifiable: false, verifyCmd: null,
});

// An agent-fixable finding from the findings store (`f` carries an `fd_<hash>`
// id; the card id drops the `fd_` prefix).
export const findingCard = (f) => ({
  id: f.id.slice(3), source: 'finding', origin: f.source, findingId: f.id,
  column: 'needs-work', title: f.title, file: f.file || null, line: f.line || null,
  detail: f.detail || `reported by ${f.source}`, verifiable: false, verifyCmd: null,
});

// Board column tallies — recomputed after every task-list mutation.
export const recomputeCounts = (tasks) => ({
  needsWork: (tasks || []).filter((t) => t.column === 'needs-work').length,
  shouldImplement: (tasks || []).filter((t) => t.column === 'should-implement').length,
});
