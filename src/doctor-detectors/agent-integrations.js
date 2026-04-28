"use strict";

const fs = require("fs");
const path = require("path");

const { isAgentEnabled, isAgentPermissionsEnabled } = require("../agent-gate");
const { findHookCommands } = require("../../hooks/json-utils");
const { findKimiHookCommands } = require("../../hooks/kimi-install");
const { getAgentDescriptors } = require("./agent-descriptors");
const { validateHookCommand } = require("./agent-node-bin-parser");
const { checkCodexHooksFeature } = require("./codex-features-check");
const { validateOpencodeEntry } = require("./opencode-entry-validator");

const INFO_ONLY_STATUSES = new Set([
  "disabled",
  "manual-managed",
  "manual-only",
  "not-installed",
]);
const REPAIRABLE_AGENT_STATUSES = new Set(["not-connected", "broken-path"]);

function dirExists(fsImpl, dirPath) {
  try {
    return fsImpl.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function fileExists(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readJson(fsImpl, filePath) {
  return JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
}

function withAgentBubbleNote(detail, prefs, agentId) {
  if (!isAgentPermissionsEnabled(prefs, agentId)) {
    return {
      ...detail,
      permissionsEnabled: false,
      permissionBubbleDetail: "permission bubbles disabled for this agent",
    };
  }
  return detail;
}

function withAgentFixAction(detail, descriptor) {
  if (!descriptor.autoInstall || !REPAIRABLE_AGENT_STATUSES.has(detail.status)) return detail;
  const fixAction = { type: "agent-integration", agentId: descriptor.agentId };
  if (
    descriptor.agentId === "codex"
    && detail.supplementary
    && detail.supplementary.key === "codex_hooks"
    && detail.supplementary.value === "disabled"
  ) {
    fixAction.forceCodexHooksFeature = true;
  }
  return {
    ...detail,
    fixAction,
  };
}

function makeDetail(descriptor, status, fields = {}) {
  return {
    agentId: descriptor.agentId,
    agentName: descriptor.agentName,
    eventSource: descriptor.eventSource,
    status,
    ...fields,
  };
}

function statusLevel(status) {
  if (status === "not-connected" || status === "broken-path" || status === "config-corrupt") {
    return "warning";
  }
  return status === "ok" ? null : "info";
}

function validateCommandList(descriptor, commands, options) {
  if (!commands.length) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      detail: `${descriptor.configPath} has no ${descriptor.marker} command`,
    });
  }

  const results = commands.map((command) => options.validateCommand(command, {
    platform: options.platform,
    fs: options.fs,
  }));
  const ok = results.find((result) => result.ok);
  if (ok) {
    return makeDetail(descriptor, "ok", {
      level: null,
      detail: `${descriptor.configPath} hook registered, scriptPath verified`,
      commandCount: commands.length,
      scriptPath: ok.scriptPath,
    });
  }

  const first = results[0] || { issue: "parse-failed" };
  return makeDetail(descriptor, "broken-path", {
    level: "warning",
    detail: `hook command failed validation: ${first.issue}`,
    hookCommandIssue: first.issue || "parse-failed",
    nodeBin: first.nodeBin || null,
    scriptPath: first.scriptPath || null,
    commandFragment: first.fragment || String(commands[0] || "").slice(0, 128),
  });
}

function applyCodexSupplementary(detail, descriptor, options) {
  if (!descriptor.supplementary || descriptor.supplementary.key !== "codex_hooks") return detail;
  if (detail.status !== "ok") return detail;

  const supplementary = checkCodexHooksFeature(descriptor.supplementary.configPath, { fs: options.fs });
  if (supplementary.value === "disabled") {
    return {
      ...detail,
      status: "not-connected",
      level: "warning",
      supplementary: {
        key: "codex_hooks",
        value: supplementary.value,
        detail: supplementary.detail,
      },
      detail: "[features].codex_hooks is disabled",
    };
  }
  return {
    ...detail,
    supplementary: {
      key: "codex_hooks",
      value: supplementary.value,
      detail: supplementary.detail,
    },
  };
}

function checkFileMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, descriptor.autoInstall ? "not-connected" : "manual-only", {
      level: descriptor.autoInstall ? "warning" : "info",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let settings;
  try {
    settings = readJson(options.fs, descriptor.configPath);
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "config parse failed",
    });
  }

  if (descriptor.detection === "opencode-plugin") {
    return checkOpencodeSettings(descriptor, settings, options);
  }

  let detail = validateCommandList(
    descriptor,
    findHookCommands(settings, descriptor.marker, { nested: !!descriptor.nested }),
    options
  );
  detail = {
    ...detail,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
  return applyCodexSupplementary(detail, descriptor, options);
}

function checkTomlTextMode(descriptor, options) {
  if (!fileExists(options.fs, descriptor.configPath)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} missing`,
    });
  }

  let text;
  try {
    text = options.fs.readFileSync(descriptor.configPath, "utf8");
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: err && err.message ? err.message : "config read failed",
    });
  }

  return {
    ...validateCommandList(descriptor, findKimiHookCommands(text, descriptor.marker), options),
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
  };
}

function checkKiroDirMode(descriptor, options) {
  const agentsDir = descriptor.configPath;
  if (!dirExists(options.fs, agentsDir)) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: false,
      configPath: agentsDir,
      detail: `${agentsDir} missing`,
      kiroScan: { fullyValidFiles: [], brokenFiles: [], noMarkerFiles: [], corruptFiles: [] },
    });
  }

  let entries = [];
  try {
    entries = options.fs.readdirSync(agentsDir);
  } catch (err) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: err && err.message ? err.message : "agents dir unreadable",
    });
  }

  const jsonFiles = entries
    .filter((file) => file.endsWith(".json") && !file.endsWith(".example.json"))
    .slice(0, 50);
  const scan = {
    fullyValidFiles: [],
    brokenFiles: [],
    noMarkerFiles: [],
    corruptFiles: [],
  };
  let firstIssue = null;

  for (const file of jsonFiles) {
    const filePath = path.join(agentsDir, file);
    let settings;
    try {
      settings = readJson(options.fs, filePath);
    } catch {
      scan.corruptFiles.push(file);
      continue;
    }

    const commands = findHookCommands(settings, descriptor.marker, { nested: !!descriptor.nested });
    if (!commands.length) {
      scan.noMarkerFiles.push(file);
      continue;
    }
    const results = commands.map((command) => options.validateCommand(command, {
      platform: options.platform,
      fs: options.fs,
    }));
    if (results.some((result) => result.ok)) {
      scan.fullyValidFiles.push(file);
    } else {
      scan.brokenFiles.push(file);
      if (!firstIssue) firstIssue = results[0] || { issue: "parse-failed" };
    }
  }

  if (scan.fullyValidFiles.length > 0) {
    return makeDetail(descriptor, "ok", {
      level: null,
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: `${scan.fullyValidFiles.length} hooked agent(s). Use 'kiro-cli --agent clawd' to activate.`,
      kiroScan: scan,
    });
  }
  if (scan.brokenFiles.length > 0) {
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: `Kiro hook command failed validation in ${scan.brokenFiles[0]}`,
      hookCommandIssue: firstIssue && firstIssue.issue ? firstIssue.issue : "parse-failed",
      nodeBin: firstIssue && firstIssue.nodeBin ? firstIssue.nodeBin : null,
      scriptPath: firstIssue && firstIssue.scriptPath ? firstIssue.scriptPath : null,
      kiroScan: scan,
    });
  }
  if (scan.corruptFiles.length > 0 && scan.noMarkerFiles.length === 0) {
    return makeDetail(descriptor, "config-corrupt", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: agentsDir,
      detail: `Kiro agent config could not be parsed: ${scan.corruptFiles[0]}`,
      kiroScan: scan,
    });
  }
  return makeDetail(descriptor, "not-connected", {
    level: "warning",
    parentDirExists: true,
    configFileExists: true,
    configPath: agentsDir,
    detail: "No Kiro agent config contains a valid Clawd hook",
    kiroScan: scan,
  });
}

function findOpencodePluginEntry(pluginEntries, marker) {
  if (!Array.isArray(pluginEntries)) return null;
  for (const entry of pluginEntries) {
    if (typeof entry !== "string") continue;
    const normalized = entry.replace(/\\/g, "/");
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === marker) return entry;
  }
  return null;
}

function checkOpencodeSettings(descriptor, settings, options) {
  const entry = findOpencodePluginEntry(settings && settings.plugin, descriptor.marker);
  if (!entry) {
    return makeDetail(descriptor, "not-connected", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `${descriptor.configPath} has no ${descriptor.marker} plugin entry`,
    });
  }

  const validation = validateOpencodeEntry(entry, { fs: options.fs });
  if (!validation.ok) {
    return makeDetail(descriptor, "broken-path", {
      level: "warning",
      parentDirExists: true,
      configFileExists: true,
      configPath: descriptor.configPath,
      detail: `opencode plugin entry is invalid: ${validation.reason}`,
      opencodeEntryIssue: validation.reason,
      opencodeEntry: entry,
    });
  }

  return makeDetail(descriptor, "ok", {
    level: null,
    parentDirExists: true,
    configFileExists: true,
    configPath: descriptor.configPath,
    detail: `${descriptor.configPath} plugin entry verified`,
    opencodeEntry: entry,
  });
}

function checkAgent(descriptor, options) {
  const prefs = options.prefs || {};
  if (!isAgentEnabled(prefs, descriptor.agentId)) {
    return makeDetail(descriptor, "disabled", {
      level: "info",
      detail: "You disabled this agent in Settings",
    });
  }

  if (descriptor.agentId === "claude-code" && prefs.manageClaudeHooksAutomatically === false) {
    return makeDetail(descriptor, "manual-managed", {
      level: "info",
      detail: "Automatic Claude hook management is disabled",
    });
  }

  if (descriptor.configMode === "none-global") {
    return makeDetail(descriptor, "manual-only", {
      level: "info",
      detail: "This agent uses project-level config",
      scriptPath: descriptor.scriptPath || null,
      scriptExists: descriptor.scriptPath ? fileExists(options.fs, descriptor.scriptPath) : null,
    });
  }

  const parentDirExists = descriptor.parentDir ? dirExists(options.fs, descriptor.parentDir) : false;
  if (!parentDirExists) {
    return makeDetail(descriptor, "not-installed", {
      level: "info",
      parentDirExists: false,
      configPath: descriptor.configPath,
      detail: `${descriptor.parentDir} missing`,
    });
  }

  let detail;
  if (descriptor.configMode === "file") {
    detail = checkFileMode(descriptor, options);
  } else if (descriptor.configMode === "toml-text") {
    detail = checkTomlTextMode(descriptor, options);
  } else if (descriptor.configMode === "dir") {
    detail = checkKiroDirMode(descriptor, options);
  } else {
    detail = makeDetail(descriptor, "manual-only", {
      level: "info",
      detail: `Unsupported config mode: ${descriptor.configMode}`,
    });
  }

  return withAgentFixAction(withAgentBubbleNote(detail, prefs, descriptor.agentId), descriptor);
}

function summarize(details) {
  const counts = {};
  for (const detail of details) {
    counts[detail.status] = (counts[detail.status] || 0) + 1;
  }
  const warningCount = details.filter((detail) => statusLevel(detail.status) === "warning").length;
  const okCount = counts.ok || 0;
  let status = "pass";
  let level = null;
  if (warningCount > 0) {
    status = "warning";
    level = "warning";
  } else if (okCount === 0 && details.every((detail) => INFO_ONLY_STATUSES.has(detail.status))) {
    status = "critical";
    level = "critical";
  }
  return { status, level, counts, okCount, warningCount };
}

function checkAgentIntegrations(options = {}) {
  const detectorOptions = {
    fs: options.fs || fs,
    platform: options.platform || process.platform,
    prefs: options.prefs || {},
    validateCommand: options.validateCommand || validateHookCommand,
  };
  const descriptors = options.descriptors || getAgentDescriptors();
  const details = descriptors.map((descriptor) => checkAgent(descriptor, detectorOptions));
  const summary = summarize(details);
  return {
    id: "agent-integrations",
    ...summary,
    details,
  };
}

module.exports = {
  checkAgentIntegrations,
  checkAgent,
  findOpencodePluginEntry,
  summarize,
  __test: {
    checkFileMode,
    checkKiroDirMode,
    checkTomlTextMode,
    validateCommandList,
  },
};
