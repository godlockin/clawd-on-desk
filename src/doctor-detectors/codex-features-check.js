"use strict";

const fs = require("fs");

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < line.length) {
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
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

function checkCodexHooksFeatureText(text) {
  if (typeof text !== "string") {
    return { value: "uncertain", detail: "config is not text" };
  }

  let inFeatures = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;

    const tableMatch = line.match(/^\[([^\]]+)\]$/);
    if (tableMatch) {
      inFeatures = tableMatch[1].trim() === "features";
      continue;
    }

    if (!inFeatures) continue;
    const featureMatch = line.match(/^codex_hooks\s*=\s*(true|false)\b/i);
    if (featureMatch) {
      return {
        value: featureMatch[1].toLowerCase() === "true" ? "enabled" : "disabled",
        detail: `codex_hooks=${featureMatch[1].toLowerCase()}`,
      };
    }
    if (/^codex_hooks\s*=/.test(line)) {
      return { value: "uncertain", detail: "codex_hooks is not a boolean" };
    }
  }

  return { value: "uncertain", detail: "codex_hooks not found" };
}

function checkCodexHooksFeature(configPath, options = {}) {
  const fsImpl = options.fs || fs;
  let text;
  try {
    text = fsImpl.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { value: "uncertain", detail: "config.toml missing" };
    }
    return { value: "uncertain", detail: err && err.message ? err.message : "config.toml unreadable" };
  }
  return checkCodexHooksFeatureText(text);
}

module.exports = {
  checkCodexHooksFeature,
  checkCodexHooksFeatureText,
};
