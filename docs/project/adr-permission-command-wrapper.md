# ADR: Convert Claude Code PermissionRequest from HTTP hook to command-wrapper

- Status: Proposed (CARD-02 deliverable)
- Author: Slaver-Architect-1 (EKET)
- Branch: `feature/permission-command-wrapper-46193`
- Upstream issue: anthropics/claude-code#46193 (still open)
- Related shipped work: PR #190 (CARD-01) narrowed matcher `""` → `"Bash"` on
  branch `feature/narrow-permission-matcher-46193` — mitigation only, not a
  fix.
- Implementation cards (downstream): CARD-03 (wrapper script), CARD-04
  (`src/server.js` adapt), CARD-05 (`hooks/install.js` migration), CARD-06
  (E2E + docs).
- Touch scope: this ADR only — no production code is modified by CARD-02.

## 1. Decision summary

We are replacing the Claude Code (CC) `PermissionRequest` registration in
`~/.claude/settings.json` from `type: "http"` (currently
`hooks/install.js:504-513`, posting to `http://127.0.0.1:23333/permission`)
with a `type: "command"` registration that points at a new long-running
Node script `hooks/clawd-permission-hook.js`. The wrapper is responsible
for:

1. Probing whether Clawd is alive (TCP/HTTP probe to `/state`).
2. If Clawd is alive, opening a long-poll HTTP `POST /permission` to the
   running server, waiting up to ~54s for the user's bubble decision, and
   translating the server response into the CC stdout decision schema.
3. If Clawd is **not** alive, or anything in the call chain fails, writing
   `{}` to stdout and exiting 0 — which CC interprets as "no decision",
   identical to how Codex's already-shipped command hook
   (`hooks/codex-hook.js:102-115` `buildCodexNoDecisionOutput`) handles
   server-down. CC then falls through to its native in-chat permission
   prompt.

This fixes #46193 because today, when Clawd is offline, the HTTP hook
returns `ECONNREFUSED` and CC silent-denies the tool call (see
`docs/guides/known-limitations.md` last row). With a command wrapper we
own the failure semantics: connect-refused → empty stdout → CC native
prompt, which is what the user expects.

The HTTP path (server-side `/permission` route) remains the bubble
delivery channel — we do *not* delete it. We only change who calls it.
The wrapper becomes the only HTTP client of `/permission` for CC; the
existing CC HTTP-hook registration is removed at install time. The
opencode and Codex branches in `src/server.js` (lines 722-816 and
821-898) are unaffected.

## 2. Source-of-truth references

All design choices below cite exact file:line so CARD-03/04/05 can
implement without rediscovering. Treat the citations as the contract.

| Concern | File | Lines | What it tells us |
|---|---|---|---|
| Current CC HTTP hook registration | `hooks/install.js` | 504-513 | `HTTP_HOOKS.PermissionRequest` posts to `/permission`, `timeout: 600` (sec) |
| HTTP-hook detection (for migration) | `hooks/install.js` | 357-375 | `isClawdPermissionUrl` / `isClawdPermissionHook` recognise stale entries |
| HTTP-hook removal helper | `hooks/install.js` | 424-468 | `removeMatchingHttpHooks` already handles entry/array shapes |
| Command-hook builder (Win PowerShell form) | `hooks/install.js` | 290-317 | `buildCommandHookSpec` — Windows uses `shell:"powershell"` + `& "node" "..."`. Required by AGENTS.md L145 |
| Command-marker registry key | `hooks/install.js` | 249, 504-513 | `MARKER = "clawd-hook.js"`. New wrapper needs its **own** marker (`clawd-permission-hook.js`) so reconcile/uninstall can target it independently |
| Server `/permission` Claude branch | `src/server.js` | 900-1030 | Default branch: long-poll `res`, `abortHandler` on `res.on("close")`, builds `permEntry` and pushes to `pendingPermissions` |
| Headless / passthrough / DND / agent-disabled fallbacks | `src/server.js` | 906-960 | All four already exist; wrapper must preserve their semantics |
| Server response builder | `src/permission.js` | 718-735 | `sendPermissionResponse(res, behaviorOrDecision, message, hookEventName)` writes 200 + `{hookSpecificOutput:{hookEventName,decision}}` |
| Codex parallel implementation | `hooks/codex-hook.js` | 89-131, 237-248, 257-270 | `sanitizeCodexPermissionDecision`, `buildCodexNoDecisionOutput`, `requestCodexPermission`, `main()` — verified against real Codex; the wrapper's stdout schema mirrors lines 106-115 except `hookSpecificOutput.decision` uses `permissionDecision`/`permissionDecisionReason` for CC (vs. `behavior`/`message` for Codex) |
| Sandbox-allowed deps | `AGENTS.md` | 112 | Hook scripts may only depend on Node built-ins + same-dir `server-config.js`, `shared-process.js`, `json-utils.js` |
| Probe + post helpers | `hooks/server-config.js` | 143-162, 277-334 | `probePort` (HTTP GET `/state` with 100ms default), `postPermissionToRunningServer` (timeoutMs default 590000, probeTimeoutMs default 100) |
| CC matcher narrowing precedent | PR #190 / branch `feature/narrow-permission-matcher-46193` | n/a | Already in upstream; the wrapper inherits matcher `"Bash"` |

