# DeepSeek Harness Integration

[Back to the setup guide](setup-guide.md)

Clawd's first DeepSeek Harness (DSH) integration is experimental and supports the
DSH `web` profile. A Clawd-managed plugin runs inside DSH and uses public APIs
for both state observation and ordinary blocking approvals. Clawd does not read
DSH's projection files and does not install a second monitor.

The compatibility gate admits a whole verified minor line while DSH remains a
developer preview. Clawd keeps two tables. The family table is the admission
rule: a host version is supported when it parses strictly, its `major.minor`
matches a family, and it is at or above that family's first verified release.
Build metadata (`+...`) is rejected.

| Family | Minimum admitted version | Range |
| --- | --- | --- |
| `0.2` | `0.2.0-rc.2` | `>=0.2.0-rc.2 <0.3.0-0` |
| `0.1` | `0.1.0-rc.6` | `>=0.1.0-rc.6 <0.2.0-0` |

The verified-artifact list is the one place that names concrete releases; new
generation markers and manual `npx` fallbacks pin to it:

| DSH version | npm artifact | npm integrity (sha512) |
| --- | --- | --- |
| `0.2.0-rc.2` (used when the host version is unknown) | `@deepseek-ai/dsh@0.2.0-rc.2` | `sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==` |
| `0.1.5-rc.3` | `@deepseek-ai/dsh@0.1.5-rc.3` | `sha512-c0W6Xqc4ChjFcCJkbzPeIxZQdnbKqe+QAcJzWGtogg0ZzsnZRcw3vopMyZ5oZU6E2fmyqGcyDR1sBeiCH4yHcg==` |
| `0.1.5-rc.1` | `@deepseek-ai/dsh@0.1.5-rc.1` | `sha512-rmNmzQCg3oIc1z8xH7izRSOuy1TNzq+/NILyfM+7e8DKOyV+yBtg47WEsqR2SiIe1ATec3L/rUa1YhIcfQ2XEg==` |
| `0.1.1-rc.2` | `@deepseek-ai/dsh@0.1.1-rc.2` | `sha512-UP1UIh6q3Gme/yXRn/QL2P8IsVlv8Shpg22TRJIZPsCRWLm4CBiA1MUvXmJAfsOEETBMLAl+xWPtFw6ICsN3wg==` |
| `0.1.0-rc.6` | `@deepseek-ai/dsh@0.1.0-rc.6` | `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==` |

Only the listed versions were verified by hand; a family is an admission rule,
not a claim that every release inside it was tested. Install and Repair select
the contract of the host's family; Uninstall and manual `npx` commands pin the
marker's own artifact when its version is listed, otherwise the family's newest
verified artifact. Two hosts in the same family share one generation, and the
marker keeps the version it was first staged for. Pre-family markers keep their
old exact `=<version>` range for hash verification. Adding a new minor line
means verifying and listing at least one artifact for it and adding a family
row. The public seams were first
audited against upstream commit `47f9438`, then rechecked in the compiled
rc.6 artifact; that commit is a source baseline, not a claimed tag mapping.
The `0.1.5-rc.1` row was added after re-checking the same four public seams
(`session/created`, `session/event`, `session/disposed`, and the
`approval/request` waterfall) in the published `0.1.5-rc.1` artifact. The
optional title and context-pressure projections were also checked against
the published rc.1 packages. A
controlled macOS session and approval smoke against a localhost mock Clawd
endpoint followed; its scope is
described below. The `0.1.5-rc.3` row was added after re-checking the same four
public seams (`session/created`, `session/event`, `session/disposed`, and the
`approval/request` waterfall) plus the optional title and context-pressure
projections in the published rc.3 artifact; a macOS real-machine run using the
real Clawd UI followed (see below).
The `0.2.0-rc.2` row was added after a read-only static audit of the published
`0.2.0-rc.2` artifact confirmed the same four public seams plus the optional
title and context-pressure projections, followed by the 2026-10-04 macOS
real-machine check described below. That check reused the rc.3 bridge generation
Clawd had already installed: its four bridge files were byte-identical to
`hooks/dsh-clawd-bridge` at main `fe3e1b01`, but the installer at the time did not
yet admit `0.2.0-rc.2`, so it was not an install performed by Clawd's installer.
A later 2026-10-04 run used the `0.2.0-rc.2` generation that Clawd's installer
produced and passed (see below). In `0.2.0-rc.2` a failed `tool/result` marks
`isError` on the message rather than on its content items; the bridge accepts
both shapes.
A version outside every family, or below its family's floor, fails before Clawd
changes the DSH profile.

