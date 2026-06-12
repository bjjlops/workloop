# Workloop

A local dashboard where your repo is the screen. The **galaxy** — a live map of
every file, in 2D or full 3D — fills the viewport; everything else slides in
from the edges. Workloop scans your repo into task cards, and each card's
**Run** fires a headless Claude Code fix loop that works until your verifier
passes, then leaves you a committed branch — and, if you want, a real PR on
GitHub.

**Zero npm dependencies.** Runs on Node alone and shells out to the `claude`,
`git`, and (optionally) `gh` you already have. macOS and Windows are supported;
Linux is best-effort.

```
                    ┌──────────────────────── HUD ────────────────────────┐
                    │ ☰  WORKLOOP  ⎇branch  2D/3D  search  ext-chips  ☷  │
   ┌── control ──┐  ├──────────────────────────────────────────────────────┤  ┌─── work ───┐
   │ repo picker │  │                                                      │  │ TASKS      │
   │ branches    │  │                  THE GALAXY                          │  │  needs work│
   │ run locally │  │        every file a star, every run a comet         │  │  queue     │
   │ commands    │  │     uncommitted work pulses until you commit        │  │ ACTIVITY   │
   │ engine      │  │                                                      │  │  live log  │
   │ themes ×16  │  │                                                      │  │ COPILOT    │
   │ 3D scene    │  │                                                      │  │  chat +    │
   └──── [ ──────┘  └──────────────────────────────────────────────────────┘  │  handoffs  │
                                                                              └──── ] ─────┘
```

## Quick start

**macOS** — double-click `start.command` (first time: right-click → Open —
Gatekeeper gatekeeps downloaded scripts).
**Windows** — double-click `start.cmd`.
**Anywhere** — `npm start`. Port busy? `PORT=4318 npm start`.

Then: the control center opens itself if no repo is set. Click **Browse…** to
pick any folder, or **Find repos on this machine** and click one. **Save &
scan**, then hit **Run** on a task card. Done.

**Prerequisites:** Node 18+ · [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)
(signed in: run `claude` once and `/login`) · git · `gh` only if you want
one-click PRs.

## The galaxy

Your repo as a living map — directories are hubs, files are stars sized by
bytes and colored by type. Two renderers, one click apart: the flat radial
**2D** map and a WebGL2 **3D** galaxy (spiral / shells / clusters layouts,
bloom, god rays — all tunable in **3D scene**).

- **Search** (`/` or `⌘K`) fuzzy-finds any file and flies the camera to it.
- **Click a file / right-click anything** → the node menu: **Peek** (first 120
  lines inline), **History** (recent commits), Open in editor, Reveal, Copy
  path, **Pin**, **Focus subtree** (dims everything outside a folder), **Queue
  a goal**, **Ask Copilot** — and a shortcut to any open task on that file.
- **heat** recolors by commit recency; extension chips spotlight a language;
  pinned files live under the empty search box.
- **Uncommitted changes pulse.** Files you haven't committed carry a slow
  breathing ring, and periodically emit a light-bending ripple across the
  screen (tune or disable it under **Appearance → Uncommitted ping**).
- While an agent works you see it live: amber pulses on the files being
  edited, light streaming along their paths, a green firework when a run lands.

## The drawers

**Right `]` — work panel.** **Tasks** (verified ✓ checks: types, tests, lint,
build — plus your queued goals), Run / Run all / discard, card hover spotlights
the file on the map. **Activity** — one live stream of scans, runs, git, dev
output, chat; filter chips; survives reloads. **Copilot** — chat about the repo
with read-only tools (safe mid-run); things needing *your* hands arrive as
**handoff cards** with numbered steps and copy buttons.

**Left `[` — control center.** **Repo picker** (current + recents + find-on-
machine + native folder dialog — switching re-detects commands, resets chat,
stops the old dev server), **Branches** (switch / create / commit with an
AI-written message / discard / merge → main / **Push ↑n / Sync ↓n / Open
PR** / push-after-commit), dev command, saved commands, **Engine & agent**
(below), verifier commands, and **Appearance** — sixteen themes restyling
everything including the galaxy, ambient weather, graphics quality, and the
uncommitted-ping tuner.

## GitHub, not just local

