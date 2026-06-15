# CLAUDE.md — workloop

> **Read this file before writing a single line of code in this repo.** Every
> agent that touches workloop — the orchestrator, the writer, the checker, or a
> human's Claude Code session — reads CLAUDE.md first. It is the project's
> conventions *and* its persistent memory (Run Log / Known Mistakes / Lessons
> below grow with every run).

## What this is

workloop is zero-dependency local mission control for a repo: it scans the repo
into task cards, runs a headless Claude Code fix loop per card until a verifier
passes, branches + commits the result (optionally a PR), and shows it live on a
galaxy map. It shells out to `claude`, `git`, and `gh`; it has no runtime deps.

## Architecture — read these to orient

- `server.mjs` — the dashboard HTTP/SSE server and orchestrator of runs. Holds
  the single-writer lock, the activity-bus mirror, and every `/api/*` route.
- `runner.mjs` — the **classic** run path: one agent → verify → branch + commit.
- `loop/` — the **loop-engineering** layer (orchestrator → worktree → plan →
  writer → checker → feedback). See "The loop system" below.
- `scanner.mjs` — repo → task cards (`.workloop/tasks.json`).
- `bus.mjs` — the activity event bus (`publish(kind, message, data)`, SSE,
  `events.jsonl`). `watch.mjs` — atomic JSON writes + cross-instance watchers.
- `env.mjs` — engine discovery + login-PATH capture. `platform.mjs` — every
  OS-specific behavior (shells, spawns, links, pickers).
- `findings.mjs` / `handoffs.mjs` — agent-fixable work vs. needs-your-hands work.
- `public/` — the single-page UI. `.workloop/` — local state (gitignored).

## Conventions — follow exactly

- **Language:** Node ESM `.mjs`, Node ≥18, **zero runtime dependencies** — do not
  add npm packages. Use named exports; small, focused helpers; and explanatory
  comments at the density of the surrounding file.
- **State files:** read with `JSON.parse(readFileSync(...))`; write with
  `writeJsonAtomic` (watch.mjs) — never leave a half-written file for the other
  instance to read.
- **Events:** emit via `bus.publish(kind, message, data)`; kinds are
  dot-namespaced (`run.status`, `git.commit`, `run.check`, …).
- **Process spawning (security):** argv form, NO shell, for anything carrying
  user/scan text — task titles, branch names, prompts (`runArgs` in
  `loop/agent.mjs`, `shArgs` in runner). Use a shell (`userShell`) ONLY for
  user-authored command strings (verifiers, dev command). Never let a title or
  path reach a shell string.
- **Cross-platform:** put OS-specific behavior in `platform.mjs`, nowhere else.
- **Commits:** `<module>: <short imperative>` subject (e.g. `findings: scope
  handoffs by repo`), optional wrapped body, footer
  `Co-Authored-By: Claude <model> <noreply@anthropic.com>`. The runner/pipeline
  auto-commit `<type>: <title>` + a `[workloop] task <id>` trailer.
- **PRs:** `gh pr create --fill`. `openPR` (config) gates auto-PR; it defaults
  **off** — commit on a branch, the operator merges.
- **Safety stance (non-negotiable):** an agent only ever creates a branch + local
  commit (in an isolated worktree) and optionally a PR. It NEVER merges into your
  working branch, deploys, or runs migrations.

## Verify requirements

workloop's own gate is **`npm run check`** = `npm run lint` (`scripts/check.mjs`,
which runs `node --check` on every source `.mjs`) **+ `npm test`** (`node --test`
over `test/*.test.mjs`, the zero-dep test net for pure helpers in `cards.mjs`,
`env.mjs`, `chat.mjs`, …). Run it before every commit; add a test next to an
existing one when you add a pure helper. A boot smoke test (`npm start`) covers
wiring the unit tests can't. For a *target* repo, the gate is its configured
verifier commands (`typecheck`/`test`/`lint`/`build` in workloop.config.json) —
the checker runs the runnable ones and skips missing npm scripts (never treats a
missing script as a failure).

## The loop system (built here)

