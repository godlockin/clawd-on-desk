#!/usr/bin/env node
// Clawd — MiniMax Code hook (stdin JSON with hook_event_name; stdout JSON for gating hooks)
// Deployed as the local plugin ~/.minimax/plugins/clawd-state/ by hooks/minimax-install.js
// MiniMax Code parses plugin hook documents in the Claude Code-compatible format
// (sourceFormat CLAUDE) and feeds hooks a snake_case Claude-compatible stdin payload.

const {
  postStateToRunningServer,
  readHostPrefix,
  applyWslSourceFields,
} = require("./server-config");
const {
  createPidResolver,
  readStdinJson,
  getPlatformConfig,
  applyOrcaPaneKey,
} = require("./shared-process");

// MiniMax hook event → { state, event } for the Clawd state machine.
// PermissionRequest is deliberately not registered (see agents/minimax.js):
// the plugin-hook runner's 1–10s timeout budget makes blocking approval
// impossible, so MiniMax keeps its native permission flow.
const HOOK_MAP = {
  SessionStart:     { state: "idle",      event: "SessionStart" },
  SessionEnd:       { state: "sleeping",  event: "SessionEnd" },
  UserPromptSubmit: { state: "thinking",  event: "UserPromptSubmit" },
  PreToolUse:       { state: "working",   event: "PreToolUse" },
  PostToolUse:      { state: "working",   event: "PostToolUse" },
  Stop:             { state: "attention", event: "Stop" },
  SubagentStart:    { state: "juggling",  event: "SubagentStart" },
  SubagentStop:     { state: "working",   event: "SubagentStop" },
  PreCompact:       { state: "sweeping",  event: "PreCompact" },
  PostCompact:      { state: "attention", event: "PostCompact" },
};

// Lifecycle for the shared resolver's cross-process pid cache. Stop is
// deliberately NOT "end" (turn completion, not session end — dropping the
// cache there would force a fresh snapshot flash on the next tool event).
const EVENT_TO_LIFECYCLE = {
  SessionStart: "start",
  UserPromptSubmit: "prompt",
  SessionEnd: "end",
};

// Session title handling — MiniMax's documented hook input carries session_id,
// cwd, model and prompt metadata but no session title field. The HUD title is
// derived from the first line of the user's prompt, mirroring the traecode
// hook's extractPromptTitle. The server keeps the first successful title per
// minimax session (state.js first-wins), so follow-up prompts never overwrite it.
const SESSION_TITLE_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]+/g;
const SESSION_TITLE_MAX = 80;
const PROMPT_TITLE_MAX = 40;
const PROMPT_TITLE_SECRET_RE =
  /\b(api[_-]?key|authorization|bearer|password|passwd|private[_-]?key|secret|token)\b|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9+/=_-]{32,}/i;

function normalizeTitle(value) {
  if (typeof value !== "string") return null;
  const collapsed = value
    .replace(SESSION_TITLE_CONTROL_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return null;
  return collapsed.length > SESSION_TITLE_MAX
    ? `${collapsed.slice(0, SESSION_TITLE_MAX - 1)}…`
    : collapsed;
}

function normalizeTitleWithMax(value, maxLen) {
  const title = normalizeTitle(value);
  if (!title || title.length <= maxLen) return title;
  return `${title.slice(0, maxLen - 1)}…`;
}

function looksSecretishPromptTitle(value) {
  return typeof value === "string" && PROMPT_TITLE_SECRET_RE.test(value);
}

function extractPromptTitle(prompt) {
  if (typeof prompt !== "string") return null;
  for (const line of prompt.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) continue;
    if (looksSecretishPromptTitle(candidate)) return null;
    return normalizeTitleWithMax(candidate, PROMPT_TITLE_MAX);
  }
  return null;
}

function resolveSessionTitle(payload, event) {
  if (!payload || typeof payload !== "object") return null;
  const sessionTitle = normalizeTitle(payload.session_title);
  if (sessionTitle) return sessionTitle;
  if (event === "UserPromptSubmit") {
    return extractPromptTitle(payload.prompt);
  }
  return null;
}

const config = getPlatformConfig({});
const resolve = createPidResolver({
  agentNames: {
    win: new Set(["MiniMax Code.exe", "MiniMax Code Helper.exe", "mcode.exe"]),
    mac: new Set(["MiniMax Code", "MiniMax Code Helper", "mcode"]),
    linux: new Set(["mcode", "MiniMax Code"]),
  },
  platformConfig: config,
});

// This integration is state-only and does not own permission decisions, so
// every event emits {} — for MiniMax's wire contract an empty output means
// permissionDecision defaults to abstain and the native flow proceeds.

