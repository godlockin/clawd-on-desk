"use strict";

// Hook-local source of truth: WSL/manual payloads contain hooks/ but no
// agents/ tree. Keep runtime process matching inside the deployable closure
// and let the registry consume the same immutable value.
const KIMI_PROCESS_NAMES = Object.freeze({
  mac: Object.freeze(["kimi", "Kimi Code"]),
  linux: Object.freeze(["kimi"]),
  win: Object.freeze(["kimi.exe"]),
});

const KIMI_STARTUP_RECOVERY_PROCESS_NAMES = Object.freeze({
  mac: Object.freeze(["kimi", "Kimi Code"]),
  linux: Object.freeze(["kimi", "Kimi Code"]),
  win: Object.freeze(["kimi.exe"]),
});

module.exports = {
  KIMI_PROCESS_NAMES,
  KIMI_STARTUP_RECOVERY_PROCESS_NAMES,
};
