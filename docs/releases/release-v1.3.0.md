## v1.3.0

Clawd v1.3.0 improves how the pet follows Claude Code tool batches, Codex
compaction and approval routing, and WorkBuddy conversations. DeepSeek Harness
gains desktop support alongside its web integration. This release also adds
optional quota reminders and improves session history, official theme downloads,
pet sizing, Footprints, and Linux AppImage shutdown.

### Claude Code

- **Thinking between tool batches** (#1123, #1150, #1153, #1154; issue #1018) —
  returns the pet to thinking after a correlated tool batch, instead of typing
  until the turn ends. Also fixes misordered queued prompts, tool results,
  subagent callbacks, and delayed tool accounting. Requires Claude Code
  2.1.280 or later. Thanks to @200780381.
- **Session titles** (#1127; issue #1125) — shows AI-generated Claude Code CLI
  and VS Code extension titles in the HUD and Dashboard. Manual renames take
  priority; a prompt's first line remains a temporary fallback. Thanks to
  @draintovmasyan783-creator for the report.
- **Design reactions** (#1084) — the Clawd theme holds a palette and brush
  during a `/design` turn and shows heart eyes when it completes. Requires
  Claude Code 2.1.265 or later. Thanks to @sanzanazaman.
- **Windows recovery and hook repair** (#1108, #1070; issue #874) — keeps
  restart recovery available when a long-idle Claude session starts working
  again through its live PID cache, and automatically migrates owned env-style
  hooks when a usable local Node executable can be found. Thanks to
  @200780381 and @hanzhe-one.

### Codex

- **Auto approval routing** (#1156, #1167, #1169, #1068, #1101; issue #1155) —
  makes Auto the default and moves existing Intercept/Native settings to Auto
  once. Clawd handles only local human-reviewed shell/file requests with exact
  session/turn evidence; automatic reviewers, MCP/app requests, remote/WSL
  requests, and uncertain evidence stay in Codex, without Telegram or Feishu
  approval cards. Long turns and unchanged settings repeated after compaction
  can retain that evidence within the bounded scan. Closing an unanswered
  Codex bubble or cleaning it up does not manufacture a denial. Intercept
  remains available in Settings → Agents → Codex. Thanks to @PeterShanxin
  and @200780381.
- **Compaction** (#1110, #1129, #1160; issue #1109) — starts sweeping at
  compaction start and stops sweeping on success or interruption.
  Compaction yields to other conversations' thinking and work,
  while their completion cues still play. Unreviewed hooks retain the JSONL
  completion-only sweep. Thanks to @200780381 and @hanzhe-one.
- **Session cards and titles** (#1158, #1111; issue #1103) — hides recognized
  Desktop ambient-suggestion threads while keeping ordinary side chats, and
  retires ended sessions on SessionEnd unless a replyable completion mapping
  still needs the row. Local native titles and renames refresh through the
  normal monitor poll, usually within about 1.5 seconds. Thanks to
  @200780381 for tracing the extra Windows row.
- **Live progress and roaming** (#1162) — keeps a current local Codex turn
  alive while genuine model/tool progress continues during a long wait. Busy
  sessions now pause automatic roaming for every agent. Thanks to @200780381.
- **New-hook review notices** (#1169) — when only the new state hooks await
  review, the Windows tray notice explains that an already-trusted approval
  hook still works and points to `/hooks`; Doctor reports pending review.

### DeepSeek Harness And Buddy Sessions

- **DeepSeek Harness web and desktop** (#1128, #1130, #1131, #1132, #1133,
  #1169; issue #1119) — supports the verified 0.1 and 0.2 minor families,
  with 0.2 starting at 0.2.0-rc.2, and manages web plus macOS/Windows desktop
  profiles from one Settings/Doctor row. Open the desktop app once to initialize
  its profile. Clicking a desktop session opens the app window, without
  selecting a particular conversation; untouched starts remain in Dashboard
  until activity reveals them in the HUD. Persistent notices explain restarts
  and, after a host-family change, Uninstall followed by Install. Only
  Clawd-owned bridge installations are supported; Linux supports web only. Thanks to
  @wrq189 and @Swcmb for reports.
- **WorkBuddy conversations** (#1135, #1136, #1138, #1140, #1168; issue #655) —
  keeps completed cards until the configured idle timeout or app exit instead
  of losing them when Windows WorkBuddy's per-turn host exits. Native titles,
  idle renames, and context usage reach the HUD and Dashboard; archive/delete
  removes the card in about one two-second poll when the owning database is
  readable, and unarchiving plus a new message restores it. Late SessionStart,
  login notifications, and explicit idle reminders no longer reset a completed
  or running card. Thanks to @200780381.
- **Windows Buddy hook delivery** (#1104, #1146; issue #655) — answers
  WorkBuddy/CodeBuddy hook stdout before process discovery so slow snapshots
  do not kill the state POST. WorkBuddy also allows a longer, bounded snapshot
  window; failed discovery never guesses a PID. Thanks to @LetitiaChan and
  @200780381.
- **CodeBuddy state-hook replies** (#1115) — uses the documented `{}`
  no-decision reply for every command-hook event. CodeBuddy 2.161.1 already
  ignored the old `allow` value, so this corrects the contract without changing
  that version's behavior; blocking approval remains on its separate HTTP
  hook.
- **Kimi restored conversations** (#1159) — keeps untouched restored desktop
  conversations in Dashboard until their first activity, avoiding idle HUD
  rows. New CLI sessions follow the same rule.

### Permissions And Dashboard

- **Approval bubbles and session policy** (#1114, #1121, #1161) — positions
  permission bubbles before showing them, preserves a session's stricter
  “Ask every time” setting when request identity verification fails, and
  returns an unanswered OpenCode/MiMo request to its native prompt when the
  bubble window closes. Thanks to @200780381.
- **Message heredocs** (#1096) — the destructive-operation reminder no longer
  holds recognized git/gh message arguments written as `$(cat <<'EOF' …)`
  merely because their text contains quotes or `(#N)`; other shell risks and
  unrecognized heredocs keep their existing checks. Thanks to @chrono-meta.
- **Session history and automation explanations** (#1085, #1086, #1116, #971)
  — groups unverified history behind confirmed rows, supplies first-prompt
  fallback titles and short session IDs, including worktree transcripts, and
  reads titles only for returned rows. Dashboard explains unavailable session
  automation and preserves picker focus during refreshes. Thanks to @52mzd
  and @YOIMIYA66.

### Settings, Themes, And Footprints

- **Official themes offline and during downloads** (#1124, #1088, #1098;
  issues #1122, #1087) — keeps the section visible with a GitHub connection
  message, Retry, and automatic retries. A bundled catalog snapshot lists
  available themes on a first offline launch; installation still needs a
  verified catalog and downloaded assets. Progress updates preserve card
  hover, scroll, and keyboard focus, including after reopening Settings.
  Thanks to @eugenewang5425.
- **Pet sizing** (#1091, #1092, #1093, #1094) — prevents roaming from
  overwriting slider changes and shows the pet's actual size after a display
  change, with `100%+` above the slider range. Turning off Keep size across
  displays uses the nearest slider size, clamped to its maximum. Cloudling
  now appears about 29% smaller at the same setting, closer to the other
  built-in themes.
- **Optional quota reminders** (#1126, #1151, #1152) — adds an opt-in reminder
  switch under General → Session management → Quota ring, one timing selector
  with four presets, optional recovery reminders, and a test notification.
  Alerts name the quota window; failed delivery backs off from 30 seconds to
  at most 15 minutes without consuming reminder eligibility. macOS users
  need to allow Clawd in System Settings → Notifications. Thanks to @200780381.
- **Footprints** (#1143, #1144; issues #1141, #1142) — streams startup
  reconciliation so retained journals above 100,000 records no longer skip
  the whole rebuild, and removes the Sessions started column while keeping
  the stored format. Unsupported metrics remain a dash.

### Platform And Maintenance

- **Linux AppImage shutdown** (#1058; issue #1048) — runs FUSE launches from
  a private temporary copy so an early wrapper exit cannot remove Electron's
  runtime. The copy needs roughly 345 MiB per launch, consumes memory on
  tmpfs, and can briefly double during XWayland relaunch; use an executable,
  non-FUSE `TMPDIR` with enough space or a manually extracted AppDir. Normal
  shutdown cleans up; forced supervisor termination or lingering children
  can leave files behind. The final fix still awaits the original reporter's
  confirmation on Bazzite. Thanks to @Kattuul for identifying the coreutils
  9.6 FUSE-name change.
- **Remote approval dependency** (#1102) — upgrades axios to 1.20.0 for
  CVE-2026-101898. Clawd uses it through the Feishu/Lark SDK for remote
  approval networking. Thanks to @anupamme.
- **Repository maintenance** (#1037, #1099) — adds bilingual contribution
  templates and retains a TAP report when CI tests fail. Thanks to @YOIMIYA66.

### Upgrade Notes

- Codex Intercept/Native settings migrate to Auto once. To keep explicit
  Clawd interception, select Intercept again in Settings → Agents → Codex;
  this post-upgrade choice is preserved (#1156, #1167).
- Launch Clawd to sync integrations, then review **PreCompact, PostCompact,
  Interrupt, and SessionEnd** in Codex `/hooks`. Until reviewed, compaction
  has only the JSONL completion cue; an already-trusted PermissionRequest
  still works. Deploy/Repair Remote SSH targets to receive the new hooks
  (#1129, #1158, #1160, #1169).
- Installed and enabled DSH bridges update their managed generation once
  after upgrade. Restart a running `dsh web` and the desktop app after the
  update; adding the plugin to an already-running initialized desktop app
  loads it automatically, but replacing its generation needs a restart
  (#1130, #1131, #1132).
- PostToolBatch is registered only for Claude Code 2.1.280 or later. If Claude
  auto-updates while Clawd stays running, restart Clawd to register newly
  supported hooks (#1123).
- Cloudling is about 29% smaller at the same slider position. Increase the
  slider to recover the old size where possible; its maximum visible size
  is now about 71% of the previous maximum. Saved choices are unchanged
  (#1094).
- Downgrading is unsupported: v1.2.0 reads v1.3.0 preferences as read-only and
  cannot save changes. Its DSH installer cannot manage the new family markers;
  remove the bridge manually with `dsh plugin remove @dsh-external/dsh-clawd-bridge`
  for web, and the desktop-bundled CLI with `--profile desktop` for desktop
  (see the [DSH guide](../guides/dsh-setup.md)).
- Quota reminders are disabled by default; enable them in Settings → General
  → Session management → Quota ring (#1126, #1152).

### Contributors

Thanks to contributors whose work landed between v1.2.0 and v1.3.0:
@200780381, @52mzd, @chrono-meta, @eugenewang5425, @hanzhe-one,
@PeterShanxin, @YOIMIYA66, @anupamme, and new contributors @LetitiaChan
and @sanzanazaman. Thanks also to @draintovmasyan783-creator, @wrq189,
@Swcmb, and @Kattuul for reports and diagnostic evidence. Existing contributor
credit and original authorship remain in Settings About and every README variant.

### Validation Status

Checked with the v1.3.0 draft assets:

- **Release CI** — the manual Build & Release run on `54d359ef` and the tag
  build passed every job: full test suites on Linux, macOS and Windows with no
  failures, native-package audits for all five targets, Koffi packaged smoke,
  updater metadata, and the retired Telegram sidecar assertion. The 13 draft
  assets match the v1.2.0 set, and all three `latest*.yml` files point at
  1.3.0 artifacts.
- **macOS signing** — both DMGs contain Developer ID signed, notarized apps;
  on the arm64 app, `codesign`, `spctl` (Notarized Developer ID) and
  `stapler validate` passed.
- **Windows x64 (real machine)** — silent upgrade over an installed v1.2.0
  (`/S /allusers --updated`). The installed app reports 1.3.0 and contains
  one `win32_x64` Koffi binary, NOTICE and the bundled theme catalog. Startup
  migrated preferences from version 20 to 21, moved Codex from Intercept to
  Auto once, left other settings unchanged, and kept user and third-party
  Claude/Codex hooks. Launched from the Start menu: the pet appeared,
  Settings → About showed v1.3.0, and the Codex hooks passed `/hooks` review.
- **macOS arm64 (real machine)** — the draft DMG (hash checked) installed over
  v1.2.0 and launched from `/Applications` after the standard first-launch
  confirmation. Preferences migrated to version 21 with Codex Auto unchanged.
  Claude hooks moved to the installed app with user entries preserved; the
  Codex hooks (10 events) were unchanged. About showed v1.3.0 with the new
  contributors, quota reminders were off by default, and a real Codex session
  reported activity and turn completion. The DeepSeek Harness desktop notice
  asked for a restart after the one-time plugin update.
- **In-app update (macOS arm64)** — a signed v1.2.0 found, downloaded and
  installed v1.3.0 through Restart Now; the restarted app stayed signed and
  notarized, and its hooks pointed at the installed app.
- **Codex Auto evidence (#1169)** — a packaged build showed the Clawd bubble
  for a request 2 MiB after its turn context. Replaying 25 real local
  rollouts as human-reviewed turns raised the share routed to Clawd from
  49.6% to 99.1%, with no request lost.

**Not tested**:
- The in-app update on Windows and macOS x64, and the Later → quit → reopen
  path on macOS.
- macOS x64 and Windows ARM64 on real hardware (CI only).
- Linux on real hardware: AppImage FUSE shutdown, tmpfs/TMPDIR handling and
  the deb package. CI covered the Wayland/XWayland and AppImage contracts.
- A real Codex "Ask me" session with a long turn and a compaction, and the
  wording of the Windows tray notice when only the new Codex hooks await
  review. Logs confirmed that this case is detected.
- A real DeepSeek Harness host-family change from 0.1 to 0.2.
- Other checks in the release smoke checklist that are not listed above.
