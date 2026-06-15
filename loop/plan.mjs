// loop/plan.mjs — plan before execute (Layer 3).
//
// Before the writer touches a single file, a READ-ONLY agent produces a written
// plan: which files will change, the approach, and what could go wrong. The plan
// is the checkpoint (3.2) — execution only proceeds once it looks right
// (auto-approved for headless runs, human-approved otherwise). A good plan means
// one-shot execution: no mid-task back-and-forth, no half-done states (3.3).
//
// The plan agent gets Read/Glob/Grep only — never Edit/Write/Bash — so "planning"
// can never mutate the tree even if the model tries.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAgent } from './agent.mjs';
import * as memory from './memory.mjs';

const PLAN_TOOLS = 'Read,Glob,Grep';

export function planPath(id) {
  const dir = join(memory.repoRoot, '.workloop', 'plans');
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { /* */ }
  return join(dir, `${id}.md`);
}

function buildPlanPrompt(task, conventions, targetConventions) {
  const loc = task.file ? `LOCATION: ${task.file}${task.line ? ':' + task.line : ''}\n` : '';
  const ctx = task.detail ? `CONTEXT:\n${task.detail}\n` : '';
  const conv = conventions ? `\nREPO CONVENTIONS (from CLAUDE.md — follow these):\n${conventions}\n` : '';
  const tconv = targetConventions ? `\nTARGET PROJECT CONVENTIONS (its own CLAUDE.md):\n${targetConventions}\n` : '';
  return `You are the PLANNER in an automated fix loop. You may ONLY read, search, and grep — you must NOT edit anything. A separate writer agent will execute your plan.

TASK: ${task.title}
${loc}${ctx}${conv}${tconv}
Read the relevant files, then output a SHORT, concrete plan as markdown with exactly these sections:

## Files to change
- bullet list of file paths you expect the writer to touch (be specific)

## Approach
- the minimal change that satisfies the task, step by step

## Risks
- what could go wrong, adjacent code that might regress, and how to keep the change tightly scoped

Keep it under ~250 words. Do not write code — describe the change. Output ONLY the plan.`;
}

/**
 * Produce the written plan for a task. Returns { ok, plan, path, error? }.
 * @param {object} o { task, cwd, root, claudeBin, extraArgs, env, maxTurns, repo, emit }
 */
export async function makePlan(o) {
  const { task, cwd, claudeBin, extraArgs, env, emit = () => {} } = o;
  const prompt = buildPlanPrompt(task, memory.conventions(), memory.readTargetConventions(o.repo));
  const res = await runAgent({
    claudeBin, extraArgs, prompt,
    allowedTools: PLAN_TOOLS, permissionMode: 'acceptEdits', // read-only toolset; mode is moot without Edit
    maxTurns: Math.min(o.maxTurns || 12, 12), stream: true,
    cwd, root: o.root || cwd, env, emit,
  });
  if (res.error) return { ok: false, plan: '', path: null, error: res.error };
  if (res.sawAuthError) return { ok: false, plan: '', path: null, error: 'engine is not logged in' };
  const plan = (res.text || '').trim() || '(planner produced no output)';
  const path = planPath(task.id);
  try { writeFileSync(path, `# Plan — ${task.title}\n\n${plan}\n`); } catch { /* non-fatal — plan still returned */ }
  return { ok: true, plan, path };
}
