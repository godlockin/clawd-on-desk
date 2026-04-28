#!/usr/bin/env node
// Clawd — Claude Code PermissionRequest command-hook wrapper.
// Registered in ~/.claude/settings.json by hooks/install.js (CARD-05).
// See docs/project/adr-permission-command-wrapper.md.
//
// Lifecycle:
//   1. Read stdin JSON (CC PermissionRequest payload).
//   2. Probe Clawd server port; if missing, emit "{}" → CC native prompt.
//   3. POST /permission with request_id (uuid v4); long-poll for decision.
//   4. Translate server { decision:{behavior,message} } into CC's
//      { permissionDecision, permissionDecisionReason } stdout schema.
//   5. On any failure, emit "{}" and exit 0 (NEVER fail-closed).
//   6. On SIGTERM / SIGINT (CC parent died), best-effort DELETE the
//      bubble entry, then exit 0 with no stdout.
//
// Sandbox: Node built-ins + same-dir hooks/* only (AGENTS.md L112).

"use strict";

const crypto = require("crypto");
const http = require("http");
const {
  PERMISSION_PATH,
  discoverClawdPort,
  postPermissionToPort,
  readHostPrefix,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJson,
  getPlatformConfig,
} = require("./shared-process");
const { buildToolInputFingerprint } = require("./clawd-hook");

// ── Constants (see ADR §6) ──────────────────────────────────────────────────
const HOOK_TIMEOUT_CAP_MS = 59000;     // CC kills at 60s; reserve 1s safety
const HOOK_TIMEOUT_DEFAULT_MS = 59000; // default same as cap
const RESERVED_BUDGET_MS = 6000;       // probe(50ms) + connect(5s) + flush margin
const PROBE_TIMEOUT_MS = 50;
const DELETE_TIMEOUT_MS = 500;
const DENY_REASON_MAX = 1024;
const HOOK_SOURCE = "claude-code-wrapper";

function getHookTimeoutMs() {
  const raw = Number(process.env.CLAWD_PERMISSION_HOOK_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, HOOK_TIMEOUT_CAP_MS);
  return HOOK_TIMEOUT_DEFAULT_MS;
}

function getDecisionWaitMs(totalMs) {
  return Math.max(1000, totalMs - RESERVED_BUDGET_MS);
}

function normalizeToolUseId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function buildPermissionBody(payload, resolve, requestId) {
  const event =
    payload && typeof payload.hook_event_name === "string"
      ? payload.hook_event_name
      : "";
  if (event !== "PermissionRequest") return null;

  const rawInput =
    payload.tool_input && typeof payload.tool_input === "object"
      ? payload.tool_input
      : {};
  const toolName =
    typeof payload.tool_name === "string" && payload.tool_name
      ? payload.tool_name
      : "Unknown";
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : "default";

  const body = {
    agent_id: "claude-code",
    hook_source: HOOK_SOURCE,
    request_id: requestId,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: rawInput,
  };

  const toolUseId = normalizeToolUseId(
    payload.tool_use_id ?? payload.toolUseId ?? payload.toolUseID
  );
  if (toolUseId) body.tool_use_id = toolUseId;
  const fp = buildToolInputFingerprint(rawInput);
  if (fp) body.tool_input_fingerprint = fp;

  if (typeof payload.cwd === "string" && payload.cwd) body.cwd = payload.cwd;
  if (typeof payload.transcript_path === "string" && payload.transcript_path) {
    body.transcript_path = payload.transcript_path;
  }
  if (typeof payload.permission_mode === "string" && payload.permission_mode) {
    body.permission_mode = payload.permission_mode;
  }
  if (Array.isArray(payload.permission_suggestions) && payload.permission_suggestions.length) {
    body.permission_suggestions = payload.permission_suggestions;
  }

  if (process.env.CLAWD_REMOTE) {
    body.host = readHostPrefix();
  } else if (typeof resolve === "function") {
    try {
      const { stablePid, agentPid, detectedEditor, pidChain } = resolve();
      if (stablePid) body.source_pid = stablePid;
      if (detectedEditor) body.editor = detectedEditor;
      if (agentPid) body.agent_pid = agentPid;
      if (pidChain && pidChain.length) body.pid_chain = pidChain;
    } catch {}
  }

  return body;
}

