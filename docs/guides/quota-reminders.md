# Quota reminders

Open **Settings → General → Session management → Quota ring** and enable quota
reminders. Choose 1–5 different remaining-percentage thresholds (1–99) with the
existing selectors; unused slots are Disabled. Defaults are **20% and 10%
remaining**. Changes apply immediately. Recovery reminders are optional.
The ring's Used/Remaining preference does not change reminder semantics, and
reminders can remain enabled when the visible ring is hidden.

Reminders consume the existing account reports separately for each provider,
local/remote source and window. They do not enable usage collection or make
additional API requests. Where collection needs an opt-in, such as Claude
statusline or Kimi, configure that existing integration on its Agents card.

Only confirmed, recent, unexpired reports qualify. Startup disk snapshots alone
cannot trigger reminders; minute-quantized timestamps may delay the first
qualifying confirmation by about a minute. A jump straight to 9% produces only
the 10% reminder, rather than another 20% notification. Recovery requires a
newer report above the highest threshold; reaching the reset time is insufficient.

Do Not Disturb suppresses reminders without consuming eligibility. Notifications
respect the app's mute setting and operating-system notification settings.
Use **Test notification** to check delivery without changing quota or history.
Native delivery is recorded only after the system's show acknowledgement;
failure/timeouts remain eligible for later observation. Windows tray balloons
are a best-effort fallback when native notifications are unavailable. The test
also respects Do Not Disturb.

Deduplication history is stored in quota-alert-history.json in Electron's
user-data directory, with at most 256 records and 60 days of retention. It contains
hashed source/window keys and numeric metadata, without credentials, prompts,
commands or project paths. Quiet-hour scheduling and project launching are not
part of this feature.
