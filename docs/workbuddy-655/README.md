# WorkBuddy / #655 review bundle

> **Do not apply this patch directly.** `workbuddy-support.zip` is kept only as
> a historical reference. The bundled `workbuddy-support.patch` diverges from
> the shipped WorkBuddy integration in several material ways and must not be
> applied to the current tree:
>
> - **PreToolUse allow (patch line 226):** the patch emits
>   `{"decision":"allow"}`. The mainline `hooks/workbuddy-hook.js` only ever
>   emits `{}`, because an explicit allow can bypass WorkBuddy's own permission
>   UI (PR #618).
> - **session_id fallback (patch line 262):** the patch falls back to
>   `"default"` when `session_id` is missing. The mainline drops events that
>   carry no `session_id`.
> - **Permission registration (patch line 457 onward):** the patch registers a
>   `PermissionRequest` hook. The mainline WorkBuddy integration never registers
>   `/permission`; approvals stay inside WorkBuddy's native UI.
> - **Author header:** the patch's `From:` line is
>   `rullerzhou-afk <rullerzhou-afk@users.noreply.github.com>`, so applying it
>   with `git am` would credit that account for the work.
> - **Encoding:** the patch file is UTF-16LE with CRLF line endings and must be
>   transcoded before any `git apply`.
>
> The mainline WorkBuddy integration is **state + Notification only**: it
> reports state and notifications and deliberately leaves approval to
> WorkBuddy.

This directory contains the locally preserved WorkBuddy integration patch and
the smallest runtime evidence available for issue #655. The branch was based on
the then-current `origin/main` at `9367b8c3` (including #1014) when it was
submitted; that baseline is now out of date.

## Included material

- `workbuddy-support.zip` contains the original local fusion patch. It is
  supplied for review as-is; it was created against an older WorkBuddy
  integration baseline and is not claimed to apply cleanly without review.
- `reproduction.log` contains the exact Clawd debug lines from the earlier
  `workbuddy-ui-smoke-*` hook smoke. That session was injected by local test
  automation, not typed by a user in WorkBuddy. It proves event delivery and
  the current deletion path, but it is not a claim about a real user turn.

## Version boundaries

The earlier fusion package and automation used the locally preserved 0.13
test package/older snapshots. They must not be used as v1.0 UI validation.
The current installed Clawd instance was separately verified as official
1.0.0 (app.asar, registry, and running owner), and the window-title check was
performed after all old Clawd processes were closed.

The WorkBuddy executable present during the smoke was the local Windows
WorkBuddy installation. Its exact application build was not captured in the
smoke log, so this bundle does not invent a WorkBuddy version number.

## Scope requested for review

The fusion patch is offered to restore WorkBuddy visibility and state/event
synchronisation. It does not intentionally carry over the public #648 rules
that hide idle/done sessions or keep only the newest session per process.
Those rules conflict with #655's requirement to keep completed sessions until
reliable archive/delete evidence exists. Completion retention and archive/delete
semantics should therefore be reviewed as a separate lifecycle change.