// Safety timeout: guarantee valid JSON on stdout even if stdin never arrives
// or the process tree walk hangs. Without this MiniMax would see empty stdout,
// which is invalid JSON and logs an error on every hook invocation.
const SAFETY_TIMEOUT_MS = 800;

// Everything that runs the real hook lifecycle — reading stdin, arming the
// safety timer, answering MiniMax on stdout, the fire-and-forget POST to
// Clawd, and process exit — lives inside main(), which only runs when this
// file is the entry point. Importing the module for tests must not read stdin,
// arm timers, write stdout, or exit.
function main(deps = {}) {
  const readStdin = deps.readStdinJson || readStdinJson;
  const postState = deps.postState || postStateToRunningServer;
  let _wrote = false;
  let _exited = false;
  let safetyTimer = null;

  // Write the stdout response exactly once. Kept separate from process exit so
  // the hook can answer MiniMax immediately yet still let the fire-and-forget
  // POST to Clawd leave the process before it exits. Exit in the write callback
  // so a pipe-backed stdout actually flushes before the process terminates.
  function writeStdoutOnce(outLine, done) {
    if (_wrote) {
      if (done) done();
      return;
    }
    _wrote = true;
    process.stdout.write(outLine + "\n", () => {
      if (done) done();
    });
  }

  function finish(outLine) {
    if (_exited) return;
    _exited = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    writeStdoutOnce(outLine, () => process.exit(0));
  }

  // MiniMax session ids are namespaced with the agent prefix so they cannot
  // collide with other agents' sessions. A bare missing id must not collapse
  // every hook invocation into one phantom "default" session — drop the event
  // when it is absent, because a hook without a session cannot be attributed.
  function normalizeSessionId(value) {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw || raw === "default") return "";
    return `minimax:${raw}`;
  }

  safetyTimer = setTimeout(() => finish("{}"), SAFETY_TIMEOUT_MS);

  readStdin()
    .then((payload) => {
      const hookName = (payload && payload.hook_event_name) || "";
      const mapped = HOOK_MAP[hookName];
      const outLine = "{}";

      if (!mapped) {
        finish(outLine);
        return;
      }

      const { state, event } = mapped;
      const remote = !!process.env.CLAWD_REMOTE;
      if (hookName === "SessionStart" && !remote) resolve();

      const sessionId = normalizeSessionId(payload && payload.session_id);
      const cwd = (payload && typeof payload.cwd === "string") ? payload.cwd : "";
      // No session id means the event cannot be attributed to any session —
      // answer MiniMax immediately and skip the POST rather than collapsing
      // into a phantom "default" session on the server.
      if (!sessionId) {
        finish(outLine);
        return;
      }

      const pidMetadata = resolve({
        namespace: "minimax",
        sessionId,
        cacheCwd: cwd,
        lifecycle: EVENT_TO_LIFECYCLE[hookName] || "event",
        cacheable: !!cwd,
      });
      const { stablePid, agentPid, detectedEditor, pidChain, tmuxSocket, tmuxClient } = pidMetadata;

      const body = { state, session_id: sessionId, event };
      body.agent_id = "minimax";
      if (cwd) body.cwd = cwd;
      const resolvedTitle = resolveSessionTitle(payload, event);
      if (resolvedTitle) body.session_title = resolvedTitle;
      if (remote) {
        body.host = readHostPrefix();
        applyWslSourceFields(body, { remote: true });
        applyOrcaPaneKey(body);
      } else {
        applyWslSourceFields(body);
        body.source_pid = stablePid;
        if (detectedEditor) body.editor = detectedEditor;
        if (agentPid) body.agent_pid = agentPid;
        if (Array.isArray(pidChain) && pidChain.length) body.pid_chain = pidChain;
        if (tmuxSocket) body.tmux_socket = tmuxSocket;
        if (tmuxClient) body.tmux_client = tmuxClient;
        applyOrcaPaneKey(body);
      }

      // Answer MiniMax immediately so it never sees empty stdout, but don't
      // exit yet — the fire-and-forget POST below still needs to leave the
      // process, so we exit in its callback (with the safety timer as backstop).
      writeStdoutOnce(outLine);

      postState(JSON.stringify(body), { timeoutMs: 100 }, () => {
        finish(outLine);
      });
    })
    .catch(() => finish("{}"));
}

if (require.main === module) {
  main();
}

module.exports = {
  __test: {
    resolveSessionTitle,
    extractPromptTitle,
    normalizeTitle,
    main,
  },
};
