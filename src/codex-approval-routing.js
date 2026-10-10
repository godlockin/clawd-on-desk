"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HEAD_LIMIT = 256 * 1024;
const TAIL_LIMIT = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HUMAN_TOOLS = new Set(["Bash", "apply_patch"]);
const delegate = (reason) => ({ owner: "codex", reason });

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith(".." + path.sep)
    && relative !== ".." && !path.isAbsolute(relative);
}
function readHead(fd, size) {
  const chunks = [];
  let offset = 0;
  while (offset < Math.min(size, HEAD_LIMIT)) {
    const buffer = Buffer.alloc(Math.min(8192, size - offset, HEAD_LIMIT - offset));
    const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
    if (!count) return null;
    const newline = buffer.subarray(0, count).indexOf(10);
    if (newline !== -1) {
      chunks.push(buffer.subarray(0, newline));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    chunks.push(buffer.subarray(0, count));
    offset += count;
  }
  return null;
}

// The transcript is advisory evidence for shell/file approval only. MCP and
// app invocations can override the turn's reviewer; they always stay native.
// Unknown evidence delegates without deciding, so detection cannot grant access.
function resolveCodexApprovalRoute(data = {}, options = {}) {
  if (!HUMAN_TOOLS.has(data.tool_name)) return delegate("request-reviewer-unavailable");
  if (data.host || data.wsl_distro || data.wsl_sourced === true) return delegate("nonlocal");
  if (data.permission_mode !== "default") return delegate("noninteractive-or-unknown-mode");
  const session = typeof data.session_id === "string"
    ? data.session_id.replace(/^codex:/, "") : "";
  if (!UUID.test(session) || typeof data.turn_id !== "string"
    || !data.turn_id || data.turn_id.length > 128) return delegate("missing-identity");
  if (typeof data.transcript_path !== "string" || !path.isAbsolute(data.transcript_path)) {
    return delegate("missing-transcript");
  }
  let fd;
  try {
    const configuredHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
    if (!path.isAbsolute(configuredHome)) return delegate("nonabsolute-codex-home");
    const home = fs.realpathSync(configuredHome);
    const file = fs.realpathSync(data.transcript_path);
    if (!inside(path.join(home, "sessions"), file)
      && !inside(path.join(home, "archived_sessions"), file)) return delegate("foreign-transcript");
    fd = fs.openSync(file, "r");
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return delegate("not-a-file");
    const head = readHead(fd, before.size);
    const metaId = head && head.type === "session_meta" && head.payload
      ? (head.payload.session_id || head.payload.id) : null;
    if (typeof metaId !== "string" || metaId.toLowerCase() !== session.toLowerCase()) {
      return delegate("session-mismatch");
    }
    const budget = Math.max(1, Math.min(TAIL_LIMIT, options.maxTailBytes || TAIL_LIMIT));
    const length = Math.min(before.size, budget);
    const start = before.size - length;
    const buffer = Buffer.alloc(length);
    if (fs.readSync(fd, buffer, 0, length, start) !== length) return delegate("incomplete-read");
    // Ignore only the first cut record. A partial final record could be a
    // settings change, so it invalidates rather than reuses older evidence.
    if (!length || buffer[length - 1] !== 10) return delegate("partial-record");
    const offset = start ? buffer.indexOf(10) + 1 : 0;
    if (start && offset === 0) return delegate("no-complete-record");
    let context = null;
    for (const line of buffer.subarray(offset).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      const payload = record.payload;
      if (!payload || typeof payload !== "object") continue;
      if (record.type === "turn_context") {
        context = payload.turn_id === data.turn_id ? payload : null;
      } else if (context && record.type === "event_msg"
        && (payload.type === "thread_settings_applied"
          || payload.type === "task_complete" || payload.type === "turn_aborted"
          || (payload.type === "task_started" && payload.turn_id !== data.turn_id))) {
        context = null;
      }
    }
    const after = fs.fstatSync(fd);
    const current = fs.statSync(file);
    if (before.dev !== current.dev || before.ino !== current.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || after.size !== current.size || after.mtimeMs !== current.mtimeMs) {
      return delegate("transcript-changed");
    }
    if (!context || context.approvals_reviewer !== "user"
      || !["on-request", "untrusted", "on-failure"].includes(context.approval_policy)) {
      return delegate("automatic-or-unknown-reviewer");
    }
    return { owner: "clawd", reason: "current-human-reviewer" };
  } catch {
    return delegate("unreadable-transcript");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { resolveCodexApprovalRoute };