## Behavior

The plugin observes `session/created`, `session/event`, and `session/disposed`.
It sends a minimal allowlisted payload to Clawd's dynamically discovered local
port; prompts, reasoning, tool arguments, tool results, environment variables,
and credentials are never forwarded. Per-session FIFO delivery plus DSH's
persistent event sequence prevents a late tool event from reviving a disposed
session.

| DSH public event | Clawd event / state |
| --- | --- |
| session created | `SessionStart` / `idle` |
| turn started | `UserPromptSubmit` / `thinking` |
| tool call | `PreToolUse` / `working` |
| successful tool result | `PostToolUse` / `working` |
| failed tool result | `PostToolUseFailure` / `error` |
| turn ended | `Stop` / `attention` (or `StopFailure` / `error`) |
| session disposed | `SessionEnd` / `sleeping` |

DSH's `session/title` event supplies the Session HUD and Dashboard title. When
the public session projection service is present, the plugin also follows
`contextPressure` changes and reads its current value when a session is
created. Clawd displays the same reference occupancy as DSH's ContextMeter:
`(projectedTokens ?? pressureTokens) / contextWindow`, rounded and capped at
100%. It appears only after DSH has reported both usage and model capacity.
The projection is a reference estimate, especially after content changes or a
model switch. Projection updates annotate an existing Clawd session without
creating a card or changing its activity time. If DSH no longer reports both
operands, Clawd clears the old percentage instead of displaying a stale one.
The standard completion bell appears when a finished DSH session is unread.

