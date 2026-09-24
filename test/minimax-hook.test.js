const { describe, it } = require("node:test");
const assert = require("node:assert");

const { __test } = require("../hooks/minimax-hook");
const { runSpawnedHook } = require("./helpers/spawned-hook");

const HOOK_PATH = require("node:path").resolve(__dirname, "..", "hooks", "minimax-hook.js");

function runMinimaxHook(payload, options = {}) {
  return runSpawnedHook({
    script: HOOK_PATH,
    payload,
    httpContract: options.httpContract || "expect-attempt",
    env: {
      CLAWD_POST_RECORDER_SUCCEED: "1",
      ...(options.env || {}),
    },
  });
}

function postedBody(result) {
  const post = result.attempts && result.attempts.find(
    (attempt) => attempt.kind === "request" && typeof attempt.body === "string"
  );
  assert.ok(post, `expected a recorded POST attempt; attempts=${JSON.stringify(result.attempts)}`);
  return JSON.parse(post.body);
}

describe("minimax hook title derivation", () => {
  const { resolveSessionTitle } = __test;

  it("derives the title from the first line of the prompt on UserPromptSubmit", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "你能做什么" }, "UserPromptSubmit"),
      "你能做什么"
    );
  });

  it("uses the first non-empty line of a multiline prompt", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "\n  修一下 bug  \n然后跑测试" }, "UserPromptSubmit"),
      "修一下 bug"
    );
  });

  it("returns null when the prompt is empty or missing", () => {
    assert.strictEqual(resolveSessionTitle({}, "UserPromptSubmit"), null);
    assert.strictEqual(resolveSessionTitle({ prompt: "   \n\n" }, "UserPromptSubmit"), null);
  });

  it("returns null when the payload is missing", () => {
    assert.strictEqual(resolveSessionTitle(null, "UserPromptSubmit"), null);
  });

  it("truncates long prompt titles with an ellipsis", () => {
    const long = "写一个超长的功能描述".repeat(20);
    const title = resolveSessionTitle({ prompt: long }, "UserPromptSubmit");
    assert.ok(title.length <= 41, `title too long: ${title.length}`);
    assert.ok(title.endsWith("…"));
  });

  it("refuses secret-looking prompts instead of leaking them as titles", () => {
    assert.strictEqual(
      resolveSessionTitle({ prompt: "我的 api_key 是 sk-abcdefghijklmnopqrstuvwxyz" }, "UserPromptSubmit"),
      null
    );
  });

  it("does not derive a title from prompts on non-UserPromptSubmit events", () => {
    assert.strictEqual(resolveSessionTitle({ prompt: "你能做什么" }, "Stop"), null);
  });
});

describe("minimax hook lifecycle", () => {
  it("maps every registered event to the Clawd state machine and emits {}", () => {
    // One spawned run per representative event class; the full event set is
    // pinned by agents/minimax.js assertions in test/registry.test.js.
    const cases = [
      ["SessionStart", "idle"],
      ["SessionEnd", "sleeping"],
      ["UserPromptSubmit", "thinking"],
      ["PreToolUse", "working"],
      ["PostToolUse", "working"],
      ["Stop", "attention"],
      ["SubagentStart", "juggling"],
      ["SubagentStop", "working"],
      ["PreCompact", "sweeping"],
      ["PostCompact", "attention"],
    ];
    for (const [event, state] of cases) {
      const result = runMinimaxHook({
        session_id: `sess-${event}`,
        cwd: "/tmp/project",
        hook_event_name: event,
        ...(event === "PreToolUse" ? { tool_name: "Bash", tool_input: { command: "ls" } } : {}),
      });
      assert.strictEqual(result.status, 0, `${event}: exit code`);
      assert.strictEqual(result.stdout.trim(), "{}", `${event}: stdout must stay {} (abstain)`);
      const body = postedBody(result);
      assert.strictEqual(body.state, state, `${event}: mapped state`);
      assert.strictEqual(body.event, event);
      assert.strictEqual(body.agent_id, "minimax");
    }
  });

  it("never emits a permission decision for tool events (state-only)", () => {
    const result = runMinimaxHook({
      session_id: "sess-perm",
      cwd: "/tmp/project",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    assert.strictEqual(result.stdout.trim(), "{}");
    const body = postedBody(result);
    assert.strictEqual(body.decision, undefined);
    assert.strictEqual(body.permissionDecision, undefined);
    assert.strictEqual(body.hookSpecificOutput, undefined);
  });

  it("does not register PermissionRequest (unmapped events answer {} without a POST)", () => {
    const result = runMinimaxHook({
      session_id: "sess-permreq",
      cwd: "/tmp/project",
      hook_event_name: "PermissionRequest",
    }, { httpContract: "expect-none" });
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
    assert.ok(!result.attempts.some((attempt) => attempt.kind === "request"));
  });

  it("namespaces the session id with the minimax: prefix", () => {
    const result = runMinimaxHook({
      session_id: "sess-abc-1",
      cwd: "/tmp/project",
      hook_event_name: "UserPromptSubmit",
      prompt: "帮我写个倒计时组件",
    });

    assert.strictEqual(result.status, 0);
    const body = postedBody(result);
    assert.strictEqual(body.agent_id, "minimax");
    assert.strictEqual(body.session_id, "minimax:sess-abc-1");
    assert.strictEqual(body.cwd, "/tmp/project");
    assert.strictEqual(body.session_title, "帮我写个倒计时组件");
  });

  it("skips the POST entirely when the session id is missing or blank", () => {
    for (const missing of [undefined, "", "   ", "default"]) {
      const result = runMinimaxHook({
        session_id: missing,
        cwd: "/tmp/project",
        hook_event_name: "UserPromptSubmit",
        prompt: "没有 session 的事件",
      }, { httpContract: "expect-none" });

      assert.strictEqual(result.status, 0, `session_id=${JSON.stringify(missing)}`);
      assert.strictEqual(result.stdout.trim(), "{}", `session_id=${JSON.stringify(missing)}`);
    }
  });

  it("answers MiniMax immediately even when the POST is blocked (offline)", () => {
    const result = runMinimaxHook({
      session_id: "sess-abc-4",
      cwd: "/tmp/project",
      hook_event_name: "PreToolUse",
    }, { httpContract: "block" });

    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
  });
});

describe("minimax hook import safety", () => {
  it("importing the module for __test does not read stdin, write stdout, or exit", () => {
    // The require at the top of this file already exercised this — module
    // import must not start the real lifecycle. Spawn a trivial probe to
    // confirm the file loads without emitting anything on stdout.
    const { spawnSync } = require("node:child_process");
    const probe = spawnSync(
      process.execPath,
      ["-e", `require(${JSON.stringify(HOOK_PATH)}); process.stdout.write("loaded")`],
      { encoding: "utf8", timeout: 5000 }
    );
    assert.strictEqual(probe.status, 0, `probe stderr=${probe.stderr}`);
    assert.strictEqual(probe.stdout, "loaded");
  });
});
