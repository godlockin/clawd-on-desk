"use strict";

// CARD-04: tests for the command-wrapper-aware /permission default branch
// and the DELETE /permission/:id route.

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const initServer = require("../src/server");

function makeFakeHttp() {
  let capturedHandler = null;
  function createHttpServer(handler) {
    capturedHandler = handler;
    const server = new EventEmitter();
    server.listen = function () { this.emit("listening"); };
    server.close = function () {};
    return server;
  }
  return { createHttpServer, getHandler: () => capturedHandler };
}

function makeReq(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  setImmediate(() => {
    if (body != null) req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
    req.emit("end");
  });
  return req;
}

function makeRes(resolveOnEnd) {
  const res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = "";
  res.writableEnded = false;
  res.writableFinished = false;
  res.destroyed = false;
  res.headersSent = false;
  res.writeHead = function (code, headers) {
    this.statusCode = code;
    this.headers = headers || {};
    this.headersSent = true;
  };
  res.end = function (data) {
    if (data) this.body += String(data);
    this.writableEnded = true;
    this.writableFinished = true;
    if (resolveOnEnd) resolveOnEnd(this);
  };
  res.destroy = function () {
    this.destroyed = true;
    this.emit("close");
  };
  return res;
}

function startServer(overrides = {}) {
  const http = makeFakeHttp();
  const pendingPermissions = [];
  const resolved = [];
  const shown = [];
  const ctx = {
    createHttpServer: http.createHttpServer,
    setImmediate: () => {},
    getPortCandidates: () => [23333],
    writeRuntimeConfig: () => true,
    clearRuntimeConfig: () => true,
    readRuntimePort: () => null,
    syncClawdHooksImpl: () => {},
    syncGeminiHooksImpl: () => {},
    syncCursorHooksImpl: () => {},
    syncCodeBuddyHooksImpl: () => {},
    syncKiroHooksImpl: () => {},
    syncCodexHooksImpl: () => {},
    syncOpencodePluginImpl: () => {},
    PASSTHROUGH_TOOLS: new Set(),
    pendingPermissions,
    sessions: new Map(),
    doNotDisturb: false,
    hideBubbles: false,
    getBubblePolicy: () => ({ enabled: true, autoCloseMs: null }),
    isAgentEnabled: () => true,
    isAgentPermissionsEnabled: () => true,
    updateSession: () => {},
    showPermissionBubble: (entry) => shown.push(entry),
    resolvePermissionEntry: (entry, behavior, message) => {
      const idx = pendingPermissions.indexOf(entry);
      if (idx !== -1) pendingPermissions.splice(idx, 1);
      if (entry.ttlTimer) clearTimeout(entry.ttlTimer);
      resolved.push({ entry, behavior, message });
    },
    sendPermissionResponse: (res, behavior, message) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior, message } } }));
    },
    permLog: () => {},
    updateLog: () => {},
    ...overrides,
  };
  const api = initServer(ctx);
  api.startHttpServer();
  return { handler: http.getHandler(), pendingPermissions, resolved, shown };
}

function postPermission(handler, body) {
  const req = makeReq("POST", "/permission", body);
  const res = makeRes();
  handler(req, res);
  return new Promise((resolve) => setImmediate(() => resolve(res)));
}

function deletePermission(handler, id) {
  return new Promise((resolve) => {
    const req = makeReq("DELETE", `/permission/${id}`);
    const res = makeRes(resolve);
    handler(req, res);
  });
}

