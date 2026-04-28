"use strict";

const fs = require("fs");
const path = require("path");

const HOOK_COMMAND_FRAGMENT_MAX = 128;

function stripCmdWrapper(command) {
  const match = String(command || "").trim().match(/^cmd \/d \/s \/c "(.+)"$/i);
  return match ? match[1] : String(command || "").trim();
}

function stripPowerShellEnvPrefix(command) {
  return String(command || "").replace(
    /^\s*(?:\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*(?:"[^"]*"|'(?:''|[^'])*'|[^;]+)\s*;\s*)*/i,
    ""
  );
}

function stripPosixEnvPrefix(command) {
  return String(command || "").replace(/^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "");
}

function stripPowerShellCallOperator(command) {
  return String(command || "").replace(/^\s*&\s+/, "");
}

function tokenizeCommand(command) {
  const input = String(command || "");
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    while (i < input.length && /\s/.test(input[i])) i++;
    if (i >= input.length) break;

    const quote = input[i] === '"' || input[i] === "'" ? input[i] : null;
    let token = "";
    if (quote) {
      i++;
      let closed = false;
      while (i < input.length) {
        const ch = input[i];
        if (
          ch === "\\"
          && quote === '"'
          && i + 1 < input.length
          && (input[i + 1] === '"' || input[i + 1] === "\\")
        ) {
          token += input[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          closed = true;
          i++;
          break;
        }
        token += ch;
        i++;
      }
      if (!closed) return null;
      tokens.push(token);
      continue;
    }

    while (i < input.length && !/\s/.test(input[i])) {
      token += input[i];
      i++;
    }
    if (token) tokens.push(token);
  }

  return tokens;
}

function parseHookCommand(command) {
  const withoutCmd = stripCmdWrapper(command);
  const withoutPsEnv = stripPowerShellEnvPrefix(withoutCmd);
  const withoutPosixEnv = stripPosixEnvPrefix(withoutPsEnv);
  const normalized = stripPowerShellCallOperator(withoutPosixEnv).trim();
  const tokens = tokenizeCommand(normalized);
  if (!tokens || tokens.length < 2) {
    return {
      ok: false,
      issue: "parse-failed",
      fragment: String(command || "").slice(0, HOOK_COMMAND_FRAGMENT_MAX),
    };
  }

  const executableIndex = tokens.findIndex((token) => token && !token.startsWith("-"));
  if (executableIndex === -1 || executableIndex + 1 >= tokens.length) {
    return {
      ok: false,
      issue: "parse-failed",
      fragment: String(command || "").slice(0, HOOK_COMMAND_FRAGMENT_MAX),
    };
  }

  return {
    ok: true,
    nodeBin: tokens[executableIndex],
    scriptPath: tokens[executableIndex + 1],
    normalizedCommand: normalized,
  };
}

function isAbsoluteAnyPlatform(value) {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function validateHookCommand(command, options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs || fs;
  const parsed = parseHookCommand(command);
  if (!parsed.ok) return parsed;

  const { nodeBin, scriptPath } = parsed;
  if (platform === "win32") {
    if (String(nodeBin).toLowerCase() !== "node") {
      if (!isAbsoluteAnyPlatform(nodeBin) || !fsImpl.existsSync(nodeBin)) {
        return { ok: false, issue: "nodeBin-invalid", nodeBin, scriptPath };
      }
    }
  } else {
    if (!path.posix.isAbsolute(nodeBin)) {
      return { ok: false, issue: "nodeBin-invalid", nodeBin, scriptPath };
    }
    try {
      fsImpl.accessSync(nodeBin, fs.constants.X_OK);
    } catch {
      return { ok: false, issue: "nodeBin-invalid", nodeBin, scriptPath };
    }
  }

  if (!isAbsoluteAnyPlatform(scriptPath) || !fsImpl.existsSync(scriptPath)) {
    return { ok: false, issue: "scriptPath-missing", nodeBin, scriptPath };
  }

  return { ok: true, nodeBin, scriptPath };
}

module.exports = {
  parseHookCommand,
  validateHookCommand,
  __test: {
    stripCmdWrapper,
    stripPowerShellEnvPrefix,
    stripPosixEnvPrefix,
    stripPowerShellCallOperator,
    tokenizeCommand,
  },
};
