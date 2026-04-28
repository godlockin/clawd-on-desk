"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

describe("main Codex official hook JSONL suppression", () => {
  it("suppresses guardian_assessment for hook-active Codex sessions", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const match = source.match(/CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = new Set\(\[([\s\S]*?)\]\);/);
    assert.ok(match, "main.js should define the Codex official hook suppression set");
    assert.ok(
      match[1].includes('"event_msg:guardian_assessment"'),
      "guardian_assessment should not re-drive hook-active Codex sessions from JSONL"
    );
  });
});