describe("CARD-04: /permission wrapper request_id ingestion", () => {
  it("stamps requestId + viaCommandWrapper when body has request_id", async () => {
    const { handler, pendingPermissions } = startServer();
    await postPermission(handler, {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      request_id: "11111111-2222-3333-4444-555555555555",
    });
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(pendingPermissions[0].requestId, "11111111-2222-3333-4444-555555555555");
    assert.strictEqual(pendingPermissions[0].viaCommandWrapper, true);
  });

  it("synthesises a requestId when body omits one (legacy)", async () => {
    const { handler, pendingPermissions } = startServer();
    await postPermission(handler, {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    assert.strictEqual(pendingPermissions.length, 1);
    assert.match(pendingPermissions[0].requestId, /^[0-9a-f-]{36}$/);
    assert.strictEqual(pendingPermissions[0].viaCommandWrapper, false);
  });
});

describe("CARD-04: DELETE /permission/:id", () => {
  it("removes pending wrapper entry, resolves no-decision, returns 204", async () => {
    const { handler, pendingPermissions, resolved } = startServer();
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    await postPermission(handler, {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      request_id: id,
    });
    assert.strictEqual(pendingPermissions.length, 1);

    const delRes = await deletePermission(handler, id);
    assert.strictEqual(delRes.statusCode, 204);
    assert.strictEqual(pendingPermissions.length, 0);
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].behavior, "no-decision");
  });

  it("DELETE on unknown id is idempotent (204, no resolve)", async () => {
    const { handler, resolved } = startServer();
    const delRes = await deletePermission(handler, "deadbeef-0000-0000-0000-000000000000");
    assert.strictEqual(delRes.statusCode, 204);
    assert.strictEqual(resolved.length, 0);
  });
});

describe("CARD-04: res.on('close') semantics", () => {
  it("wrapper entry → no-decision on socket close", async () => {
    const { handler, pendingPermissions, resolved } = startServer();
    const req = makeReq("POST", "/permission", {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      request_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    });
    const res = makeRes();
    handler(req, res);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pendingPermissions.length, 1);

    // Simulate wrapper TCP close (parent CC SIGTERM'd).
    res.emit("close");
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].behavior, "no-decision");
  });

  it("legacy entry (no request_id) → no-decision on socket close", async () => {
    const { handler, pendingPermissions, resolved } = startServer();
    const req = makeReq("POST", "/permission", {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const res = makeRes();
    handler(req, res);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pendingPermissions.length, 1);

    res.emit("close");
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].behavior, "no-decision");
    assert.strictEqual(resolved[0].message, "Client disconnected");
  });
});

describe("CARD-04: idempotency on duplicate request_id POST", () => {
  it("second POST with same id returns 409 and does NOT create a second entry", async () => {
    const { handler, pendingPermissions, shown } = startServer();
    const id = "12121212-3434-5656-7878-909090909090";
    await postPermission(handler, {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      request_id: id,
    });
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);

    const dupRes = await postPermission(handler, {
      agent_id: "claude-code",
      session_id: "s1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      request_id: id,
    });
    assert.strictEqual(dupRes.statusCode, 409);
    assert.strictEqual(pendingPermissions.length, 1);
    assert.strictEqual(shown.length, 1);
  });
});

describe("CARD-04: TTL cleanup", () => {
  it("schedules a 65s timer and cleans up if still pending on fire", async () => {
    // We monkey-patch global setTimeout to capture the timer + invoke it
    // synchronously; node's fake-timers aren't available without extra deps.
    const captured = [];
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms) {
      const t = realSetTimeout(() => {}, 0);
      captured.push({ fn, ms });
      // Return an unref-able placeholder
      return { unref: () => {}, _real: t };
    };
    try {
      const { handler, pendingPermissions, resolved } = startServer();
      await postPermission(handler, {
        agent_id: "claude-code",
        session_id: "s1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        request_id: "abcdabcd-abcd-abcd-abcd-abcdabcdabcd",
      });
      assert.strictEqual(pendingPermissions.length, 1);
      const ttl = captured.find((c) => c.ms === 65000);
      assert.ok(ttl, "expected a 65000ms timer to be scheduled");

      // Fire it manually.
      ttl.fn();
      assert.strictEqual(pendingPermissions.length, 0);
      assert.strictEqual(resolved.length, 1);
      assert.strictEqual(resolved[0].behavior, "no-decision");
    } finally {
      global.setTimeout = realSetTimeout;
    }
  });
});