The quota coin is separate account telemetry. DSH does not currently expose
a five-hour usage bucket through this plugin's public session APIs, so Clawd
does not invent a DSH `5h` percentage. DeepSeek's
[API balance](https://api-docs.deepseek.com/api/get-user-balance/) is an amount
of money and cannot be represented as that rolling-window percentage.

For ordinary `approval/request`, the plugin prepends a blocking listener:

- Clawd **Allow** returns DSH `allowed-once`.
- Clawd **Deny** returns DSH `rejected`.
- HTTP 204, timeout, invalid response, DND, disabled integration, or unavailable
  Clawd calls `next()` so DSH's native web answerer remains authoritative.
- DSH cancellation aborts the pending HTTP request.
- `policy="never"` is enforced by DSH before listener dispatch and cannot be
  overridden by Clawd.

`ask_user_question` stays entirely in DSH's native provider. Clawd does not
replace private provider state, create a second question bubble, or auto-answer
questions. DSH approvals also remain manual when Clawd auto-tools or unattended
mode is enabled; per-session grants are not offered in this experimental release.

## Requirements

- A DSH host version inside a verified family on the same machine: `0.2` at or
  above `0.2.0-rc.2`, or `0.1` at or above `0.1.0-rc.6`.
- The `web` profile.
- `pnpm`, because the official DSH plugin command delegates profile mutation to
  pnpm.
- Preferably a global `dsh` CLI on `PATH` for automatic install, repair, and
  uninstall.

`DSH_HOME` is honored when it is a trimmed non-empty value; otherwise Clawd uses
`~/.dsh`.

## Install and repair

Open **Settings → Agents**, find **DeepSeek Harness (web, experimental)**, and
click **Install**. Install succeeds only after Clawd has:

1. copied the packaged bridge into an immutable hash generation under
   `~/.clawd/integrations/deepseek-harness/homes/<dsh-home-hash>/generations/`;
2. called `dsh plugin --profile web add <generation>`;
3. verified both DSH profile rows, the final profile-local package resolution,
   the Clawd ownership marker, protocol, compatibility range, and bundle hash.

The same operation is available for development:

```bash
npm run install:dsh
node hooks/dsh-install.js --repair
```

The `<dsh-home-hash>` namespace is derived from the canonical `DSH_HOME` path.
Separate DSH homes therefore never share a generation that one home's uninstall
or cleanup could delete.

If DSH is only used through `npx`, Clawd does not download it automatically.
Settings returns a manual `npx @deepseek-ai/dsh@<artifact> plugin ... add`
command pointing at the staged managed generation and explicitly setting the
canonical target `DSH_HOME` (PowerShell on Windows, POSIX environment-prefix
syntax elsewhere). The pinned artifact follows the owned marker: when the
marker's version is on the verified list it is used as-is; otherwise it is the
marker's family's newest verified artifact. With no marker at all it is the
preferred family's newest verified artifact. This keeps an
alternate home from accidentally mutating the
default `~/.dsh` when the command is pasted into a fresh terminal. After that command succeeds,
Install can verify the existing marker-owned plugin without requiring a global
CLI. The generation is protected by a Clawd-owned manual reference until it is
verified, replaced, or explicitly uninstalled; its marker records that the DSH
version was assumed at staging because no CLI version probe was available. A
malformed, foreign, or concurrently replaced reference fails closed, reports its
exact path, and retains managed generations for manual inspection.

Startup sync repairs only an already opted-in, installed-and-enabled integration.
It never initializes a missing DSH profile. Settings Install or explicit Doctor
Repair may allow the official CLI to initialize that profile. A running `dsh web`
process may need a restart after install or repair.

Upgrading the DSH host and Clawd separately has two paths. When only DSH is
upgraded and Clawd stays on the same version, startup sync keeps the existing
generation instead of staging a new one (it reports `generation-conflict`
internally). The kept generation already contains the bridge files from the
current Clawd version, but its marker still records the older DSH version. To
switch to the new contract right away, open **Settings → Agents**, click
**Uninstall** and then **Install** for DeepSeek Harness, and restart any running
`dsh web`. When Clawd itself is upgraded first and the installed generation was
staged by an older Clawd version, startup sync replaces that generation
automatically.

### Mutation lock recovery

Install, Repair, Uninstall, and cleanup share a per-`DSH_HOME` mutation lock.
Clawd automatically recovers a stranded lock only when its owner metadata is
valid, it is older than twice the operation timeout recorded by that owner, and
an OS PID probe returns `ESRCH` (the recorded process definitely no longer exists). A live
PID, `EPERM`, an unknown liveness result, or malformed/foreign owner metadata is
never taken over.

Lock errors include the exact `mutation.lock` path. If automatic recovery refuses
the lock, close every Clawd instance using that DSH home, verify the reported PID
is no longer running, and inspect `owner.json` at that exact path. Do not delete a
lock owned by a live or unknown process. Preserve malformed or foreign contents
for inspection; Clawd never recursively removes a canonical lock during owner
write failure or release, and only removes the exact isolated owner file plus an
empty lock directory.

## Uninstall and ownership safety

Use Settings → Agents → Uninstall, or:

```bash
npm run uninstall:dsh
```

Clawd verifies ownership before it calls the official remove command. A user
package or fork with the same package name is reported as a conflict and is never
overwritten or removed. Settings commits the uninstalled preference only after
the dependency row, bundle row, and resolved Clawd package are all gone.

`$DSH_HOME/profiles/node_modules` is DSH/pnpm's shared dependency fallback, not a
Clawd ownership anchor or cleanup target. Clawd may report what resolves there,
but it never rewrites or deletes that tree; pnpm owns any fallback-link cleanup.

Doctor reports DSH host detection separately from managed plugin disk health.
Disk health cannot prove that an already-running DSH process loaded the new
generation, so restart guidance remains conservative.

The installer and Doctor admit only a host whose `major.minor` matches a family
and that is at or above that family's floor before changing the profile; each
operation resolves its target from the detected host version, or from the owned
marker when no CLI probe is available, and never guesses from a range outside
those families. Upgrading from a pre-family exact generation is automatic when
the installed Clawd is newer: startup sync stages the family generation through
the normal Clawd-version rules. Running the same Clawd version from source
reports `generation-conflict` instead, and needs an explicit repair (Settings →
Agents: uninstall, then install; or Doctor's repair).

DSH does not currently expose a public host-version/activation seam to
external plugins, so an already-installed bridge cannot reliably disable itself
before listener registration if DSH is upgraded in place. This is an explicit
experimental limitation: restart after changes, heed Doctor compatibility
warnings, and rely on DSH's native web flow whenever Clawd yields no decision.

## Scope and fallback

- Windows x64 native DSH web is the first target. Real rc.6 install, config
  composition, web boot, uninstall, and packaged-app source loading were verified
  on 2026-08-14.
- On 2026-08-29, **rc.6 source-checkout** runs on Windows x64 and macOS
  verified real API-backed DSH web sessions plus manual Clawd **Allow Once**
  and **Deny** round trips. macOS also verified Settings Install under a
  Finder-like GUI `PATH`. These are source-run results, not packaged API-session
  verification ([#962](https://github.com/rullerzhou-afk/clawd-on-desk/pull/962)).
- Separately, the 2026-08-29 **Windows x64 rc.2 packaged-app** evidence covered
  install, web boot, and `/state` plus Allow/Deny round trips driven directly
  through the bridge's `clawd-client`. It did not demonstrate an API-backed rc.2
  DSH session. On 2026-08-31, maintainer validation also covered the rc.2 Windows
  install/uninstall lifecycle through isolated pnpm and the real rc.6 macOS
  lifecycle, including no-CLI commands
  ([#938](https://github.com/rullerzhou-afk/clawd-on-desk/pull/938)).
  Automated installer coverage includes rc.1 installation, rc.3 installation,
  first install below
  a symlinked parent, rc.6 retention, rc.2 installation, cross-contract
  generation migration, and unlisted-version rejection.
- On 2026-09-23, a **macOS rc.1 source-run** used isolated `HOME` and `DSH_HOME`,
  real `dsh web` sessions created and prompted through DSH's public API, and a
  localhost mock Clawd endpoint. Without the bridge, the baseline session
  emitted no `/state` request. With the bridge, the endpoint received
  `SessionStart`, `UserPromptSubmit`, and `Stop`; a controlled ordinary approval
  request sent to `/permission` resolved to `allowed-once` for Allow and
  `rejected` for Deny. An HTTP 204 left the request pending until DSH session
  cancellation produced `cancelled`. The probe ended before any model step.
  This verifies the bridge and DSH API behavior, not the real Clawd UI or a
  packaged app.
- On 2026-09-24, a second isolated rc.1 Web API run verified `session/title`
  forwarding and live `contextPressure` updates. A local fake SSE endpoint
  supplied controlled model usage, so no real model call or user DSH profile
  was involved. A synthetic 500013-token prompt against DSH's 1000000-token
  context window produced `context_usage: { used: 500013, limit: 1000000,
  percent: 50 }` at a mock Clawd `/state` endpoint, alongside SessionStart,
  UserPromptSubmit, and Stop. This verifies the DSH-to-bridge calculation and
  delivery, not a real user's usage, the Clawd UI, or a packaged app.
- On 2026-09-27, a **macOS rc.3 source-run** used macOS 26.6.2 on Apple silicon
  with the globally npm-installed `@deepseek-ai/dsh@0.1.5-rc.3`
  (`dsh --version` printed `0.1.5-rc.3`) running `dsh web`. It used the
  maintainer's everyday DSH profile rather than an isolated `DSH_HOME`, and Clawd
  ran from this branch's source at commit `691e2ee3`, not a packaged app. Clawd's
  startup sync replaced the managed bridge generation left by an older Clawd
  build with the rc.3 generation (manifest `installedDshVersion: 0.1.5-rc.3`,
  range `=0.1.5-rc.3`), and DSH web listed `clawd-bridge` as an enabled global
  plugin. The real conversation used DSH's official DeepSeek provider with
  `deepseek-flash`, the default `workspace-write` permission preset, and the
  `ask` approval policy. Clawd received `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop` from the bridge.
  Clawd's Session HUD showed the DSH-generated session title and the context
  occupancy percentage (confirmed visually). For an approval, asking DSH to
  create a file outside the workspace made the model request sandbox escalation
  to `danger-full-access` for bash, which raised `approval/request` and showed a
  Clawd approval bubble. Choosing **Allow** recorded `allowed-once` in DSH, the
  command ran, and the file was created. Choosing **Deny** recorded `rejected`,
  the tool call failed (Clawd showed `PostToolUseFailure`), and the command did
  not run (the Deny prompt targeted the file created in the Allow step, and its
  modification time did not change). This verifies install via startup sync,
  session state, HUD metadata, and Allow/Deny with the real Clawd UI on a source
  run. It did not cover a packaged app, a first install through Settings,
  Uninstall, DND, or the HTTP 204 hand-back and cancellation paths; the last two
  were exercised against a mock endpoint in the 2026-09-23 rc.1 run and were not
  retested on rc.3.
- On 2026-10-04, a **macOS 0.2.0-rc.2 source-run** used macOS 26.6.2 on Apple
  silicon with the globally npm-installed `@deepseek-ai/dsh@0.2.0-rc.2`
  (`dsh --version` printed `0.2.0-rc.2`) running `dsh web`, and Clawd from source
  at main `fe3e1b01`. The installed bridge generation was still the rc.3
  generation Clawd had staged earlier: its four bridge files were byte-identical
  to `hooks/dsh-clawd-bridge` at main `fe3e1b01`, but the installer at the time
  did not yet admit `0.2.0-rc.2`, so this was not an install owned by Clawd's
  `0.2.0-rc.2` contract.
  DSH's plugin list and assembled config included the bridge with no compatibility
  warning. A real conversation used DSH's official DeepSeek provider with
  `DeepSeek-V41-Flash`, the default `workspace-write` permission preset, and the
  `ask` approval policy. Clawd received `SessionStart`, `UserPromptSubmit`,
  `PreToolUse`, `PostToolUse`, and `Stop`. Asking DSH to create a file outside the
  workspace was first refused by the sandbox, then raised `approval/request` on a
  sandbox-escalation retry. Choosing **Allow** recorded `allowed-once`, the file
  was created, and Clawd received `PostToolUse` and `Stop`. Choosing **Deny**
  recorded `rejected` and left the file unchanged; the rejected result carried
  `message.isError: true` (the `0.2.0-rc.2` location) with no content-item
  `isError`, and the rc.3 bridge, which only checked `data.error` and content-item
  `isError`, reported it as `PostToolUse` instead of `PostToolUseFailure`. This
  run is the evidence for the `0.2.0-rc.2` message-level failure shape; it did not
  itself produce a correct `PostToolUseFailure`. It did not cover an install
  performed by Clawd's installer for `0.2.0-rc.2`, a first install through
  Settings, Uninstall, DND, the HTTP 204 hand-back, Windows, a packaged app, or
  the desktop profile.
- On 2026-10-04, a second **macOS 0.2.0-rc.2 source-run** used the `0.2.0-rc.2`
  generation produced by Clawd's own installer. Clawd ran from source at main
  `fe3e1b01` plus this change's three runtime files, and startup sync replaced
  the rc.3 generation left by Clawd 1.1.0 (the new manifest recorded
  `sourceClawdVersion: 1.2.0`, `installedDshVersion: 0.2.0-rc.2`, range
  `=0.2.0-rc.2`); the profile dependency moved to the new generation and the old
  generation was removed. Restarting `dsh web` and opening a real conversation
  with DSH's official DeepSeek provider, `DeepSeek-V41-Flash`, the default
  `workspace-write` permission preset, and the `ask` approval policy delivered
  `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, and `Stop` to
  Clawd. For a sandbox-escalation approval to write outside the workspace,
  **Allow** recorded `allowed-once` and created the file; **Deny** recorded
  `rejected`, left the file unchanged (its modification time and size did not
  change), and — because the failed
  result carried `message.isError: true` with no `data.error` — Clawd showed
  `PostToolUseFailure` / `error` before `Stop`. Clawd's Session HUD showed the
  DSH-generated session title and the context occupancy percentage (1%),
  confirmed visually. This verifies install via startup sync with a generation
  Clawd itself staged, state mapping, HUD metadata, Allow/Deny, and the
  message-level failure flag with the real Clawd UI on a source run. It did not
  cover a packaged app, a first install through Settings, Uninstall, DND, the
  HTTP 204 hand-back and cancellation, Windows, or the desktop profile.
- Linux, WSL, remote SSH, non-web profiles, macOS packaging, and ARM64 packaging
  remain unverified.
- There is no terminal-focus action because DSH web is a browser surface.
- Closing the local bubble does not deny the request. If a configured Telegram
  or Feishu/Lark remote channel takes it, that channel may decide; otherwise DSH
  receives no Clawd decision and continues its native flow.
- Hiding the pet is not DND, so a new approval may still show a bubble. DND
  returns control to DSH without deciding.
