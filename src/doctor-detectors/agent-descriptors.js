"use strict";

const path = require("path");
const { getAgent } = require("../../agents/registry");

const claude = require("../../hooks/install");
const codex = require("../../hooks/codex-install");
const cursor = require("../../hooks/cursor-install");
const gemini = require("../../hooks/gemini-install");
const codebuddy = require("../../hooks/codebuddy-install");
const kiro = require("../../hooks/kiro-install");
const kimi = require("../../hooks/kimi-install");
const opencode = require("../../hooks/opencode-install");

function agentName(agentId) {
  const agent = getAgent(agentId);
  return agent && agent.name ? agent.name : agentId;
}

function agentEventSource(agentId) {
  const agent = getAgent(agentId);
  return agent && agent.eventSource ? agent.eventSource : "hook";
}

const AGENT_DESCRIPTORS = Object.freeze([
  Object.freeze({
    agentId: "claude-code",
    agentName: agentName("claude-code"),
    eventSource: agentEventSource("claude-code"),
    parentDir: claude.DEFAULT_PARENT_DIR,
    configPath: claude.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "clawd-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "codex",
    agentName: agentName("codex"),
    eventSource: agentEventSource("codex"),
    parentDir: codex.DEFAULT_PARENT_DIR,
    configPath: codex.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "codex-hook.js",
    nested: true,
    supplementary: {
      key: "codex_hooks",
      configPath: codex.DEFAULT_FEATURES_CONFIG,
    },
  }),
  Object.freeze({
    agentId: "copilot-cli",
    agentName: agentName("copilot-cli"),
    eventSource: agentEventSource("copilot-cli"),
    parentDir: null,
    configPath: null,
    configMode: "none-global",
    autoInstall: false,
    marker: "copilot-hook.js",
    scriptPath: path.join(__dirname, "..", "..", "hooks", "copilot-hook.js"),
  }),
  Object.freeze({
    agentId: "cursor-agent",
    agentName: agentName("cursor-agent"),
    eventSource: agentEventSource("cursor-agent"),
    parentDir: cursor.DEFAULT_PARENT_DIR,
    configPath: cursor.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "cursor-hook.js",
    nested: false,
  }),
  Object.freeze({
    agentId: "gemini-cli",
    agentName: agentName("gemini-cli"),
    eventSource: agentEventSource("gemini-cli"),
    parentDir: gemini.DEFAULT_PARENT_DIR,
    configPath: gemini.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "gemini-hook.js",
    nested: false,
  }),
  Object.freeze({
    agentId: "codebuddy",
    agentName: agentName("codebuddy"),
    eventSource: agentEventSource("codebuddy"),
    parentDir: codebuddy.DEFAULT_PARENT_DIR,
    configPath: codebuddy.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    marker: "codebuddy-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "kiro-cli",
    agentName: agentName("kiro-cli"),
    eventSource: agentEventSource("kiro-cli"),
    parentDir: kiro.DEFAULT_PARENT_DIR,
    configPath: kiro.DEFAULT_AGENTS_DIR,
    configMode: "dir",
    autoInstall: true,
    marker: "kiro-hook.js",
    nested: true,
  }),
  Object.freeze({
    agentId: "kimi-cli",
    agentName: agentName("kimi-cli"),
    eventSource: agentEventSource("kimi-cli"),
    parentDir: kimi.DEFAULT_PARENT_DIR,
    configPath: kimi.DEFAULT_CONFIG_PATH,
    configMode: "toml-text",
    autoInstall: true,
    marker: "kimi-hook.js",
  }),
  Object.freeze({
    agentId: "opencode",
    agentName: agentName("opencode"),
    eventSource: agentEventSource("opencode"),
    parentDir: opencode.DEFAULT_PARENT_DIR,
    configPath: opencode.DEFAULT_CONFIG_PATH,
    configMode: "file",
    autoInstall: true,
    // opencode registers a plugin directory, not a command hook script.
    // Detection matches an absolute plugin entry by basename.
    marker: "opencode-plugin",
    detection: "opencode-plugin",
  }),
]);

function getAgentDescriptors() {
  return AGENT_DESCRIPTORS.map((descriptor) => ({ ...descriptor }));
}

function getAgentDescriptor(agentId) {
  const descriptor = AGENT_DESCRIPTORS.find((entry) => entry.agentId === agentId);
  return descriptor ? { ...descriptor } : null;
}

module.exports = {
  AGENT_DESCRIPTORS,
  getAgentDescriptors,
  getAgentDescriptor,
};