## 3. Decision in one paragraph

Convert the CC `PermissionRequest` hook registration to a `type:"command"`
script that performs the HTTP call to Clawd from inside a Node child
process owned by CC. When Clawd is unreachable or misbehaves the wrapper
emits `{}` and exits 0; CC reads "no decision" and falls through to its
native chat-prompt flow. This is the same fail-open contract Codex
already uses (`hooks/codex-hook.js`), only the stdout schema differs to
match CC's `permissionDecision` field.

## 4. Protocol translation table

### 4.1 CC stdin → Clawd HTTP body

CC delivers the standard hook stdin payload (verified against
`hooks/codex-hook.js` lines 134-184 and the existing CC `/permission`
default branch `src/server.js` 900-960). Keys not listed are not used.

| CC stdin field | Type | HTTP `POST /permission` body field | Notes / source |
|---|---|---|---|
| `hook_event_name` | `"PermissionRequest"` | (gate; not forwarded) | Wrapper only proceeds when this equals `PermissionRequest`; mirrors `codex-hook.js:137` |
| `tool_name` | string | `tool_name` | `src/server.js:923` reads it; default `"Unknown"` if absent |
| `tool_input` | object | `tool_input` | Truncated server-side via `truncateDeep` (`src/server.js:925`). Wrapper passes through unchanged but bounded to 512 KiB body cap (`src/server.js:690` `bodySize > 524288`) |
| `tool_use_id` (or `toolUseId`/`toolUseID`) | string | `tool_use_id` | Normalized via `normalizeHookToolUseId` (`src/server.js:926-928`). Wrapper performs the same trim/empty-string normalization the Codex hook does (`codex-hook.js:52-56`) |
| `session_id` | string | `session_id` | `src/server.js:930` defaults to `"default"`. Wrapper forwards verbatim — do **not** prefix with `claude:` (CC sessions are not namespaced server-side) |
| `cwd` | string | `cwd` (optional) | Forwarded for HUD/dashboard alias resolution; mirror `codex-hook.js:158` |
| `transcript_path` | string | `transcript_path` (optional) | Forwarded; mirror `codex-hook.js:163-165` |
| `permission_mode` | string | `permission_mode` (optional) | Forwarded; mirror `codex-hook.js:160-162` |
| `permission_suggestions` | array | `permission_suggestions` | `src/server.js:937-938` reads + normalizes via `normalizePermissionSuggestions` |
| (none — generated) | — | `agent_id: "claude-code"` | **Required.** Server uses this to pick the default branch (`src/server.js:916, 921, 936`). Without it the request is still routed to the default branch but agent gating misbehaves |
| (none — generated) | — | `request_id: <uuid>` | **NEW field, depends on CARD-04.** Wrapper-generated UUID v4. Server must echo + use for DELETE idempotency. See §8. |

