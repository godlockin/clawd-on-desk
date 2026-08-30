"use strict";

// Tests for hooks/clawd-permission-hook.js
// Covers stdin parse, allow/deny/no-decision translation, probe failure,
// HTTP 5xx, timeout, JSON parse failure, SIGTERM mid-flight DELETE,
// and request_id uuid format.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const HOOK_PATH = path.resolve(__dirname, "..", "hooks", "clawd-permission-hook.js");
const SERVER_HEADER = "x-clawd-server";
const SERVER_ID = "clawd-on-desk";

const {
  buildAllowOutput,
  buildDenyOutput,
  buildNoDecisionOutput,
  buildPermissionBody,
  getDecisionWaitMs,
  getHookTimeoutMs,
  translateServerResponse,
} = require("../hooks/clawd-permission-hook.js");

// ── Pure-function tests ─────────────────────────────────────────────────────

describe("clawd-permission-hook pure helpers", () => {
  it("buildPermissionBody only fires for PermissionRequest event", () => {
    assert.strictEqual(
      buildPermissionBody({ hook_event_name: "Stop" }, () => ({}), "rid"),
      null
    );
    assert.strictEqual(
      buildPermissionBody({}, () => ({}), "rid"),
      null
    );
  });

  it("buildPermissionBody includes agent_id, request_id, hook_source, tool fields", () => {
    const body = buildPermissionBody(
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "sess-1",
        tool_use_id: "tu-1",
        cwd: "/repo",
        transcript_path: "/tmp/t.jsonl",
        permission_mode: "default",
      },
      () => ({ stablePid: 11, agentPid: 12, detectedEditor: "code", pidChain: [11, 12] }),
      "REQID"
    );
    assert.strictEqual(body.agent_id, "claude-code");
    assert.strictEqual(body.hook_source, "claude-code-wrapper");
    assert.strictEqual(body.request_id, "REQID");
    assert.strictEqual(body.tool_name, "Bash");
    assert.deepStrictEqual(body.tool_input, { command: "ls" });
    assert.strictEqual(body.session_id, "sess-1");
    assert.strictEqual(body.tool_use_id, "tu-1");
    assert.strictEqual(body.cwd, "/repo");
    assert.strictEqual(body.transcript_path, "/tmp/t.jsonl");
    assert.strictEqual(body.permission_mode, "default");
    assert.strictEqual(body.source_pid, 11);
    assert.strictEqual(body.agent_pid, 12);
    assert.strictEqual(body.editor, "code");
    assert.deepStrictEqual(body.pid_chain, [11, 12]);
    assert.strictEqual(typeof body.tool_input_fingerprint, "string");
  });

  it("translateServerResponse maps allow → decision: { behavior: 'allow' }", () => {
    const out = translateServerResponse(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }),
      200
    );
    assert.deepStrictEqual(JSON.parse(out), {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
        },
      },
    });
  });

  it("translateServerResponse maps deny+message → deny+message", () => {
    const out = translateServerResponse(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: "Blocked by user" },
        },
      }),
      200
    );
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "deny");
    assert.strictEqual(parsed.hookSpecificOutput.decision.message, "Blocked by user");
  });

  it("translateServerResponse maps deny w/o message → fallback reason", () => {
    const out = translateServerResponse(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny" },
        },
      }),
      200
    );
    const parsed = JSON.parse(out);
    assert.strictEqual(parsed.hookSpecificOutput.decision.message, "Denied by Clawd bubble");
  });

  it("translateServerResponse: empty decision object → no-decision {}", () => {
    const out = translateServerResponse(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {},
        },
      }),
      200
    );
    assert.strictEqual(out, "{}");
  });

  it("translateServerResponse: HTTP 500 → {}", () => {
    assert.strictEqual(translateServerResponse("internal error", 500), "{}");
  });

  it("translateServerResponse: bad JSON body → {}", () => {
    assert.strictEqual(translateServerResponse("not json", 200), "{}");
  });

  it("getHookTimeoutMs honours env override capped to 59000", () => {
    process.env.CLAWD_PERMISSION_HOOK_TIMEOUT_MS = "10000";
    assert.strictEqual(getHookTimeoutMs(), 10000);
    process.env.CLAWD_PERMISSION_HOOK_TIMEOUT_MS = "999999";
    assert.strictEqual(getHookTimeoutMs(), 59000);
    delete process.env.CLAWD_PERMISSION_HOOK_TIMEOUT_MS;
  });

  it("getDecisionWaitMs reserves ~6s of headroom", () => {
    assert.strictEqual(getDecisionWaitMs(60000), 54000);
    assert.strictEqual(getDecisionWaitMs(7000), 1000);
  });

  it("buildAllowOutput / buildDenyOutput / buildNoDecisionOutput shapes", () => {
    assert.strictEqual(buildNoDecisionOutput(), "{}");
    assert.deepStrictEqual(JSON.parse(buildAllowOutput()).hookSpecificOutput.decision.behavior, "allow");
    assert.deepStrictEqual(JSON.parse(buildDenyOutput("x")).hookSpecificOutput.decision.behavior, "deny");
  });

  it("translateServerResponse forwards updatedPermissions on allow", () => {
    const ups = [
      { type: "addRules", destination: "localSettings", behavior: "allow", rules: [{ toolName: "Bash", ruleContent: "ls *" }] },
    ];
    const allowBody = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: ups },
      },
    });
    const out = JSON.parse(translateServerResponse(allowBody, 200));
    assert.strictEqual(out.hookSpecificOutput.decision.behavior, "allow");
    assert.deepStrictEqual(out.hookSpecificOutput.decision.updatedPermissions, ups);

    const denyBody = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "nope" },
      },
    });
    const denyOut = JSON.parse(translateServerResponse(denyBody, 200));
    assert.strictEqual(denyOut.hookSpecificOutput.decision.behavior, "deny");
    assert.strictEqual(denyOut.hookSpecificOutput.decision.message, "nope");

    // Empty / non-array updatedPermissions must NOT appear in output.
    const allowNoUps = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow", updatedPermissions: [] },
      },
    });
    const noUpsOut = JSON.parse(translateServerResponse(allowNoUps, 200));
    assert.strictEqual("updatedPermissions" in noUpsOut.hookSpecificOutput, false);
  });
});

