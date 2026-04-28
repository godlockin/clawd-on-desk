const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

const {
  checkAgentIntegrations,
  findOpencodePluginEntry,
} = require("../src/doctor-detectors/agent-integrations");

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-doctor-agent-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function baseDescriptor(overrides = {}) {
  const root = makeTempDir();
  const parentDir = path.join(root, ".agent");
  return {
    agentId: "test-agent",
    agentName: "Test Agent",
    eventSource: "hook",
    parentDir,
    configPath: path.join(parentDir, "settings.json"),
    configMode: "file",
    autoInstall: true,
    marker: "test-hook.js",
    nested: false,
    ...overrides,
  };
}

function runOne(descriptor, options = {}) {
  return checkAgentIntegrations({
    fs,
    prefs: options.prefs || {},
    descriptors: [descriptor],
    validateCommand: options.validateCommand || (() => ({
      ok: true,
      nodeBin: "/node",
      scriptPath: "/app/hooks/test-hook.js",
    })),
  }).details[0];
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("checkAgentIntegrations", () => {
  it("returns not-installed when parent dir is missing", () => {
    const detail = runOne(baseDescriptor());
    assert.strictEqual(detail.status, "not-installed");
    assert.strictEqual(detail.level, "info");
    assert.strictEqual(detail.parentDirExists, false);
  });

  it("returns not-connected when config is missing for an auto-installed agent", () => {
    const descriptor = baseDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.configFileExists, false);
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "test-agent" });
  });

  it("returns config-corrupt when JSON parsing fails", () => {
    const descriptor = baseDescriptor();
    fs.mkdirSync(descriptor.parentDir, { recursive: true });
    fs.writeFileSync(descriptor.configPath, "{ nope", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
    assert.strictEqual(detail.level, "warning");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("validates flat hook commands and marks ok", () => {
    const descriptor = baseDescriptor();
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/app/hooks/test-hook.js"' }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.commandCount, 1);
  });

  it("validates nested hook commands when descriptor requests nested mode", () => {
    const descriptor = baseDescriptor({ nested: true });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{
          hooks: [{ command: '"/node" "/app/hooks/test-hook.js"' }],
        }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
  });

  it("returns broken-path when all matching commands fail validation", () => {
    const descriptor = baseDescriptor();
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/missing/test-hook.js"' }],
      },
    });

    const detail = runOne(descriptor, {
      validateCommand: () => ({
        ok: false,
        issue: "scriptPath-missing",
        nodeBin: "/node",
        scriptPath: "/missing/test-hook.js",
      }),
    });
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "test-agent" });
  });

  it("extracts Kimi TOML commands and validates scriptPath", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".kimi");
    const descriptor = baseDescriptor({
      agentId: "kimi-cli",
      marker: "kimi-hook.js",
      configMode: "toml-text",
      parentDir,
      configPath: path.join(parentDir, "config.toml"),
    });
    fs.mkdirSync(descriptor.parentDir, { recursive: true });
    fs.writeFileSync(
      descriptor.configPath,
      '[[hooks]]\nevent = "Stop"\ncommand = \'"node" "/missing/kimi-hook.js"\'\n',
      "utf8"
    );

    const detail = runOne(descriptor, {
      validateCommand: (command) => {
        assert.strictEqual(command, '"node" "/missing/kimi-hook.js"');
        return {
          ok: false,
          issue: "scriptPath-missing",
          nodeBin: "node",
          scriptPath: "/missing/kimi-hook.js",
        };
      },
    });
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.hookCommandIssue, "scriptPath-missing");
  });

  it("turns Codex ok into warning when codex_hooks=false", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".codex");
    const descriptor = baseDescriptor({
      agentId: "codex",
      marker: "codex-hook.js",
      parentDir,
      configPath: path.join(parentDir, "hooks.json"),
      nested: true,
      supplementary: {
        key: "codex_hooks",
        configPath: path.join(parentDir, "config.toml"),
      },
    });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ hooks: [{ command: '"/node" "/app/hooks/codex-hook.js"' }] }],
      },
    });
    fs.writeFileSync(descriptor.supplementary.configPath, "[features]\ncodex_hooks = false\n", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "not-connected");
    assert.strictEqual(detail.supplementary.value, "disabled");
    assert.deepStrictEqual(detail.fixAction, {
      type: "agent-integration",
      agentId: "codex",
      forceCodexHooksFeature: true,
    });
  });

  it("scans Kiro agent configs and reports fully-valid files", () => {
    const root = makeTempDir();
    const agentsDir = path.join(root, ".kiro", "agents");
    const descriptor = baseDescriptor({
      agentId: "kiro-cli",
      marker: "kiro-hook.js",
      parentDir: path.join(root, ".kiro"),
      configPath: agentsDir,
      configMode: "dir",
      nested: true,
    });
    writeJson(path.join(agentsDir, "clawd.json"), {
      hooks: {
        stop: [{ hooks: [{ command: '"/node" "/app/hooks/kiro-hook.js"' }] }],
      },
    });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "ok");
    assert.deepStrictEqual(detail.kiroScan.fullyValidFiles, ["clawd.json"]);
  });

  it("does not offer automatic repair when Kiro agent configs are corrupt", () => {
    const root = makeTempDir();
    const agentsDir = path.join(root, ".kiro", "agents");
    const descriptor = baseDescriptor({
      agentId: "kiro-cli",
      marker: "kiro-hook.js",
      parentDir: path.join(root, ".kiro"),
      configPath: agentsDir,
      configMode: "dir",
      nested: true,
    });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "broken.json"), "{ nope", "utf8");

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "config-corrupt");
    assert.strictEqual(detail.fixAction, undefined);
  });

  it("reports opencode stale absolute plugin paths", () => {
    const root = makeTempDir();
    const parentDir = path.join(root, ".config", "opencode");
    const pluginPath = path.join(root, "missing", "opencode-plugin");
    const descriptor = baseDescriptor({
      agentId: "opencode",
      marker: "opencode-plugin",
      parentDir,
      configPath: path.join(parentDir, "opencode.json"),
      detection: "opencode-plugin",
    });
    writeJson(descriptor.configPath, { plugin: [pluginPath] });

    const detail = runOne(descriptor);
    assert.strictEqual(detail.status, "broken-path");
    assert.strictEqual(detail.opencodeEntryIssue, "directory-missing");
    assert.deepStrictEqual(detail.fixAction, { type: "agent-integration", agentId: "opencode" });
  });

  it("adds a non-failing note when per-agent permission bubbles are disabled", () => {
    const descriptor = baseDescriptor({ agentId: "codex", marker: "codex-hook.js" });
    writeJson(descriptor.configPath, {
      hooks: {
        Stop: [{ command: '"/node" "/app/hooks/codex-hook.js"' }],
      },
    });

    const detail = runOne(descriptor, {
      prefs: { agents: { codex: { enabled: true, permissionsEnabled: false } } },
    });
    assert.strictEqual(detail.status, "ok");
    assert.strictEqual(detail.permissionsEnabled, false);
    assert.strictEqual(detail.permissionBubbleDetail, "permission bubbles disabled for this agent");
  });

  it("aggregates all-info states as critical when no integration is ok", () => {
    const result = checkAgentIntegrations({
      fs,
      descriptors: [
        baseDescriptor({ agentId: "copilot-cli", configMode: "none-global" }),
        baseDescriptor({ agentId: "missing-agent" }),
      ],
    });
    assert.strictEqual(result.status, "critical");
    assert.strictEqual(result.level, "critical");
  });
});

describe("findOpencodePluginEntry", () => {
  it("matches only absolute plugin entries by basename", () => {
    const absEntry = "C:\\clawd\\hooks\\opencode-plugin";
    assert.strictEqual(
      findOpencodePluginEntry(["vendor/opencode-plugin", absEntry], "opencode-plugin"),
      absEntry
    );
  });
});
