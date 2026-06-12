# Workloop — ASCEND mission control

A local dashboard where your repo is the screen. The **galaxy** — a live radial
map of every file — fills the viewport; everything else slides in from the
edges. It scans your repo into task cards, and each card's **Run** fires a
headless Claude Code fix loop that works until your verifier passes, then
leaves you a committed branch.

**Zero npm dependencies.** Runs on Node alone and shells out to the `claude`,
`git`, and `gh` you already have.

```
                    ┌──────────────────────── HUD ────────────────────────┐
                    │ ☰  WORKLOOP  ⎇branch  search  ext-chips   ▶dev  ☷  │
   ┌── control ──┐  ├──────────────────────────────────────────────────────┤  ┌─── work ───┐
   │ repo/setup  │  │                                                      │  │ TASKS      │
   │ branches    │  │                  THE GALAXY                          │  │  needs work│
   │ run locally │  │        every file a star, every run a comet          │  │  queue     │
   │ commands    │  │                                                      │  │ ACTIVITY   │
   │ engine      │  │                                                      │  │  live log  │
   │ themes ×16  │  │                                                      │  │ COPILOT    │
   │ about       │  │                                                      │  │  chat +    │
   └──── [ ──────┘  └──────────────────────────────────────────────────────┘  │  handoffs  │
                                                                              └──── ] ─────┘
```

## Quick start

1. **Double-click `start.command`** (first time: right-click → Open — macOS
   gatekeeps downloaded scripts). Your browser opens the dashboard.
2. No repo yet? The control center opens itself — paste your repo path, hit
   **Detect from repo**, **Save & scan**.
3. Click **Run** on a task card. Done.

Prefer the terminal? `npm start`. Port busy? `PORT=4318 npm start`.
Prerequisites: Node 18+, Claude Code CLI, git (`gh` only if you turn on PRs).

## The screen

**The galaxy (everywhere).** Your repo as a radial tree — directories are hubs,
files are dots sized by bytes and colored by type. Scroll to zoom, drag to pan,
click a directory to open it, double-click to fit. While an agent works you see
it live: amber pulses on the files being edited, light streaming along their
paths, a green firework when the run lands. `heat` recolors by commit recency.
**Search** (`/` or `⌘K`) fuzzy-finds any file and flies the camera to it;
hovering shows a clickable breadcrumb; the extension chips spotlight one
language at a time; clicking a file offers **Open in editor / Reveal in
Finder / Copy path**.

**Right drawer `]` — the work panel.**
- **Tasks** — failing checks (verified ✓: types, tests, lint, build) and your
  queued goals (review-only). Run, Run all, discard. Hovering a card spotlights
  its file on the map.
- **Activity** — one live stream of everything: scans, run progress, git ops,
  dev-server output, command output, chat. Filter chips per source; `verbose`
  reveals raw agent lines. Survives reloads (the server replays recent events).
- **Copilot** — chat with Claude *about* this repo (read-only tools by
  default, so it's safe even mid-run). When something needs *your* hands —
  Cloudflare, Vercel, DNS, secrets, app-store consoles — instructions arrive
  as **handoff cards**: numbered steps, copy buttons on every command,
  Mark-done when you've done them. Failed runs and known dev-server launch
  blockers file handoffs automatically.

**Left drawer `[` — the control center.** Repo path + auto-detect, remote URL,
branches (switch / create / commit with an AI-written message / discard /
merge → main), dev command, **saved commands** (name + shell line, run in the
repo with output in Activity), engine settings, verifier commands, and
**Appearance**: sixteen themes that restyle everything including the galaxy —
mission-control, hacker, rainbow, lava, fire, rainy, synthwave, deep-space,
arctic, solar, ocean, forest, sakura, cyberpunk, midnight, paper. Most have
ambient weather (matrix rain, embers, snow, petals…) — toggleable, automatically
off under reduced-motion.

## How a Run works

1. Refuses to start on a dirty tree (it never scoops up your in-progress edits).
2. Creates a branch: `workloop/<source>-<slug>-<id>`.
3. Invokes `claude -p` in your repo with a tight tool scope and capped turns.
   The agent edits, runs your verifier itself, and keeps fixing until green.
4. **Independent gate:** Workloop re-runs the verifier itself — a card can't
   lie to you.
5. Commits with a conventional message. With `openPR` on → pushes + `gh pr create`.

A Run only ever **creates a branch and a commit**. It never merges, deploys, or
runs migrations — that's your click, in Branches. One run at a time by design;
saved commands and runs also exclude each other (single writer). The copilot
chat is read-only, so it can run alongside anything.

## Files

- `start.command` — double-click launcher
- `server.mjs` — dashboard + API; serves `public/` fresh on every request
  (edit the UI, just reload the browser)
- `bus.mjs` — the activity event bus (`GET /api/events`, SSE)
- `chat.mjs` / `handoffs.mjs` / `commands.mjs` — copilot, handoff store, saved commands
- `scanner.mjs` — repo → task cards (`.workloop/tasks.json`)
- `runner.mjs` — one task: guard → branch → agent loop → verify → commit → PR
- `env.mjs` — login-PATH capture + claude binary discovery
- `public/` — the dashboard (`index.html`, `css/*`, `js/*`)
- `workloop.config.json` — settings (managed from the control center)
- `.workloop/` — state: tasks, chat session, handoffs, dismissed cards

## API sketch

`/api/tasks` `/api/scan` `/api/status` `/api/config` `/api/detect`
`/api/backlog` `/api/task/discard` — board · `/api/run?id=` (SSE) — runs ·
`/api/events` (SSE) — activity bus · `/api/chat` (NDJSON stream) `/api/chat/history`
`/api/chat/reset` — copilot · `/api/handoffs` `/api/handoffs/resolve|dismiss` ·
`/api/commands/run|stop|status` · `/api/git/state|switch|branch|commit|merge|discard` ·
`/api/dev/start|stop|status` · `/api/repotree[?heat=1]` `/api/repotree/status` —
galaxy data · `/api/open` — editor/Finder.

## Troubleshooting

- **Engine: claude not found** — Workloop searches your login PATH and common
  installs. If yours is custom, set the full path in Engine & agent → Recheck.
- **"working tree has uncommitted changes"** — a handoff card appears with the
  fix; Commit or Discard in Branches.
- **Dev server won't boot** — known blockers (Xcode setup, busy port, Expo
  login) file handoffs automatically with the exact commands to run.
- **A check shows failing but the script doesn't exist** — missing npm scripts
  are skipped and noted; use Detect to align commands with reality.

## Cost note

From **June 15, 2026**, `claude -p` / Agent SDK usage on subscription plans
draws from a separate monthly Agent SDK credit, distinct from your interactive
limit. `agent.maxTurns` caps a single task; chat is capped by `chat.maxTurns`.