The wrapper uses `crypto.randomUUID()` (Node ≥ 14.17 / 16; baseline OK
across all Clawd-supported Node runtimes; same import already used in
`hooks/codex-hook.js:5`).

### 4.2 Clawd HTTP response → CC stdout JSON

The server's default-branch responder is `sendPermissionResponse`
(`src/permission.js:718-735`). It writes:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" | "deny", "message": "..." }
  }
}
```

CC's command-hook stdout schema for PermissionRequest expects:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "..."
  }
}
```

So the wrapper must **translate**, not relay. Mapping:

| Server `decision.behavior` | Server `decision.message` | Wrapper stdout `permissionDecision` | Wrapper stdout `permissionDecisionReason` |
|---|---|---|---|
| `"allow"` | (any / absent) | `"allow"` | omit (CC tolerates missing reason on allow) |
| `"deny"` | string | `"deny"` | passthrough verbatim, capped at 1024 chars |
| `"deny"` | absent | `"deny"` | `"Denied by Clawd bubble"` (constant fallback) |
| anything else / parse fail | — | (no decision) | wrapper emits `{}` per §5 |

Note: the server **never** emits `"ask"` on this route, so the wrapper
also never emits `"ask"`. If a future server change does, the wrapper
forwards it through as-is via the same translation.

The server also has paths that bypass `sendPermissionResponse`:

| Server action | Wrapper-visible signal | Wrapper output |
|---|---|---|
| `res.destroy()` (DND, agent-disabled, bubbles-disabled) — `src/server.js:908, 919, 958` | TCP RST / premature socket close | `{}` (no decision) — CC native prompt fallback (intentional, see AGENTS.md L137) |
| `res.writeHead(400)` "bad json" | HTTP 400 body `"bad json"` | `{}` (defensive — wrapper's own JSON serializer should never trigger this, but if reached it's a bug, fail-open) |
| `res.writeHead(500)` "internal error" | HTTP 500 | `{}` |
| Auto-deny "request too large" | HTTP 200 + `behavior:"deny"` + message `"Permission request too large for Clawd bubble; answer in terminal"` (`src/server.js:696`) | translate normally — i.e. `permissionDecision:"deny"` with the verbatim message. Wrapper does **not** convert this back to `{}`; the user-visible "answer in terminal" prompt is the desired outcome |
| Auto-deny "headless session" (`src/server.js:943`) | HTTP 200 + `behavior:"deny"` | translate normally — `permissionDecision:"deny"` |
| Auto-allow `PASSTHROUGH_TOOLS` (`src/server.js:949`) | HTTP 200 + `behavior:"allow"` | translate normally — `permissionDecision:"allow"` |

## 5. Failure-mode matrix

The wrapper has **one** invariant: it must never cause CC to silent-deny
or to hang past CC's hook timeout (default 60s, see `hooks/install.js:510`
which currently sets HTTP `timeout: 600` *seconds* — we are deliberately
budgeting under the 60s CC default in §6 because the actual CC default is
60s for command hooks; the 600s on the HTTP entry was for HTTP hooks
specifically, see `src/permission.js` long-poll behaviour. We will not
inherit 600s into the command form). The fail-open policy: any
unexpected condition produces `{}` to stdout and exit 0.

