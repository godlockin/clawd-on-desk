const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const {
  writeJsonAtomic,
  asarUnpackedPath,
  extractExistingNodeBin,
  formatNodeHookCommand,
} = require("./json-utils");

const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".codex");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "hooks.json");
const DEFAULT_FEATURES_CONFIG = path.join(DEFAULT_PARENT_DIR, "config.toml");

const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "Stop",
];

function timeoutForCodexEvent(event) {
  return event === "PermissionRequest" ? 600 : 30;
}

function getCodexPaths(options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const codexDir = options.codexDir || path.join(homeDir, ".codex");
  return {
    codexDir,
    hooksPath: options.hooksPath || path.join(codexDir, "hooks.json"),
    configPath: options.configPath || path.join(codexDir, "config.toml"),
  };
}

function buildCodexHookCommand(nodeBin, hookScript, platform = process.platform) {
  return formatNodeHookCommand(nodeBin, hookScript, {
    platform,
    // Real Windows Codex hook runs execute command strings through
    // PowerShell. A bare quoted executable (`"node" "hook.js"`) is parsed as
    // a string literal plus an unexpected token and exits 1, so use the
    // PowerShell call operator.
    windowsWrapper: "powershell",
  });
}

function quotePosixEnvValue(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function quotePowerShellEnvValue(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function withCommandEnv(command, env, platform = process.platform) {
  if (!env || typeof env !== "object") return command;
  const entries = Object.entries(env)
    .filter(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && value !== undefined && value !== null);
  if (!entries.length) return command;

  if (platform === "win32") {
    const prefix = entries
      .map(([key, value]) => `$env:${key}=${quotePowerShellEnvValue(value)}`)
      .join("; ");
    return `${prefix}; ${command}`;
  }

  const prefix = entries
    .map(([key, value]) => `${key}=${quotePosixEnvValue(value)}`)
    .join(" ");
  return `${prefix} ${command}`;
}

function readJsonIfPresent(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new Error(`Failed to read ${label}: ${err.message}`);
  }
}

function parseTomlTableHeader(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("[")) return null;

  const isArray = trimmed.startsWith("[[");
  let quote = null;
  const start = isArray ? 2 : 1;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (isArray) {
      if (ch !== "]" || trimmed[i + 1] !== "]") continue;
      const rest = trimmed.slice(i + 2).trim();
      if (rest && !rest.startsWith("#")) return null;
      return { name: trimmed.slice(start, i).trim(), array: true };
    }
    if (ch === "]") {
      const rest = trimmed.slice(i + 1).trim();
      if (rest && !rest.startsWith("#")) return null;
      return { name: trimmed.slice(start, i).trim(), array: false };
    }
  }
  return null;
}

function isFeaturesTableHeader(header) {
  return !!header && !header.array && header.name.replace(/\s+/g, "") === "features";
}

function ensureCodexHooksFeature(configPath, options = {}) {
  const force = !!options.force;
  let text = "";
  let existed = true;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      return { changed: false, warning: `Failed to read config.toml: ${err.message}` };
    }
    existed = false;
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/\r?\n/) : [];
  let featuresStart = -1;
  let featuresEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const section = parseTomlTableHeader(lines[i]);
    if (!section) continue;
    if (isFeaturesTableHeader(section)) {
      featuresStart = i;
      continue;
    }
    if (featuresStart !== -1 && i > featuresStart) {
      featuresEnd = i;
      break;
    }
  }

  if (featuresStart !== -1) {
    for (let i = featuresStart + 1; i < featuresEnd; i++) {
      const match = lines[i].match(/^\s*codex_hooks\s*=\s*(true|false)\s*(?:#.*)?$/i);
      if (!match) continue;
      if (match[1].toLowerCase() === "false") {
        if (force) {
          lines[i] = lines[i].replace(/=\s*false/i, "= true");
          const nextText = `${lines.join(newline).replace(/\s*$/, "")}${newline}`;
          fs.mkdirSync(path.dirname(configPath), { recursive: true });
          fs.writeFileSync(configPath, nextText, "utf-8");
          return { changed: true, warning: null };
        }
        return {
          changed: false,
          warning: "config.toml already has [features].codex_hooks = false; leaving it unchanged.",
        };
      }
      return { changed: false, warning: null };
    }

    lines.splice(featuresStart + 1, 0, "codex_hooks = true");
  } else {
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("[features]", "codex_hooks = true");
  }

  const nextText = `${lines.join(newline).replace(/\s*$/, "")}${newline}`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, nextText, "utf-8");
  return { changed: true, warning: existed ? null : null };
}

