## v1.2.0

Clawd v1.2.0 adds experimental MiniMax Code support, OpenCode 2.x permissions,
DeepSeek Harness session details, safer optional approval automation, and new
theme behavior. Idle bubbles in the built-in Clawd theme now mirror on the right
half of the screen, where the pet appears by default. This release also improves
session recovery, hook health, notifications, and remote Codex monitoring.

### Agents And Sessions

- **MiniMax Code** (#1038, #1049) — adds an experimental, state-only integration
  through Clawd's managed local plugin at `~/.minimax/plugins/clawd-state`.
  MiniMax's hook timeout does not support blocking approvals, so Clawd does not
  show permission bubbles for it. Enable the plugin in MiniMax with
  `mcode plugin enable clawd-state@local` or its plugin panel. Thanks to
  @xiaoshidefeng.
- **OpenCode 2.x** (#1045, #1053, #1067, #1079) — detects a v1, v2, or unknown
  host before changing its `plugin` and `plugins` registrations. The v2 plugin
  uses the new event API and a blocking permission hook. If host detection
  fails, `CLAWD_OPENCODE_HOST` can pin the host version. Windows detection now
  handles installation paths with non-ASCII characters. Thanks to
  @xiaoshidefeng and @gzx19990101.
- **OpenCode approvals** (#1075, #1079; issue #1065) — reaches wildcard-bound
  `opencode web` and `serve --hostname 0.0.0.0` over loopback, withdraws pending
  bubbles when a session is interrupted, and scans compound shell commands such
  as `a && b` for destructive-operation reminders and warning badges.
- **DeepSeek Harness** (#1046) — supports 0.1.5-rc.1 and rc.3 and forwards
  session titles and context usage. Thanks to @ypjn.
- **Claude recovery and completion** (#1061, #1063; issue #1060) — idle sessions
  no longer resume as working after a Clawd restart. Normally ended sessions,
  including turns that ended while background work continued, stay ended after
  a reboot. A trailing `SubagentStop` no longer cancels completion animation
  or notification. Thanks to @KaiC5504.
- **Codex session cards** (#1032, #1074, #1079; issue #1073) — groups remote
  Desktop rollouts by thread, omits the `memories` consolidation worker, and
  prevents remote monitor restarts from inventing idle sessions or reviving
  finished turns.
- **Session identity and process fixes** (#1031, #1051, #1052, #1055, #1056;
  issue #908) — probes Claude transcripts by raw session ID, preserves Cursor
  delivery time through slow metadata lookup, recognizes Linux Node processes
  named `MainThread` and retitled Kimi Code processes, and avoids probing WSL
  session PIDs on the Windows host. Thanks to @hanzhe-one.

### Dashboard, Themes, And Desktop

- **Claude hook health** (#1059, #1064; issue #898) — the Agents card reflects
  hooks displaced by tools such as CC Switch, paused automatic repair, repeated
  repair failures, and missing scripts, with an explanation when attention is
  needed. Windows shows one tray notice when automatic repair pauses. Thanks
  to @hanzhe-one.
- **Desktop and Settings fixes** (#724, #1071) — the first click reaches
  Settings or Dashboard when Clawd is in the macOS background. Custom app
  launchability uses one rule, and saving a permission URL waits for sync to
  finish. Thanks to @200780381 and @52mzd.
- **Theme animations** (#1050, #1076) — opted-in idle animations mirror on the
  right half of the screen; the built-in Clawd idle bubble opts in. Mini mode
  gains selectable peek hold and sleep peek visuals, plus idle visuals that
  appear only when selected. Thanks to @KaiC5504.
- **Whale-chan** (#1077) — adds an optional official theme downloadable from
  Settings; its media is not in the installer. Rights in the original character
  design, setting and upstream materials remain with their creators; the theme
  credits ZipZipPipe and 上善无形 as named by
  [Neko3000/deepseek-whalechan](https://github.com/Neko3000/deepseek-whalechan).
  New animation and effects by 鹿鹿 ([@rullerzhou-afk](https://github.com/rullerzhou-afk))
  are licensed under CC BY-NC-SA 4.0; see the theme package for full terms. It
  is an unofficial, non-commercial fan work, not affiliated with or endorsed by
  DeepSeek, and it is not covered by this project's AGPL-3.0 source license.
- **Codex Pet poses** (#1022, #1079) — juggling gets its own pose, and already
  imported pets are regenerated once after upgrade. Thanks to @chrono-meta.

### Remote Workflows And Reliability

- **Optional destructive-operation reminder** (#1021) — disabled by default.
  When enabled, recognized destructive commands pause auto-tools or unattended
  approval for a person to review; the feature only makes automation more
  conservative. A heredoc body containing an odd number of quotes or `(#N)`
  can be treated as unanalyzable and held for review. Thanks to @chrono-meta.
- **Notifications** (#1066) — queued Slack notifications are retained, while
  permission alerts use a separate lane.
- **WinGet release tooling** (#1034) — validates the generated manifests before
  submission; automatic submission remains disabled by default.
- **Documentation** (#1054, #1079) — synchronizes multilingual READMEs and
  guides, including the Korean README update. Thanks to @jin-codes.

### Upgrade Notes

- Launch Clawd once after upgrading so installed and enabled integrations can
  reconcile their packaged hooks, plugins, and extensions (#1038, #1045).
- Enable the MiniMax plugin inside MiniMax after installing its integration;
  the integration reports state only (#1038).
- For OpenCode 2.x, run `opencode service restart` after installing or updating
  its plugin; opening a new session alone does not guarantee a shared-service
  reload. For OpenCode 1.x, restart opencode to load the updated plugin
  (#1045, #1079).
- The built-in Clawd idle bubble now mirrors on the right half of the screen,
  which affects the default bottom-right pet position. Imported Codex Pets
  refresh once to pick up the new juggling pose (#1050, #1079).
- Whale-chan downloads on demand from the separate official theme repository;
  it is not bundled with Clawd (#1077).

### Contributors

Thanks to contributors whose work landed between v1.1.0 and v1.2.0:
@chrono-meta, @hanzhe-one, @200780381, @xiaoshidefeng, @KaiC5504,
@jin-codes, @gzx19990101, @ypjn, and @52mzd. Existing contributor credit and
original authorship remain in Settings About and every README variant.

### Validation Status

Before this release-preparation pass, two independent full-release reviews
reported no P0/P1 issues. After the fixes, a macOS real-machine `npm test` run
reported 11,523 tests and 0 failures. PR #1079 also received real-machine
checks for Windows Chinese-path host detection under code page 936, OpenCode
v2.0.18 bubble withdrawal after interruption, a Codex Pet upgrade from v1.1.0,
and remote monitor replay using real Desktop rollouts.

Packaged draft-asset smoke against the
[v1.2.0 checklist](../project/release-process.md) and the complete Remote SSH
real-machine path remain **NOT TESTED**. Update this section with those results
before publishing; source tests and replay checks do not replace them.
