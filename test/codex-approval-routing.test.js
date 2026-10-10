"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveCodexApprovalRoute } = require("../src/codex-approval-routing");
const SESSION = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
const TURN = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
const line = (type, payload) => JSON.stringify({ type, payload });
function fixture(t, reviewer = "user", after = [], extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-"));
  const sessions = path.join(home, "sessions");
  fs.mkdirSync(sessions);
  const file = path.join(sessions, "rollout-" + SESSION + ".jsonl");
  fs.writeFileSync(file, [
    line("session_meta", { id: SESSION }),
    line("turn_context", { turn_id: TURN, approvals_reviewer: reviewer, approval_policy: "on-request" }),
    ...after,
  ].join("\n") + "\n");
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const data = { session_id: "codex:" + SESSION, turn_id: TURN, tool_name: "Bash",
    permission_mode: "default", transcript_path: file, ...extra };
  return { home, file, data, route: (opts) => resolveCodexApprovalRoute(data, { codexHome: home, ...opts }) };
}
test("Auto can mirror a current human-reviewed shell request", (t) => {
  assert.equal(fixture(t).route().owner, "clawd");
});
test("Auto never blocks an automatic reviewer", (t) => {
  assert.equal(fixture(t, "auto_review").route().owner, "codex");
});
test("a same-turn settings update invalidates the turn snapshot", (t) => {
  const f = fixture(t, "user", [line("event_msg", { type: "thread_settings_applied",
    thread_settings: { approvals_reviewer: "auto_review" } })]);
  assert.equal(f.route().owner, "codex");
});
test("Auto does not borrow a later or earlier turn", (t) => {
  const f = fixture(t, "user", [line("turn_context", { turn_id: "other-turn",
    approvals_reviewer: "user", approval_policy: "on-request" })]);
  assert.equal(f.route().owner, "codex");
  f.data.turn_id = "missing-turn";
  assert.equal(f.route().owner, "codex");
});
test("MCP requests delegate because their reviewer can override the turn", (t) => {
  assert.equal(fixture(t, "user", [], { tool_name: "mcp__github__get_issue" }).route().owner, "codex");
});
test("a foreign session or transcript outside Codex sessions cannot select Clawd", (t) => {
  const f = fixture(t);
  f.data.session_id = "codex:019d23d4-f1a9-7633-b9c7-758327137228";
  assert.equal(f.route().owner, "codex");
  f.data.session_id = "codex:" + SESSION;
  const foreign = path.join(f.home, "foreign.jsonl");
  fs.copyFileSync(f.file, foreign); f.data.transcript_path = foreign;
  assert.equal(f.route().owner, "codex");
});
test("missing, partial and corrupt evidence delegates without a decision", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.file, '{"type":"event_msg"');
  assert.equal(f.route().owner, "codex");
  fs.writeFileSync(f.file, "corrupt\n");
  assert.equal(f.route().owner, "codex");
  f.data.transcript_path = null;
  assert.equal(f.route().owner, "codex");
});
test("completed turns and unreadable or bounded-out snapshots delegate", (t) => {
  const f = fixture(t, "user", [line("event_msg", { type: "task_complete", turn_id: TURN })]);
  assert.equal(f.route().owner, "codex");
  const g = fixture(t, "user", [line("response_item", { type: "message", text: "x".repeat(4096) })]);
  assert.equal(g.route({ maxTailBytes: 1024 }).owner, "codex");
  fs.unlinkSync(g.file);
  assert.equal(g.route().owner, "codex");
});
test("remote and bypass requests cannot be mistaken for local human approval", (t) => {
  assert.equal(fixture(t, "user", [], { host: "remote" }).route().owner, "codex");
  assert.equal(fixture(t, "user", [], { permission_mode: "bypassPermissions" }).route().owner, "codex");
});
test("noninteractive or absent reviewer context stays with Codex", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.file, [line("session_meta", { id: SESSION }),
    line("turn_context", { turn_id: TURN, approvals_reviewer: "user", approval_policy: "never" })].join("\n") + "\n");
  assert.equal(f.route().owner, "codex");
});