function findCodexCommandHook(entry, marker) {
  if (!entry || typeof entry !== "object") return null;
  const innerHooks = Array.isArray(entry.hooks) ? entry.hooks : [];
  for (const hook of innerHooks) {
    if (!hook || typeof hook !== "object") continue;
    if (typeof hook.command === "string" && hook.command.includes(marker)) return hook;
  }
  if (typeof entry.command === "string" && entry.command.includes(marker)) return entry;
  return null;
}

function registerCodexCommandHooks(options = {}) {
  const marker = options.marker;
  const scriptName = options.scriptName || marker;
  const events = Array.isArray(options.events) ? options.events : CODEX_HOOK_EVENTS;
  if (!marker || !scriptName) throw new Error("registerCodexCommandHooks requires marker and scriptName");

  const { codexDir, hooksPath, configPath } = getCodexPaths(options);
  if (!options.hooksPath && !options.codexDir && !fs.existsSync(codexDir)) {
    if (!options.silent) console.log("Clawd: ~/.codex/ not found - skipping Codex hook registration");
    return { added: 0, skipped: 0, updated: 0, configChanged: false, warnings: [] };
  }

  const warnings = [];
  const feature = ensureCodexHooksFeature(configPath, {
    force: options.forceCodexHooksFeature === true,
  });
  if (feature.warning) warnings.push(feature.warning);

  const hookScript = asarUnpackedPath(path.resolve(__dirname, scriptName).replace(/\\/g, "/"));
  const settings = readJsonIfPresent(hooksPath, "hooks.json");
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, marker, { nested: true })
    || "node";
  const baseCommand = buildCodexHookCommand(
    nodeBin,
    hookScript,
    options.platform || process.platform
  );
  const commandEnv = {
    ...(options.env || {}),
    ...(options.remote ? { CLAWD_REMOTE: "1" } : {}),
  };
  const desiredCommand = withCommandEnv(
    baseCommand,
    commandEnv,
    options.platform || process.platform
  );

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of events) {
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let stale = false;
    const desiredTimeout = timeoutForCodexEvent(event);

    for (const entry of arr) {
      const hook = findCodexCommandHook(entry, marker);
      if (!hook) continue;
      found = true;
      if (hook.type !== "command") {
        hook.type = "command";
        stale = true;
      }
      if (hook.command !== desiredCommand) {
        hook.command = desiredCommand;
        stale = true;
      }
      if (hook.timeout !== desiredTimeout) {
        hook.timeout = desiredTimeout;
        stale = true;
      }
      break;
    }

    if (found) {
      if (stale) {
        updated++;
        changed = true;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push({
      hooks: [{ type: "command", command: desiredCommand, timeout: desiredTimeout }],
    });
    added++;
    changed = true;
  }

  if (changed) writeJsonAtomic(hooksPath, settings);

  if (!options.silent) {
    const label = options.label || "Codex hooks";
    console.log(`Clawd ${label} -> ${hooksPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
    if (feature.changed) console.log(`  Enabled [features].codex_hooks in ${configPath}`);
    for (const warning of warnings) console.warn(`  Warning: ${warning}`);
  }

  return { added, skipped, updated, configChanged: feature.changed, warnings };
}

function unregisterCodexCommandHooks(options = {}) {
  const marker = options.marker;
  const events = Array.isArray(options.events) ? options.events : CODEX_HOOK_EVENTS;
  if (!marker) throw new Error("unregisterCodexCommandHooks requires marker");

  const { hooksPath } = getCodexPaths(options);
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(hooksPath, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return { removed: 0 };
    throw new Error(`Failed to read hooks.json: ${err.message}`);
  }
  if (!settings.hooks || typeof settings.hooks !== "object") return { removed: 0 };

  let removed = 0;
  let changed = false;
  for (const event of events) {
    const arr = settings.hooks[event];
    if (!Array.isArray(arr)) continue;
    const next = arr.filter((entry) => !findCodexCommandHook(entry, marker));
    removed += arr.length - next.length;
    if (next.length !== arr.length) {
      settings.hooks[event] = next;
      changed = true;
    }
  }

  if (changed) writeJsonAtomic(hooksPath, settings);
  if (!options.silent) console.log(`Clawd Codex hooks removed: ${removed}`);
  return { removed };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  DEFAULT_FEATURES_CONFIG,
  CODEX_HOOK_EVENTS,
  buildCodexHookCommand,
  ensureCodexHooksFeature,
  findCodexCommandHook,
  parseTomlTableHeader,
  registerCodexCommandHooks,
  timeoutForCodexEvent,
  unregisterCodexCommandHooks,
  withCommandEnv,
};