| # | Failure | wrapper stdout | exit code | rationale |
|---|---|---|---|---|
| F1 | TCP/HTTP probe to `/state` fails within 50 ms | `{}` | 0 | Clawd offline → CC native prompt fallback. **Direct fix for #46193** |
| F2 | Probe succeeds but `POST /permission` connect refused (race: server died between probe and post) | `{}` | 0 | Treat same as F1 |
| F3 | TCP reset / socket close mid-response (`res.destroy()` from server DND/agent-disabled/bubbles-disabled) | `{}` | 0 | Server is explicitly delegating to CC native prompt; wrapper must propagate that |
| F4 | HTTP 4xx (400 bad json, 404, etc.) | `{}` | 0 | Defensive; wrapper-generated payload should not trigger 4xx |
| F5 | HTTP 5xx | `{}` | 0 | Server bug — never fail-closed |
| F6 | HTTP body parse error (response is non-JSON) | `{}` | 0 | Server bug or proxy interference |
| F7 | Decision-wait HTTP timeout (≤ 54s, §6) | `{}` + DELETE `/permission/<request_id>` (best effort) | 0 | User AFK / bubble stuck — let CC native prompt take over while we withdraw the bubble |
| F8 | Stdin parse error (CC handed us non-JSON) | `{}` | 0 | Don't crash CC |
| F9 | Stdin empty / not `PermissionRequest` event | `{}` | 0 | Off-event invocation; treat as no-op |
| F10 | Any uncaught throw (top-level try/catch) | `{}` | 0 | Defense in depth |
| F11 | User clicks **Allow** in bubble | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"allow"}}` | 0 | Translation of server `behavior:"allow"` |
| F12 | User clicks **Deny** in bubble | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"deny","permissionDecisionReason":"<msg>"}}` | 0 | Translation of server `behavior:"deny"` + `message` |
| F13 | Server auto-allow (PASSTHROUGH_TOOLS) | `permissionDecision:"allow"` | 0 | Pre-existing fast-path |
| F14 | Server auto-deny (headless / payload-too-large) | `permissionDecision:"deny"` + reason | 0 | Pre-existing fast-paths |
| F15 | CC sends SIGTERM / closes stdin (parent died) | best-effort `DELETE /permission/<request_id>` then exit 0 | 0 | Withdraw bubble; do not write stdout (CC is gone) |
| F16 | Wrapper itself receives SIGINT (user Ctrl-C in TTY mode for testing) | same as F15 | 0 | |

Edge invariants:

- **Never write any stdout other than the JSON line.** CC parses the
  whole stdout as JSON. The Codex hook writes one line followed by `\n`
  (`hooks/codex-hook.js:261` `process.stdout.write(\`${output}\n\`)`);
  we mirror that exactly.
- **Stderr is free.** Use stderr for diagnostics; CC ignores it for
  decision parsing.
- **No `console.log`.** It's stdout.
- **Exit code is always 0** even on failures. A non-zero exit would
  cause CC to log the hook as failed and may surface a user-facing
  error (TBD against CC source — for safety we always exit 0).

## 6. Timeout budget

CC's command-hook ceiling is 60s (per CC docs — verify against latest
docs in CARD-03; if CC's default has changed since this ADR was written,
adjust the wait-budget proportionally and keep the 950 ms safety
margin). Allocation:

| Phase | Budget | Source / rationale |
|---|---|---|
| TCP/HTTP `/state` probe | 50 ms | Loopback. `hooks/server-config.js:143-162` `probePort` defaults to 100 ms; Codex hook overrides to `probeTimeoutMs: 100` (`hooks/codex-hook.js:241-243`). 50 ms is enough on healthy loopback and bounds the ECONNREFUSED-fast-path under #46193 — we want CC native prompt to appear quickly |
| TCP connect + (no TLS — loopback HTTP) for `POST /permission` | 5 s | Generous for cold-start / event-loop pressure on the server. Loopback connect is normally <5 ms but Electron main can stall; 5 s avoids spurious F2 |
| Decision wait (long-poll body read) | 54 s | The user's bubble interaction window. Server has no internal timeout on the long-poll today; we cap from the wrapper side |
| Safety margin (translate output, write stdout, flush) | 950 ms | CC kills at 60s. We want to be done well before then |
| **Total** | **60 s** | |

Configurable via `CLAWD_PERMISSION_HOOK_TIMEOUT_MS` env var (mirroring
the Codex hook's `CLAWD_CODEX_PERMISSION_TIMEOUT_MS` pattern,
`hooks/codex-hook.js:30-34`), capped to 59000 ms hard upper bound. The
internal allocation (probe / connect / decision-wait) is derived from
the cap: `decision_wait = cap - 6000` so the budget shrinks
proportionally if the user lowers it.

