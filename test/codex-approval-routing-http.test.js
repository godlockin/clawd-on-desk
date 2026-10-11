"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPermissionIngressHarness, postPermission, waitUntil } = require("./helpers/permission-ingress-harness");

test("Auto keeps automatic and human approval sockets independent", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-routing-http-"));
  const prior = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  fs.mkdirSync(path.join(home, "sessions"));
  const sidA = "01a119d3-1893-7f42-aadc-fa33ca4166a8";
  const sidB = "019d23d4-f1a9-7633-b9c7-758327137228";
  const turn = "01a119d7-24b5-7010-9da2-d8791ff8a1d1";
  function body(sid, reviewer) {
    const file = path.join(home, "sessions", "rollout-" + sid + ".jsonl");
    fs.writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { id: sid } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: turn,
        approvals_reviewer: reviewer, approval_policy: "on-request" } }),
    ].join("\n") + "\n");
    return { agent_id: "codex", hook_source: "codex-official", session_id: "codex:" + sid,
      turn_id: turn, permission_mode: "default", transcript_path: file,
      tool_name: "Bash", tool_input: { command: "echo harmless" } };
  }
  const h = await createPermissionIngressHarness({ ctxOverrides: {
    getCodexPermissionMode: () => "auto",
  } });
  t.after(async () => {
    await h.close();
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const human = postPermission(h.port, body(sidA, "user"));
  await waitUntil(() => h.permission.pendingPermissions.length === 1, "human request not mirrored");
  const entry = h.permission.pendingPermissions[0];
  assert.equal(entry.codexAutoManual, true);
  assert.equal(human.settled, false);
  const automatic = postPermission(h.port, body(sidB, "auto_review"));
  const native = await automatic.response;
  assert.equal(native.status, 204);
  assert.equal(native.body, "");
  assert.equal(h.permission.pendingPermissions.length, 1);
  assert.equal(h.shown.length, 1);
  assert.equal(human.settled, false);
  h.permission.resolvePermissionEntry(entry, "allow");
  const result = await human.response;
  assert.equal(JSON.parse(result.body).hookSpecificOutput.decision.behavior, "allow");
  assert.equal(h.permission.pendingPermissions.length, 0);
});