Three run modes share one NDJSON contract (`{type: status|agent|file|done}` plus
loop-only `plan|check|phase|retry|manifest|task-done`):

- **Classic** — `/api/run` → `runner.mjs`. One agent, verify, commit.
- **Loop** (opt-in, `cfg.loop.enabled`) — `/api/run` → `loop/pipeline.mjs`:
  worktree → plan → write → check (retry ≤ `maxRetries`) → merge/PR → feedback.
- **Batch** — `/api/loop` → `loop/orchestrator.mjs`: read board + repo state +
  prior runs → write a manifest → drive a worker per task.

| Layer | File | Role |
|---|---|---|
| 0 memory | `loop/memory.mjs`, this file | conventions + Run Log + parser |
| 1 orchestrator | `loop/orchestrator.mjs` | order, enrich prompts, manifest, drive |
| 2 worktree | `loop/worktree.mjs`, `platform.linkDir` | isolated execution |
| 3 plan | `loop/plan.mjs` | read-only plan = the checkpoint |
| 4 writer | `loop/pipeline.mjs` (writer stage) | implement in the worktree |
| 5 checker | `loop/checker.mjs` | adversarial, separate process, read-only |
| 6 babysitter | `loop/babysitter.mjs` | watch CI, fix red (scaffold) |
| 7 feedback | `loop/feedback.mjs` | append outcome to this file |
| — core | `loop/agent.mjs` | shared engine spawn + stream parse |
| — CLI | `loop/cli.mjs` | `npm run loop <subcommand>` |

Config: `cfg.loop { enabled, worktrees, linkDirs, maxRetries, autoApprovePlan,
teardownOnFail, parallel }`. CLI: `npm run loop orchestrate|run|plan|check|
worktree|babysit|memory`.

## Scaffolded / TODO (next sessions)

- Orchestrator **parallel** fan-out across file-disjoint tasks (serial v1 ships).
- CI babysitter **fix-agent** auto-patch + re-push (watch + log fetch work today).
- **Human plan-approval** UI/endpoint (headless auto-approve works now).
- node_modules-link **post-merge verify fallback** (today: when the link fails the
  checker skips verifiers and the branch is left for the operator to verify).
- A front-end **"Loop" toggle** (run mode is config-driven for now).

## Known Mistakes

<!-- Append things that bit us, so no agent repeats them. Seeded from the build. -->

- A fresh `git worktree` contains only **tracked** files, so a target repo's
  gitignored `node_modules` is absent and `npm run typecheck`/eslint/jest fail on
  a **missing binary**, not a real defect. `loop/worktree.mjs` links `node_modules`
  in; when the link fails the checker must SKIP verifiers (mode
  `main-checkout-fallback`) rather than report a false failure.
- The galaxy file-event mapping (`loop/agent.mjs` → `makeFileMapper`) matches the
  agent's **canonical** paths against the run root AND its `realpath` —
  `os.tmpdir()` worktrees live under `/var/folders` → `/private/var` on macOS.
  Forget the realpath and every file event silently vanishes.
- The Run Log parser keys on lines that start with `### Run —`; never put a literal
  one in prose/examples or it parses as a bogus entry.

## Lessons Learned

<!-- Append what worked, so agents repeat it. Seeded from the build. -->

- Loop mode ships **off** by default: it triples agent calls per task and depends
  on worktree dependency-linking, so defaulting it on for a real repo is
  irresponsible. Enabling is a one-line config flip.
- **Reuse over rewrite:** the careful classic `runner.mjs` was kept intact and
  re-pointed at the shared `loop/agent.mjs` core, so the loop pipeline and the
  classic path share one battle-tested stream parser instead of forking it.
- The **checker is always a separate process** with read-only tools and an
  adversarial prompt — never the writer's context. A pass/fail verifier is not a
  review; the checker reads the diff and hunts for what's wrong.

## Run Log

<!-- Auto-appended after every loop run by loop/feedback.mjs. Each entry is an h3
     heading "Run — <ISO date> — <title>" followed by Result: / Retries: /
     Checker notes: / Files changed: lines. Empty until the first loop run. -->