- The HUD branch chip shows `±n` uncommitted and `↑n` unpushed at all times.
- **Push** publishes the current branch (`git push -u origin`). **Sync** pulls
  fast-forward-only (never invents a merge). **Open PR** pushes if needed,
  then `gh pr create --fill` — or, without `gh`, opens GitHub's compare page.
- **push after each Commit** makes the Commit button a commit+push.
- With **open a PR after each run** enabled, every agent run ends with a real
  PR link on its card.

## Engine & models

Pick the engine in **Engine & agent**: binary path (auto-discovered from your
login PATH and common installs), **model picker** (Fable 5, Opus 4.8, Sonnet
4.6, Haiku 4.5, or CLI default), **effort** (shown only when your CLI supports
it), and free-form extra flags — the composed command is previewed live and
used for runs, chat, and AI commit messages alike. Any CLI that speaks the
same flags can be substituted via the binary field.

## How a Run works

1. Refuses to start on a dirty tree (it never scoops up your in-progress edits).
2. Creates a branch: `workloop/<source>-<slug>-<id>`.
3. Invokes the engine headlessly in your repo with a tight tool scope and
   capped turns. The agent edits, runs your verifier itself, keeps fixing.
4. **Independent gate:** Workloop re-runs the verifier — a card can't lie.
5. Commits with a conventional message. With `openPR` on → push + `gh pr create`.

A Run only ever **creates a branch and a commit**. It never merges, deploys,
or runs migrations — that's your click, in Branches. One writer at a time by
design (runs, saved commands, and write-chat exclude each other).

## Files & configuration

- `server.mjs` — dashboard + API; serves `public/` fresh on every request
- `platform.mjs` — every OS-specific behavior (shells, dialogs, process trees)
- `bus.mjs` / `chat.mjs` / `handoffs.mjs` / `commands.mjs` — events, copilot, handoffs, saved commands
- `scanner.mjs` — repo → task cards · `runner.mjs` — one task end-to-end
- `env.mjs` — login-PATH capture + engine discovery
- `workloop.config.json` — your settings (auto-created on first boot; personal,
  gitignored) · `.workloop/` — local state (tasks, chat session, handoffs)

## Platform notes

- **macOS** — Gatekeeper: right-click → Open the first time. If repo discovery
  skips Desktop/Documents, grant your terminal access in System Settings →
  Privacy (folders that stall are skipped, not hung on).
- **Windows** — use `start.cmd` or `npm start`. The native `claude.exe`
  install is preferred; npm's `claude.cmd` shim also works (Workloop resolves
  it safely — prompts never pass through `cmd.exe`). Saved commands and
  verifiers run under `cmd.exe`, so write them in cmd syntax.
- **Linux** — `npm start`. The folder picker needs `zenity`; engine sign-in
  prints the command to run in your own terminal.

## Troubleshooting

- **Engine: claude not found** — set the full path in Engine & agent → Recheck.
- **Not signed in** — the Sign in button opens a terminal with `claude /login`.
- **"working tree has uncommitted changes"** — Commit or Discard in Branches
  (the galaxy's pulsing rings show you exactly which files).
- **Push rejected** — Sync first (fast-forward only), then Push.
- **A check shows failing but the script doesn't exist** — missing npm scripts
  are skipped and noted; use Detect to align commands with reality.
- **3D galaxy is black** — WebGL2 unavailable; the 2D map keeps working.

## API sketch

`/api/tasks` `/api/scan` `/api/status` `/api/config` `/api/detect`
`/api/backlog` `/api/task/discard` — board · `/api/run?id=` (SSE) — runs ·
`/api/events` (SSE) — activity bus · `/api/chat` (NDJSON) `/api/chat/history|reset` ·
`/api/handoffs[/resolve|dismiss]` · `/api/commands/run|stop|status` ·
`/api/git/state|switch|branch|commit|merge|discard|push|sync|pr|log` ·
`/api/repos[?find=1]` `/api/pickfolder` — repo picker ·
`/api/dev/start|stop|status` · `/api/repotree[?heat=1]` `/api/repotree/status`
`/api/file` — galaxy data + peek · `/api/open` — editor/file manager.

## License

MIT — see [LICENSE](LICENSE).