## 7. Lifecycle / abort path

### 7.1 Wrapper-side (CARD-03)

| Trigger | Action |
|---|---|
| Stdin EOF after JSON parse | proceed to probe → POST → wait |
| `process.on("SIGTERM")` | issue best-effort `DELETE /permission/<request_id>` with 500 ms timeout, then `process.exit(0)`. Do not write stdout |
| `process.on("SIGINT")` | same as SIGTERM |
| `process.stdin.on("close")` (parent CC died before sending stdin EOF) | same as SIGTERM |
| Decision-wait timer fires | abort the in-flight `req` via `req.destroy()`, issue DELETE, write `{}` to stdout, exit 0 |
| Server returns 200 with parseable decision | translate, write to stdout, exit 0 (no DELETE — server already cleared the entry) |
| Server `res.destroy()` mid-response | write `{}` to stdout, exit 0 (server has already cleaned up; DELETE not needed but harmless) |

The wrapper holds **one** in-flight HTTP request at a time — there is
no concurrency. CC re-invokes the wrapper per PermissionRequest event.

### 7.2 Server-side (CARD-04 dependency)

Today the server has `res.on("close", abortHandler)` which already
triggers `resolvePermissionEntry(permEntry, "deny", "Client
disconnected")` (`src/server.js:1012-1018`). For the wrapper this is
the **wrong** semantic: the wrapper closing the socket because of CC
SIGTERM should not record a *deny* — it should withdraw the bubble.
CARD-04 must:

1. **Echo `request_id`** from the request body into the `permEntry`
   (`src/server.js:997-1011`) and add a tag distinguishing
   "command-wrapper" Claude Code requests from legacy direct-HTTP CC
   requests during the migration window. Suggested tag:
   `permEntry.viaCommandWrapper = true` when `data.hook_source ===
   "claude-code-wrapper"`.
2. **DELETE `/permission/:request_id`** route. Idempotent: if the
   request_id is unknown (already resolved or expired), return 204.
   Otherwise pop the matching `permEntry` from `pendingPermissions`,
   dismiss the bubble, and respond 204. Do **not** call
   `resolvePermissionEntry` with "deny".
3. **Change `abortHandler` for wrapper entries** from
   `resolvePermissionEntry(..., "deny", ...)` to a no-op (the wrapper
   already issued DELETE, or will issue one — the server should not
   pre-emptively decide). For non-wrapper (legacy) entries, retain the
   existing deny-on-disconnect to avoid behaviour drift before
   migration finishes.
4. **TTL fallback.** Add a per-entry TTL (recommend 65 s — slightly
   longer than the wrapper's 60s budget so the wrapper's DELETE wins
   the race). On TTL fire, dismiss the bubble and clean the entry. No
   response is written (the wrapper has already been killed by CC).
5. **Idempotency on duplicate `request_id`.** If a POST arrives with a
   `request_id` already in `pendingPermissions` (rare — would imply CC
   re-fired the hook for the same tool_use_id), respond `{}` with
   no-decision and do not create a second bubble.

## 8. Sandbox compliance (AGENTS.md L112)

Allowed dependencies for the wrapper:

| Module | Source | Use |
|---|---|---|
| `crypto` | Node built-in | `randomUUID()` for `request_id` |
| `process` | Node built-in (global) | stdin/stdout/exit/signals |
| `./server-config` | same dir, already allowed | `postPermissionToRunningServer`, `discoverClawdPort`, `probePort`, `readHostPrefix`, `PERMISSION_PATH` |
| `./shared-process` | same dir, already allowed | `readStdinJson`, `createPidResolver`, `getPlatformConfig` |
| `./json-utils` | same dir, already allowed | only if a sanitizer is needed; otherwise omit |

