# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Authoritative Source

**`AGENTS.md` is the operational source of truth** for this repo — it lists every common command, every core file, every constraint, and every high-risk gotcha. Read it first; treat the sections below as a quick orientation, not a substitute.

Deeper background lives under `docs/project/` and `docs/guides/` (paths enumerated in `AGENTS.md` → "Read These Docs").

## What This Project Is

Clawd on Desk is an **Electron desktop pet** (CommonJS, Electron 41) that reacts in real-time to AI coding agent sessions. It integrates with Claude Code, Codex CLI, Copilot CLI, Cursor Agent, Gemini CLI, Kiro CLI, CodeBuddy, and opencode by installing per-agent **hooks / log monitors / plugins**, then driving a state machine that animates pixel-art themes (Clawd, Calico, plus user themes). Cross-platform: Windows / macOS / Linux; UI in en / zh / ko.

## Commands That Matter Most

```bash
npm start                         # launch via launch.js (boots Electron)
npm test                          # node --test test/*.test.js
node --test test/<file>.test.js   # run a single test file
npm run build:mac                 # platform-specific packaging (also build:win:x64, build:win:arm64, build:linux, build:all)
npm run create-theme              # scaffold a new theme via scripts/create-theme.js
```

Hook installers (each agent has its own; Clawd auto-syncs them at startup, these are for **debug / reinstall / remote**):

```bash
npm run install:claude-hooks      # also: cursor-hooks, gemini-hooks, kiro-hooks, kimi-hooks, codex-hooks
node hooks/codebuddy-install.js   # CodeBuddy and opencode have no npm script — run directly
node hooks/opencode-install.js
bash scripts/remote-deploy.sh user@host
```

Manual smoke tests (drive the state machine without a real agent):

```bash
bash test-demo.sh [seconds]       # full demo cycle
bash test-mini.sh [seconds]       # mini-mode cycle
bash test-macos.sh                # macOS-specific
bash test-oneshot-gate.sh [state] [seconds]
```

Copilot CLI is the **only supported agent that does NOT auto-sync hooks** — see `docs/guides/copilot-setup.md` for manual setup.

## High-Level Architecture

Three boundaries determine where any change belongs:

### 1. Event ingestion → state machine → render
```
hook scripts / log monitors / plugins
        │
        ▼
src/server.js  ── HTTP on 127.0.0.1:23333-23337 (port written to ~/.clawd/runtime.json)
        │       endpoints: /state, /permission
        ▼
src/state.js   ── state machine, multi-session merge, priority, auto-fallback, sleep/DND
        │
        ▼  (IPC)
src/renderer.js ── animation switching, SVG preload, eye tracking
```

`src/server.js` also: (a) async-installs missing hooks/plugins on boot, (b) **watches `~/.claude/settings.json`'s parent directory** (file-level watches die under atomic-replace on Windows) and reinstalls hooks if external tools wipe them, (c) keeps Codex official hooks as primary with JSONL polling fallback.

### 2. Window model
- **Two-window desktop pet**: a render window (display only, transparent) and an input/`hitWin` window (pointer events, drag). `hitWin.focusable = true` is intentional and load-bearing on Windows — do not revert.
- **Sessions Dashboard** (`src/dashboard.js` + `-renderer.js`) for session list / aliases / terminal jump.
- **Session HUD** (`src/session-hud.js` + `-renderer.js`) sits next to the pet, shows all non-headless / non-sleeping live sessions (including `badge=Done` idle ones — do **not** filter by `state !== "idle"`).
- **Permission bubbles** (`src/permission.js`) and **update bubble** (`src/update-bubble.js`) stack with collision avoidance against HUD and each other; any add/remove/measure must trigger update-bubble re-layout.
- **Mini mode** (`src/mini.js`) is a separate ingress; during `miniTransitioning`, every positioning path must check the protect-flag before `setPosition()`.

### 3. Settings system (single-writer invariant)
```
src/prefs.js → src/settings-controller.js → src/settings-store.js
                          ▲ only writer
```
`settings-store.js` is the source of truth (immutable snapshots). `settings-controller.js` is the **only** module allowed to write. Never bypass the controller. `src/settings-renderer.js` is the UI on top.

### Permission flow per agent (each is different — get this wrong and approvals silently drop)
- **Claude Code / CodeBuddy**: blocking approval over `POST /permission` HTTP hook; ordinary status events go through command hooks.
- **Codex** (official `PermissionRequest` command hook): hook script long-polls `POST /permission`; **only** sanitized `behavior` / `message` may be returned via stdout — `updatedInput`, `updatedPermissions`, `interrupt` MUST be omitted.
- **opencode**: `permission.ask` is unavailable; uses event hook + reverse bridge.
- **DND** never auto-decides for the user — opencode silent-drops, Claude/CodeBuddy disconnect to fall back to internal UI, Codex returns no-decision `{}`.

### Hook script constraints (binding for every file under `hooks/`)
- Only Node built-ins plus same-directory `server-config.js`, `shared-process.js`, `json-utils.js`. No npm deps.
- Stable terminal PIDs go through `getStablePid()` process-tree walk — `process.ppid` is wrong.
- Resource paths use `path.join(__dirname, ...)` always.
- When registering Claude Code hooks: **append only**, never overwrite the user's existing hook arrays.

## Testing Notes

- Pure-logic modules are covered by `npm test` (Node built-in test runner).
- Real-Electron behavior (transparent windows, tray, drag, foreground focus, cross-platform) is **manual**.
- Any `/permission` / `permission_suggestions` / `updatedPermissions` / elicitation change requires verification against a **real** Claude Code session — hand-rolled `curl` payloads are insufficient.
- Dev environment is **Windows-first**; macOS-only paths can't be QA'd locally — when touching mac logic, use code-review-first style and document residual risk explicitly.

## Branch / Release

- Windows NSIS releases must produce **distinct x64 and ARM64** installers: keep `${arch}` in `win.artifactName`; `nsis.buildUniversalInstaller` must stay `false`.
- Release publishing target: GitHub `rullerzhou-afk/clawd-on-desk` (configured in `package.json` → `build.publish`).
- Before editing release assets, copy into `assets/source/` first; do not mutate working assets of unknown provenance.

## Hard Don'ts (from AGENTS.md "Do Not Revisit" + gotchas — partial list, full set in AGENTS.md)

- Don't try to fix the Language sub-menu bottom-clipping. It's an Electron transparent-window + Windows DWM platform bug; multiple approaches have already been ruled out.
- Don't remove the `?_t=` cache-bust query on `<img>` SVGs in `src/renderer.js` — Chromium reuses the SVG animation timeline across same-URL loads, which freezes one-shot animations on the last frame.
- Don't replace `getStablePid()` with `process.ppid` shortcuts in hook scripts.
- Don't filter Session HUD by `state !== "idle"`.
- Don't drop `parent: win` from `contextMenuOwner` — combined with `closable: false` it's what keeps quit from deadlocking.