// ── Output builders (CC stdout schema) ──────────────────────────────────────
function buildNoDecisionOutput() {
  return "{}";
}

function sanitizeUpdatedPermissions(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  // Pass through as-is; server already shaped it (src/permission.js:642).
  // CC's PermissionRequest stdout schema accepts updatedPermissions at
  // hookSpecificOutput level, same as the prior direct-HTTP response path.
  return value;
}

function buildAllowOutput(message, updatedPermissions) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      permissionDecision: "allow",
    },
  };
  if (typeof message === "string" && message) {
    out.hookSpecificOutput.permissionDecisionReason = message.slice(0, DENY_REASON_MAX);
  }
  const ups = sanitizeUpdatedPermissions(updatedPermissions);
  if (ups) out.hookSpecificOutput.updatedPermissions = ups;
  return JSON.stringify(out);
}

function buildDenyOutput(message, updatedPermissions) {
  let reason =
    typeof message === "string" && message ? message : "Denied by Clawd bubble";
  if (reason.length > DENY_REASON_MAX) reason = reason.slice(0, DENY_REASON_MAX);
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
  const ups = sanitizeUpdatedPermissions(updatedPermissions);
  if (ups) out.hookSpecificOutput.updatedPermissions = ups;
  return JSON.stringify(out);
}

function buildAskOutput(message, updatedPermissions) {
  const out = {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      permissionDecision: "ask",
    },
  };
  if (typeof message === "string" && message) {
    out.hookSpecificOutput.permissionDecisionReason = message.slice(0, DENY_REASON_MAX);
  }
  const ups = sanitizeUpdatedPermissions(updatedPermissions);
  if (ups) out.hookSpecificOutput.updatedPermissions = ups;
  return JSON.stringify(out);
}

// Translate server response (sendPermissionResponse, src/permission.js:718-735)
// → CC stdout schema (permissionDecision / permissionDecisionReason).
function translateServerResponse(rawBody, statusCode) {
  if (typeof statusCode === "number" && (statusCode < 200 || statusCode >= 300)) {
    return buildNoDecisionOutput();
  }
  if (typeof rawBody !== "string" || !rawBody.trim()) return buildNoDecisionOutput();
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return buildNoDecisionOutput();
  }
  const decision =
    parsed &&
    parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.hookEventName === "PermissionRequest"
      ? parsed.hookSpecificOutput.decision
      : null;
  if (!decision || typeof decision !== "object") return buildNoDecisionOutput();
  const ups = decision.updatedPermissions;
  if (decision.behavior === "allow") return buildAllowOutput(decision.message, ups);
  if (decision.behavior === "deny") return buildDenyOutput(decision.message, ups);
  if (decision.behavior === "ask") return buildAskOutput(decision.message, ups);
  return buildNoDecisionOutput();
}

