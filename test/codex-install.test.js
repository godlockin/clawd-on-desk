const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  CODEX_OFFICIAL_HOOK_EVENTS,
  CODEX_STATE_HOOK_EVENTS,
  buildCodexStateHookCommand,
  registerCodexHooks,
  unregisterCodexHooks,
} = require("../hooks/codex-install");
const { CODEX_DEBUG_HOOK_EVENTS, registerCodexDebugHooks } = require("../hooks/codex-debug-install");

const MARKER = "codex-hook.js";
const DEBUG_MARKER = "codex-debug-hook.js";
const tempDirs = [];

function makeTempCodexDir(initialHooks = null, configText = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-codex-install-"));
  const codexDir = path.join(tmpDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  if (initialHooks !== null) {
    fs.writeFileSync(path.join(codexDir, "hooks.json"), JSON.stringify(initialHooks, null, 2), "utf8");
  }
  if (configText !== null) {
    fs.writeFileSync(path.join(codexDir, "config.toml"), configText, "utf8");
  }
  tempDirs.push(tmpDir);
  return codexDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("Codex official hook installer", () => {
  it("registers official hook events on fresh install including PermissionRequest", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CODEX_STATE_HOOK_EVENTS.length);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.configChanged, true);
    assert.deepStrictEqual(CODEX_STATE_HOOK_EVENTS, CODEX_OFFICIAL_HOOK_EVENTS);

    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      assert.ok(Array.isArray(settings.hooks[event]), `missing ${event}`);
      assert.strictEqual(settings.hooks[event].length, 1);
      const entry = settings.hooks[event][0];
      assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, "matcher"), false);
      const hook = entry.hooks[0];
      assert.strictEqual(hook.type, "command");
      assert.strictEqual(hook.timeout, event === "PermissionRequest" ? 600 : 30);
      assert.ok(hook.command.includes(MARKER));
      assert.ok(hook.command.includes("/usr/local/bin/node"));
    }
  });

  it("is idempotent on second run", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    const before = fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8");

    const result = registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    assert.strictEqual(result.added, 0);
    assert.strictEqual(result.updated, 0);
    assert.strictEqual(result.skipped, CODEX_OFFICIAL_HOOK_EVENTS.length);
    assert.strictEqual(fs.readFileSync(path.join(codexDir, "hooks.json"), "utf8"), before);
  });

  it("coexists with debug hooks without updating them", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexDebugHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/opt/homebrew/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      assert.ok(commands.some((command) => command.includes(MARKER)));
      assert.ok(commands.some((command) => command.includes(DEBUG_MARKER)));
    }
    assert.ok(settings.hooks.PermissionRequest[0].hooks[0].command.includes(DEBUG_MARKER));
  });

  it("does not flip an explicit codex_hooks=false", () => {
    const codexDir = makeTempCodexDir({}, "[features]\ncodex_hooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
    });

    assert.strictEqual(result.configChanged, false);
    assert.match(result.warnings[0], /codex_hooks = false/);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\ncodex_hooks = false\n"
    );
  });

  it("can force codex_hooks=true during an explicit repair", () => {
    const codexDir = makeTempCodexDir({}, "[features]\ncodex_hooks = false\n");
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      forceCodexHooksFeature: true,
    });

    assert.strictEqual(result.configChanged, true);
    assert.deepStrictEqual(result.warnings, []);
    assert.strictEqual(
      fs.readFileSync(path.join(codexDir, "config.toml"), "utf8"),
      "[features]\ncodex_hooks = true\n"
    );
  });

  it("formats Windows commands for PowerShell execution", () => {
    const command = buildCodexStateHookCommand(
      "C:\\Program Files\\nodejs\\node.exe",
      "D:/animation/hooks/codex-hook.js",
      "win32"
    );

    assert.strictEqual(command, '& "C:\\Program Files\\nodejs\\node.exe" "D:/animation/hooks/codex-hook.js"');
  });

  it("registers remote hooks with CLAWD_REMOTE in the command environment", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "/usr/local/bin/node",
      platform: "linux",
      remote: true,
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.strictEqual(
      command,
      "CLAWD_REMOTE='1' \"/usr/local/bin/node\" \"" + path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/") + "\""
    );
  });

  it("registers Windows remote hooks with a PowerShell env prefix", () => {
    const codexDir = makeTempCodexDir({});
    const result = registerCodexHooks({
      silent: true,
      codexDir,
      nodeBin: "C:\\node.exe",
      platform: "win32",
      remote: true,
    });

    assert.strictEqual(result.added, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    const command = settings.hooks.SessionStart[0].hooks[0].command;
    assert.strictEqual(
      command,
      "$env:CLAWD_REMOTE='1'; & \"C:\\node.exe\" \"" + path.resolve(__dirname, "..", "hooks", "codex-hook.js").replace(/\\/g, "/") + "\""
    );
  });

  it("unregisters only official state hooks", () => {
    const codexDir = makeTempCodexDir({});
    registerCodexDebugHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });
    registerCodexHooks({ silent: true, codexDir, nodeBin: "/usr/local/bin/node", platform: "linux" });

    const result = unregisterCodexHooks({ silent: true, codexDir });

    assert.strictEqual(result.removed, CODEX_OFFICIAL_HOOK_EVENTS.length);
    const settings = readJson(path.join(codexDir, "hooks.json"));
    for (const event of CODEX_OFFICIAL_HOOK_EVENTS) {
      const commands = settings.hooks[event].flatMap((entry) => entry.hooks.map((hook) => hook.command));
      assert.ok(!commands.some((command) => command.includes(MARKER)));
      assert.ok(commands.some((command) => command.includes(DEBUG_MARKER)));
    }
    assert.strictEqual(settings.hooks.PermissionRequest.length, 1);
    assert.strictEqual(CODEX_DEBUG_HOOK_EVENTS.includes("PermissionRequest"), true);
  });
});
