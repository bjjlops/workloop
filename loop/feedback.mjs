// loop/feedback.mjs — the feedback loop (Layer 7) + the orchestrator's manifest.
//
// After every run the pipeline records a structured outcome to CLAUDE.md so the
// orchestrator can read prior runs and deprioritize what keeps failing (7.2),
// and CLAUDE.md slowly becomes the system's memory (7.3). The orchestrator's
// run manifest (the ordered tasks + generated prompts, written BEFORE any worker
// fires — Layer 1.6) also lives here.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../watch.mjs';
import * as memory from './memory.mjs';

const stateDir = join(memory.repoRoot, '.workloop');
export const manifestPath = join(stateDir, 'manifest.json');

const ensureState = () => { try { if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true }); } catch { /* */ } };

/**
 * Record a run outcome (Layer 5.6 + 7.1) — always writes a Run Log entry; on a
 * clean pass it banks a Lesson, on a fail it banks a Known Mistake so the next
 * run is forewarned.
 * @param {{date,title,result:'PASS'|'FAIL'|'PARTIAL',retries,notes,files,lesson?,mistake?}} o
 */
export function recordRun(o) {
  memory.appendRun(o);
  if (o.result === 'PASS' && o.lesson) memory.append(memory.SECTION.LESSONS, `- ${o.lesson}`);
  if (o.result !== 'PASS' && (o.mistake || o.notes)) {
    const why = (o.mistake || o.notes || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (why && why !== 'none') memory.append(memory.SECTION.KNOWN_MISTAKES, `- (${o.title}) ${why}`);
  }
}

export const recordLesson = (text) => memory.append(memory.SECTION.LESSONS, `- ${text}`);
export const recordMistake = (text) => memory.append(memory.SECTION.KNOWN_MISTAKES, `- ${text}`);

// ---------- run manifest (Layer 1.6) ----------
export function writeManifest(manifest) {
  ensureState();
  writeJsonAtomic(manifestPath, { ...manifest, generatedAt: manifest.generatedAt || null });
  return manifestPath;
}
export function readManifest() {
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
}