**Disallowed and confirmed unused:** `fs`, `os`, `path`, `child_process`,
any third-party package. The wrapper does no filesystem I/O, spawns no
children, and does not read config files — `server-config.js` already
encapsulates `~/.clawd/runtime.json` reads via `readRuntimePort()`.

`http` is intentionally **not** imported directly; we route everything
through `postPermissionToRunningServer` (`hooks/server-config.js:318`)
to inherit the existing probe-then-post + port-fallback semantics, plus
the future DELETE helper which CARD-03 must add to `server-config.js`
(see §10 handoff).

PID resolution (`createPidResolver`) is included for parity with
`hooks/codex-hook.js:252-255` — the server's `permEntry` carries
`source_pid` for HUD focus / dashboard. Use the same `agentNames`
shape, mapping CC binaries: `{ win: new Set(["claude.exe","node.exe"]),
mac: new Set(["claude","node"]), linux: new Set(["claude","node"]) }`.
Final list to be confirmed by CARD-03 against `clawd-hook.js`'s
existing CC PID detection (open question §11).

## 9. Dependency on CARD-04 (explicit checklist)

`src/server.js` must add:

- [ ] Read `data.request_id` (string, required for wrapper requests; if
      missing, fall back to current behaviour for legacy direct-HTTP
      compatibility during migration).
- [ ] Stamp `permEntry.requestId` and `permEntry.viaCommandWrapper`
      flags in the Claude default branch (`src/server.js:997-1011`).
- [ ] New route `DELETE /permission/:id`. Implementation: locate
      `permEntry` by `requestId` in `pendingPermissions`, splice it
      out, call `dismissPermissionBubble(permEntry)` (or equivalent —
      align with `src/permission.js` existing dismiss helpers), respond
      204. If not found, respond 204 (idempotent).
- [ ] Per-entry TTL (default 65000 ms) with `setTimeout` cleared on
      resolve / DELETE.
- [ ] Idempotency: refuse duplicate `request_id` in POST with no-op
      200 + `{}` body.
- [ ] **No change** to opencode (`src/server.js:722-816`) or Codex
      (`src/server.js:821-898`) branches.
- [ ] Update tests under `test/server-permission-*.test.js` (existing
      suite — CARD-04 owns the scope).

## 10. Migration plan (CARD-05)

`hooks/install.js` flips registration from HTTP to command. Rules:

1. **Detection of stale HTTP entry** (must run before write):
   - Use existing `isClawdPermissionHook()` (`hooks/install.js:369-375`)
     and `isClawdPermissionUrl()` (`hooks/install.js:357-367`). They
     already match by `url` host/path — that match remains correct.
   - Remove every matching HTTP hook entry under
     `settings.hooks.PermissionRequest` via the existing
     `removeMatchingHttpHooks` helper (`hooks/install.js:424-468`).
2. **New marker constant**: introduce
   `PERMISSION_HOOK_MARKER = "clawd-permission-hook.js"` next to the
   existing `MARKER` (`hooks/install.js:249`). Detection of the new
   command entry uses inclusion check on `hook.command`, identical to
   the state hook's reconcile path (`hooks/install.js:340-353`).
3. **New command spec** built via existing
   `buildCommandHookSpec(nodeBin, scriptPath)` (`hooks/install.js:290-317`).
   This already produces:
   - macOS / Linux: `"<nodeBin>" "<scriptPath>"`
   - Windows: `{ shell: "powershell", command: '& "<nodeBin>" "<scriptPath>"' }`
     — required by AGENTS.md L145 (Windows bare `"node" "hook.js"` exits 1).
   - Remote (`CLAWD_REMOTE`): not applicable — CC HTTP hooks were never
     used over remote. Skip the remote branch for the permission wrapper
     (assert in code: `if (options.remote) throw` or just don't call it
     with remote=true).
4. **Removal entry** in the new `HTTP_HOOKS`: delete the
   `PermissionRequest` key (`hooks/install.js:504-513`). The hook moves
   from `HTTP_HOOKS` to a new `COMMAND_PERMISSION_HOOKS` constant (or
   merge into the existing `VERSIONED_HOOKS` machinery if version-gated).