// ── Spawn-based tests against a stub server ─────────────────────────────────

function startStubServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        handler(req, res, body, requests);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      resolve({ server: srv, port: srv.address().port, requests });
    });
  });
}

function runHook(envExtra, stdinPayload, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_PATH], {
      env: { ...process.env, ...envExtra },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (opts.afterSpawn) opts.afterSpawn(child);
    child.stdin.end(typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload));
  });
}

describe("clawd-permission-hook process behaviour", () => {
  it("probe-fail (no server, FORCE_PORT=none) → stdout {} exit 0", async () => {
    const result = await runHook(
      { CLAWD_PERMISSION_HOOK_FORCE_PORT: "none" },
      {
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        session_id: "s",
      }
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
  });

  it("non-PermissionRequest event → stdout {} exit 0 without contacting server", async () => {
    const result = await runHook(
      { CLAWD_PERMISSION_HOOK_FORCE_PORT: "none" },
      { hook_event_name: "Stop", session_id: "s" }
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
  });

  it("invalid JSON stdin → stdout {} exit 0", async () => {
    const result = await runHook(
      { CLAWD_PERMISSION_HOOK_FORCE_PORT: "none" },
      "this is not json"
    );
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trim(), "{}");
  });

  it("server allow → permissionDecision:allow + body has request_id (uuid v4)", async () => {
    let capturedBody = null;
    const { server, port } = await startStubServer((req, res, body) => {
      capturedBody = body;
      res.writeHead(200, {
        "Content-Type": "application/json",
        [SERVER_HEADER]: SERVER_ID,
      });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        })
      );
    });
    try {
      const result = await runHook(
        { CLAWD_PERMISSION_HOOK_FORCE_PORT: String(port) },
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "ls" },
          session_id: "s",
        }
      );
      assert.strictEqual(result.code, 0);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "allow");
      const reqJson = JSON.parse(capturedBody);
      assert.strictEqual(reqJson.agent_id, "claude-code");
      assert.strictEqual(reqJson.hook_source, "claude-code-wrapper");
      assert.match(
        reqJson.request_id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    } finally {
      server.close();
    }
  });

  it("server deny+message → decision:deny + message verbatim", async () => {
    const { server, port } = await startStubServer((req, res) => {
      res.writeHead(200, { [SERVER_HEADER]: SERVER_ID, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "deny", message: "Blocked by Clawd bubble" },
          },
        })
      );
    });
    try {
      const result = await runHook(
        { CLAWD_PERMISSION_HOOK_FORCE_PORT: String(port) },
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: {},
          session_id: "s",
        }
      );
      assert.strictEqual(result.code, 0);
      const parsed = JSON.parse(result.stdout.trim());
      assert.strictEqual(parsed.hookSpecificOutput.decision.behavior, "deny");
      assert.strictEqual(parsed.hookSpecificOutput.decision.message, "Blocked by Clawd bubble");
    } finally {
      server.close();
    }
  });

  it("server returns no-decision (empty decision object) → stdout {}", async () => {
    const { server, port } = await startStubServer((req, res) => {
      res.writeHead(200, { [SERVER_HEADER]: SERVER_ID, "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: {},
          },
        })
      );
    });
    try {
      const result = await runHook(
        { CLAWD_PERMISSION_HOOK_FORCE_PORT: String(port) },
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: {},
          session_id: "s",
        }
      );
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout.trim(), "{}");
    } finally {
      server.close();
    }
  });

  it("server 500 → stdout {} exit 0", async () => {
    const { server, port } = await startStubServer((req, res) => {
      res.writeHead(500, { [SERVER_HEADER]: SERVER_ID });
      res.end("internal error");
    });
    try {
      const result = await runHook(
        { CLAWD_PERMISSION_HOOK_FORCE_PORT: String(port) },
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: {},
          session_id: "s",
        }
      );
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout.trim(), "{}");
    } finally {
      server.close();
    }
  });

  it("decision-wait timeout → stdout {} exit 0", async () => {
    // Server holds connection open; wrapper times out via small budget.
    const { server, port } = await startStubServer((req, res) => {
      // Never respond.
    });
    try {
      const result = await runHook(
        {
          CLAWD_PERMISSION_HOOK_FORCE_PORT: String(port),
          // 7s total → decision_wait = max(1000, 7000-6000) = 1000ms
          CLAWD_PERMISSION_HOOK_TIMEOUT_MS: "7000",
        },
        {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: {},
          session_id: "s",
        }
      );
      assert.strictEqual(result.code, 0);
      assert.strictEqual(result.stdout.trim(), "{}");
    } finally {
      // force destroy any open sockets
      server.closeAllConnections && server.closeAllConnections();
      server.close();
    }
  });

  it("SIGTERM mid-flight → DELETE /permission/<id> issued, exit 0, no stdout", async () => {
    let deleteSeen = null;
    let postReceived = false;
    const { server, port, requests } = await startStubServer((req, res, body) => {
      if (req.method === "POST") {
        postReceived = true;
        // Hold the response forever so SIGTERM happens mid-flight.
        return;
      }
      if (req.method === "DELETE") {
        deleteSeen = req.url;
        res.writeHead(204, { [SERVER_HEADER]: SERVER_ID });
        res.end();
      }
    });
    try {
      const child = spawn(process.execPath, [HOOK_PATH], {
        env: { ...process.env, CLAWD_PERMISSION_HOOK_FORCE_PORT: String(port) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.stdin.end(
        JSON.stringify({
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: {},
          session_id: "s",
        })
      );

      // Wait for POST to land, then SIGTERM.
      const start = Date.now();
      while (!postReceived && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(postReceived, "expected POST to land before SIGTERM");

      const exitCode = await new Promise((resolve) => {
        child.on("close", (code) => resolve(code));
        child.kill("SIGTERM");
      });

      // Allow the DELETE to land.
      const deadline = Date.now() + 1500;
      while (!deleteSeen && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      assert.strictEqual(exitCode, 0);
      assert.strictEqual(stdout, "", "expected no stdout on SIGTERM-driven exit");
      assert.ok(deleteSeen && deleteSeen.startsWith("/permission/"), `expected DELETE on /permission/<id>, got ${deleteSeen}`);
    } finally {
      server.closeAllConnections && server.closeAllConnections();
      server.close();
    }
  });
});