// Best-effort DELETE /permission/<requestId> for bubble withdrawal.
// CARD-04 will implement the route; this is fire-and-forget either way.
function sendDeleteRequest(port, requestId, callback) {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    try { callback(); } catch {}
  };
  if (!port || !requestId) {
    finish();
    return;
  }
  try {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `${PERMISSION_PATH}/${encodeURIComponent(requestId)}`,
        method: "DELETE",
        timeout: DELETE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        res.on("end", finish);
        res.on("close", finish);
      }
    );
    req.on("error", finish);
    req.on("timeout", () => {
      try { req.destroy(); } catch {}
      finish();
    });
    req.end();
  } catch {
    finish();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
let stdoutWritten = false;
function writeStdoutAndExit(output) {
  if (stdoutWritten) {
    process.exit(0);
    return;
  }
  stdoutWritten = true;
  try {
    process.stdout.write(`${output}\n`, () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

function exitSilently() {
  // No stdout at all (parent CC is gone, decisions are meaningless).
  process.exit(0);
}

function main() {
  const totalMs = getHookTimeoutMs();
  const decisionWaitMs = getDecisionWaitMs(totalMs);
  const requestId = crypto.randomUUID();

  let resolvedPort = null;
  let finished = false;
  let parentGone = false;

  const platformConfig = getPlatformConfig();
  const resolve = createPidResolver({
    agentNames: {
      win: new Set(["claude.exe"]),
      mac: new Set(["claude"]),
      linux: new Set(["claude"]),
    },
    agentCmdlineCheck: (cmd) =>
      cmd.includes("claude-code") || cmd.includes("@anthropic-ai"),
    platformConfig,
  });

  // Overall safety timer — well under CC's 60s ceiling.
  const overallTimer = setTimeout(() => {
    if (finished) return;
    finished = true;
    if (resolvedPort) {
      sendDeleteRequest(resolvedPort, requestId, () =>
        writeStdoutAndExit(buildNoDecisionOutput())
      );
    } else {
      writeStdoutAndExit(buildNoDecisionOutput());
    }
  }, totalMs);
  if (typeof overallTimer.unref === "function") overallTimer.unref();

  const onParentGone = () => {
    if (finished) return;
    finished = true;
    parentGone = true;
    try { clearTimeout(overallTimer); } catch {}
    if (resolvedPort) {
      sendDeleteRequest(resolvedPort, requestId, exitSilently);
    } else {
      exitSilently();
    }
  };
  process.on("SIGTERM", onParentGone);
  process.on("SIGINT", onParentGone);

  const finishWithOutput = (output) => {
    if (finished) return;
    finished = true;
    try { clearTimeout(overallTimer); } catch {}
    writeStdoutAndExit(output);
  };

  readStdinJson()
    .then((payload) => {
      if (parentGone) return;
      const body = buildPermissionBody(payload || {}, resolve, requestId);
      if (!body) {
        finishWithOutput(buildNoDecisionOutput());
        return;
      }

      // Optional test-only escape hatch — bypasses port discovery so unit
      // tests can target an ephemeral stub server. Production paths never
      // set this env var.
      const forcePortRaw = process.env.CLAWD_PERMISSION_HOOK_FORCE_PORT;
      const forcePort = Number(forcePortRaw);
      const probe = (cb) => {
        if (forcePortRaw === "none") {
          cb(null);
          return;
        }
        if (Number.isFinite(forcePort) && forcePort > 0) {
          cb(forcePort);
          return;
        }
        discoverClawdPort({ timeoutMs: PROBE_TIMEOUT_MS }, cb);
      };

      probe((port) => {
        if (parentGone || finished) return;
        if (!port) {
          finishWithOutput(buildNoDecisionOutput());
          return;
        }
        resolvedPort = port;

        const payloadStr = JSON.stringify(body);
        postPermissionToPort(
          port,
          payloadStr,
          decisionWaitMs,
          (ok, _confirmedPort, responseBody, statusCode) => {
            if (parentGone || finished) return;
            if (!ok) {
              // Connect refused / timeout / RST mid-response → no decision.
              finishWithOutput(buildNoDecisionOutput());
              return;
            }
            const output = translateServerResponse(responseBody, statusCode);
            finishWithOutput(output);
          }
        );
      });
    })
    .catch(() => {
      finishWithOutput(buildNoDecisionOutput());
    });
}

if (require.main === module) {
  try {
    main();
  } catch {
    // Top-level defense: never fail-closed, never throw.
    try {
      process.stdout.write(`${buildNoDecisionOutput()}\n`, () => process.exit(0));
    } catch {
      process.exit(0);
    }
  }
}

// Surface internals for unit tests.
module.exports = {
  buildAllowOutput,
  buildAskOutput,
  buildDenyOutput,
  buildNoDecisionOutput,
  buildPermissionBody,
  getDecisionWaitMs,
  getHookTimeoutMs,
  normalizeToolUseId,
  sendDeleteRequest,
  translateServerResponse,
};