5. **Idempotency**: re-running install must:
   - leave a healthy command entry untouched (matches by marker, command
     unchanged) — guaranteed by the existing `syncCommandHook` helper
     (`hooks/install.js:340-353`).
   - replace any leftover HTTP entry from a previous install with the
     command entry — guaranteed by step 1 + step 4.
   - leave user-authored unrelated hooks alone — guaranteed by the
     marker-scoped predicates.
6. **Matcher**: keep `"Bash"` (inherited from PR #190 / CARD-01). Do
   not regress to `""`.
7. **Uninstall** (`hooks/uninstall.js`): add the new marker to the
   removal predicate that already strips by `MARKER` /
   `AUTO_START_MARKER` / `LEGACY_AUTO_START_MARKER`
   (`hooks/install.js:819-826`).
8. **Settings watcher resync** (`src/server.js`
   `settingsNeedClaudeHookResync`, `entriesContainCommandMarker`,
   `entriesContainHttpHookUrl` — see test exports
   `src/server.js:1114-1117`): extend the resync trigger to fire if a
   stale HTTP entry is detected OR the new command marker is missing.

## 11. Risks & rejected alternatives

| Alternative | Why rejected |
|---|---|
| Bidirectional TLS proxy (Clawd ↔ CC) | Massive complexity for a single fail-open case; introduces cert lifecycle, port conflict, OS keychain prompts. Doesn't justify the cost when `{}` no-decision already exists in the CC contract |
| Keep HTTP, add a "Clawd-reach" detector that pre-checks before each tool call | Detector would have to live inside CC (we don't control it) or in a separate watchdog (race with the actual hook fire). Doesn't fix root cause |
| Wait for upstream fix (#46193) | Issue is open with no ETA; users hitting silent-deny today need a workaround on Clawd's side |
| Rewrite to use a SessionStart fallback hook that disables `/permission` registration if Clawd is offline | CC has already started the session by then; offline-detection at session-start does not help if Clawd dies mid-session |
| Skip the probe and rely on connect-refused | Probe is 50 ms and gives a clean fast path; without it we'd pay the 5s connect timeout on every offline-Clawd PermissionRequest, which exceeds the user's patience |

Risks (residual):

- **R1**: CC may, in a future release, change its command-hook stdout
  schema (`permissionDecision` → something else). Mitigation: pin the
  Codex parallel — both hooks share the same fragility. Detect via the
  CC version probe already present (`VERSIONED_HOOKS` machinery).
- **R2**: Wrapper spawn cost (Node cold start ~50-150 ms on macOS, up to
  ~400 ms on Windows). Acceptable: PermissionRequest is user-paced, not
  hot-path. Mitigation: do not require any heavy require() in the
  wrapper.
- **R3**: 60s wrapper budget is shorter than the previous 600s HTTP
  `timeout`. If a user wanders away mid-bubble for >54s, the wrapper
  emits `{}` and CC native prompt takes over. Acceptable; document in
  `docs/guides/known-limitations.md` (CARD-06).
- **R4**: Resolving Node binary path at install time (existing
  `resolveNodeBin`, `hooks/server-config.js:336-410`) can return `null`
  on non-Electron hosts with exotic PATH; install must short-circuit
  cleanly in that case (existing behaviour — preserve it).

## 12. Test plan handoff

### CARD-03 (wrapper script) — must verify

- [ ] Stdin JSON parse: valid → proceed; invalid → `{}` exit 0; empty → `{}` exit 0.
- [ ] Probe fail (port 23399, nothing listening): stdout `{}` within ~100 ms.
- [ ] Probe success + POST 200 allow: stdout `permissionDecision:"allow"` exit 0.
- [ ] Probe success + POST 200 deny + message: stdout `permissionDecision:"deny"` + reason verbatim.
- [ ] Probe success + server `res.destroy()` (mock): stdout `{}` exit 0.
- [ ] Probe success + server 5xx: stdout `{}` exit 0.
- [ ] Decision-wait timeout (mock server that holds res open >54s): stdout `{}` exit 0; DELETE issued.
- [ ] SIGTERM mid-wait: best-effort DELETE then exit 0; no stdout.
- [ ] `request_id` is a v4 UUID and is the same value used in both POST body and DELETE path.
- [ ] Windows PowerShell command form parses correctly (smoke test on Windows CI).
- [ ] No imports outside the AGENTS.md L112 allow-list (CI grep guard).

### CARD-04 (server.js) — must verify

- [ ] POST with `request_id` echoes into `permEntry.requestId`.
- [ ] DELETE on known id removes the entry, dismisses bubble, returns 204.
- [ ] DELETE on unknown id returns 204 (idempotent).
- [ ] TTL fires at 65s, cleans up entry, no stdout side-effect.
- [ ] Duplicate `request_id` POST → 200 `{}` no-op; original entry untouched.
- [ ] Legacy POST without `request_id` (transitional) still works the old way (deny on disconnect).
- [ ] opencode/Codex branches untouched (regression test).

### CARD-05 (install.js) — must verify

- [ ] Fresh install registers the command hook with marker
      `clawd-permission-hook.js`; no HTTP entry remains under
      `PermissionRequest`.
- [ ] Re-install over an existing command-hook entry is a no-op (no
      file write).
- [ ] Re-install over a stale HTTP-style entry replaces it
      atomically; user-authored sibling hooks under
      `PermissionRequest` survive.
- [ ] Uninstall removes the new marker.
- [ ] Windows install produces `{ type:"command", shell:"powershell",
      command:'& "node" "..."' }`; bare `"node" "..."` form is
      rejected.
- [ ] Settings watcher resync detects a manually-restored stale HTTP
      entry and re-runs the installer.

### CARD-06 (E2E + docs) — must verify

- [ ] Real CC session, Clawd offline, Bash permission request → CC's
      native chat prompt appears (no silent deny). This is the primary
      #46193 acceptance criterion.
- [ ] Real CC session, Clawd online, click Allow → tool runs. Click
      Deny → tool aborts with reason in CC chat.
- [ ] Quit Clawd mid-bubble → DELETE arrives or TTL fires; CC sees
      `{}` and falls through to native prompt.
- [ ] User AFK >60s → wrapper times out, CC native prompt, no zombie
      bubble after Clawd resumes.
- [ ] Update `docs/guides/known-limitations.md` last row: remove the
      "silent deny on Clawd offline" entry; add a note about the 60s
      decision window.
- [ ] Verify on macOS, Windows (PowerShell command form), Linux.

## 13. Open questions (for Master review)

These could not be resolved from the codebase alone:

1. **CC command-hook ceiling.** The 60s figure used in §6 is the
   commonly-cited CC default but is not pinned in this repo's source.
   Codex uses 590s (`hooks/codex-hook.js:18` `CODEX_PERMISSION_TIMEOUT_MS`)
   because Codex's hook timeout is far more generous. CARD-03 must
   confirm CC's actual ceiling before locking the 54s wait.
2. **CC stdout schema field name.** `permissionDecision` vs.
   `decision` — Codex uses `decision` (`hooks/codex-hook.js:106-115`).
   The CC equivalent is widely documented as `permissionDecision`, but
   we have no in-repo CC command-hook example to cross-check (this
   ADR's whole premise is that we're introducing the first one).
   CARD-03 must validate against a real CC release before merge.
3. **PID resolver `agentNames` for CC.** The state hook
   (`hooks/clawd-hook.js`) likely already resolves this — CARD-03
   should mirror that exact set rather than guess.
4. **Whether CC honours `permissionDecision:"ask"`** (vs. allow/deny
   only). Current server never emits `behavior:"ask"` so this is
   theoretical, but worth a one-line check during CARD-03 testing.
5. **DELETE route auth.** The existing `/permission` route is
   loopback-only with no auth. Inheriting that for DELETE is fine but
   should be explicitly noted for the security-review pass.

