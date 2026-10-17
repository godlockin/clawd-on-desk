"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { readWorkBuddyDatabaseSession, createWorkBuddySessionTitleTracker } = require("../src/workbuddy-session-title");
const createAgentRuntimeMain = require("../src/agent-runtime-main");
const initState = require("../src/state");
const themeLoader = require("../src/theme-loader");
let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch {}
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-workbuddy-context-"));
  try { await run(home); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function createDatabase(dir, { usage = true, legacy = false, title = "Native title" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, custom_title TEXT, cwd TEXT, deleted_at INTEGER"
    + (legacy ? "" : ", status TEXT") + ")");
  db.prepare("INSERT INTO sessions VALUES (?, ?, NULL, ?, NULL" + (legacy ? "" : ", 'Pending'") + ")")
    .run("s1", title, "/project");
  if (usage) {
    // No affinity on counters lets fixtures exercise malformed native values.
    db.exec("CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used, size, updated_at INTEGER, credit_json TEXT)");
    db.prepare("INSERT INTO session_usage VALUES (?, ?, ?, ?, ?)").run("s1", 250, 1000, 1, "must not be queried");
  }
  db.close();
}

function writeDatabase(dir, sql, ...args) {
  const db = new DatabaseSync(path.join(dir, "workbuddy.db"));
  try { db.prepare(sql).run(...args); }
  finally { db.close(); }
}

function input(dir, extra = {}) {
  return { rawSessionId: "s1", cwd: "/project", transcriptPath: path.join(dir, "projects", "p", "s1.jsonl"), ...extra };
}

function read(dir, extra = {}, options = {}) {
  return readWorkBuddyDatabaseSession(input(dir, extra), { dataDirs: [dir], ...options });
}

function makeRuntime(dir, extra = {}) {
  themeLoader.init(path.join(__dirname, "..", "src"));
  const sounds = [];
  const state = initState({ theme: themeLoader.loadTheme("clawd"), lang: "en", pendingPermissions: [],
    playSound: (sound) => sounds.push(sound), sendToRenderer() {}, syncHitWin() {}, sendToHitWin() {},
    buildContextMenu() {}, buildTrayMenu() {}, getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    mouseStillSince: Date.now(), getSessionAliases: () => ({}) });
  const runtime = createAgentRuntimeMain({ updateSession: state.updateSession, getStateRuntime: () => state,
    workBuddySessionTitleOptions: { dataDirs: [dir], pollMs: 20 }, ...extra });
  return { state, runtime, sounds };
}

function submit(runtime, dir, id = "s1", extra = {}) {
  return runtime.updateSessionFromServer(id, "thinking", "UserPromptSubmit", {
    agentId: "workbuddy", profileId: "local", rawSessionId: id, cwd: "/project",
    transcriptPath: input(dir, { rawSessionId: id }).transcriptPath.replace("s1.jsonl", `${id}.jsonl`), ...extra,
  });
}

async function waitFor(predicate) {
  const until = Date.now() + 2000;
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate());
}

describe("WorkBuddy native context database", { skip: !DatabaseSync }, () => {
  it("reads native used/size in the title connection, preserves bytes, and never reads credits", async () => {
    await fixture(async (dir) => {
      createDatabase(dir);
      const file = path.join(dir, "workbuddy.db");
      const hash = () => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const before = hash();
      const queries = [];
      let opens = 0, closes = 0;
      const row = read(dir, {}, { openDatabase(filePath) {
        opens++;
        const db = new DatabaseSync(filePath, { readOnly: true });
        return { prepare(sql) { queries.push(sql); return db.prepare(sql); }, close() { closes++; db.close(); } };
      } });
      assert.deepEqual(row, { title: "Native title", archived: false, home: dir,
        contextUsage: { used: 250, limit: 1000, percent: 25, source: "workbuddy" } });
      assert.equal(opens, 1); assert.equal(closes, 1); assert.equal(hash(), before);
      assert.ok(queries.some((sql) => sql === "SELECT used, size FROM session_usage WHERE session_id = ?"));
      assert.ok(queries.every((sql) => !sql.includes("credit_json")));
      writeDatabase(dir, "UPDATE session_usage SET used=?,size=? WHERE session_id='s1'", 0, 500);
      assert.deepEqual(read(dir).contextUsage, { used: 0, limit: 500, percent: 0, source: "workbuddy" });
      writeDatabase(dir, "UPDATE session_usage SET used=?,size=? WHERE session_id='s1'", 700, 500);
      assert.deepEqual(read(dir).contextUsage, { used: 700, limit: 500, percent: 100, source: "workbuddy" });
    });
  });

  it("keeps title/lifecycle contracts when usage is unsupported or its query fails", async () => {
    await fixture(async (dir) => {
      createDatabase(dir, { usage: false });
      const expected = { title: "Native title", archived: false, home: dir };
      assert.deepEqual(read(dir), expected);
      writeDatabase(dir, "CREATE TABLE session_usage (session_id TEXT)");
      assert.deepEqual(read(dir), expected);
      const options = { openDatabase(filePath) {
        const db = new DatabaseSync(filePath, { readOnly: true });
        return { prepare(sql) { if (sql.includes("session_usage")) throw new Error("unavailable usage"); return db.prepare(sql); }, close() { db.close(); } };
      } };
      assert.deepEqual(read(dir, {}, options), expected);
      writeDatabase(dir, "UPDATE sessions SET status='archived' WHERE id='s1'");
      assert.deepEqual(read(dir, {}, options), { title: "Native title", archived: true, home: dir });
    });
    await fixture(async (dir) => {
      createDatabase(dir, { usage: false, legacy: true });
      assert.deepEqual(read(dir), { title: "Native title", archived: null, home: dir });
    });
  });

  it("reports readable missing/invalid counters as unknown, preserving zero and over-budget values", async () => {
    await fixture(async (dir) => {
      createDatabase(dir);
      for (const [used, size] of [[null, 1000], ["250", 1000], [250, "1000"], [-1, 1000],
        [1.5, 1000], [250, 0], [250, -1], [250, 1000.5], [1e20, 1000], [250, 1e20]]) {
        writeDatabase(dir, "UPDATE session_usage SET used=?,size=? WHERE session_id='s1'", used, size);
        assert.equal(read(dir).contextUsage, null, `invalid counters: ${used}/${size}`);
      }
      writeDatabase(dir, "DELETE FROM session_usage WHERE session_id='s1'");
      assert.equal(read(dir).contextUsage, null);
      assert.equal(read(dir, { rawSessionId: "s1' OR 1=1 --" }), null);
      assert.equal(read(dir, { cwd: "/another-project" }), null);
    });
  });

  it("uses only the owning/pinned home and never adopts another home's same-id usage", async () => {
    await fixture(async (home) => {
      const owner = path.join(home, "owner"), sibling = path.join(home, "sibling");
      createDatabase(owner, { title: null }); createDatabase(sibling);
      writeDatabase(sibling, "UPDATE session_usage SET used=900,size=1000");
      const options = { dataDirs: [sibling, owner] };
      assert.equal(readWorkBuddyDatabaseSession(input(owner), options).contextUsage.percent, 25);
      assert.equal(readWorkBuddyDatabaseSession(input(owner, { cwd: "" }), options).contextUsage.percent, 25,
        "a missing cwd retains exact session and transcript-owner scope");
      assert.equal(readWorkBuddyDatabaseSession(input(owner, { transcriptPath: null, lifecycleHome: owner }), options).contextUsage.percent, 25);
      for (const transcriptPath of [null, path.join(home, "outside", "s1.jsonl")]) {
        assert.ok(!Object.hasOwn(readWorkBuddyDatabaseSession(input(owner, { transcriptPath }), options), "contextUsage"));
      }
      writeDatabase(owner, "DELETE FROM sessions WHERE id='s1'");
      assert.ok(!Object.hasOwn(readWorkBuddyDatabaseSession(input(owner), options), "contextUsage"));
    });
  });
});

describe("WorkBuddy context observer", () => {
  it("discards context reads after end, disable, or same-id turn replacement", async () => {
    for (const action of ["end", "disable", "resume"]) {
      let live = {};
      let complete;
      const contexts = [];
      const tracker = createWorkBuddySessionTitleTracker({ getSession: () => live,
        readTitle: () => new Promise((resolve) => { complete = resolve; }),
        updateContextUsage: (...args) => contexts.push(args) });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1" });
        if (action === "end") tracker.clear("s1");
        if (action === "disable") live = null;
        if (action === "resume") tracker.beginTurn({ sessionId: "s1", rawSessionId: "s1" });
        complete({ contextUsage: { used: 25, limit: 100, percent: 25, source: "workbuddy" } });
        await nextTurn();
        assert.deepEqual(contexts, [], action);
      } finally { tracker.clear(); }
    }
  });

  it("retires archives before context callbacks and rechecks scope after title callbacks", async () => {
    for (const archived of [true, false]) {
      let live = {};
      const contexts = [], retired = [];
      const tracker = createWorkBuddySessionTitleTracker({ getSession: () => live,
        readTitle: async () => ({ title: "Title", archived, home: "fake-home", contextUsage: null }),
        updateTitle() { live = null; }, updateContextUsage: (...args) => contexts.push(args),
        onRetired: (value) => retired.push(value) });
      try {
        tracker.track({ sessionId: "s1", rawSessionId: "s1" });
        await tracker.poll();
        assert.deepEqual(contexts, []);
        assert.equal(retired.length, archived ? 1 : 0);
      } finally { tracker.clear(); }
    }
  });

  it("delivers usage without a native title and alongside a JSONL fallback title", { skip: !DatabaseSync }, async () => {
    await fixture(async (dir) => {
      createDatabase(dir, { title: null });
      const transcript = input(dir).transcriptPath;
      fs.mkdirSync(path.dirname(transcript), { recursive: true });
      fs.writeFileSync(transcript, "");
      const live = {}, contexts = [], titles = [];
      const tracker = createWorkBuddySessionTitleTracker({ dataDirs: [dir], getSession: () => live,
        updateContextUsage: (...args) => contexts.push(args), updateTitle: (...args) => titles.push(args) });
      try {
        tracker.track({ sessionId: "s1", ...input(dir) });
        await tracker.poll();
        assert.equal(contexts.at(-1)[1].percent, 25); assert.equal(titles.length, 0);
        fs.appendFileSync(transcript, JSON.stringify({ type: "ai-title", sessionId: "s1", aiTitle: "Fallback title" }) + "\n");
        writeDatabase(dir, "UPDATE session_usage SET used=400");
        await tracker.poll();
        assert.deepEqual(titles.at(-1), ["s1", "Fallback title"]);
        assert.equal(contexts.at(-1)[1].percent, 40);
      } finally { tracker.clear(); }
    });
  });
});

describe("WorkBuddy context through runtime, snapshots, and HUD", { skip: !DatabaseSync }, () => {
  it("ignores native cost-only 0/0 without changing activity and accepts true zero context", async () => {
    await fixture(async (dir) => {
      createDatabase(dir);
      const { state, runtime } = makeRuntime(dir);
      try {
        submit(runtime, dir);
        await waitFor(() => state.sessions.get("s1").contextUsage?.percent === 25);
        const before = state.sessions.get("s1");
        const lifecycle = { updatedAt: before.updatedAt, state: before.state, event: before.event };
        writeDatabase(dir, "UPDATE session_usage SET used=0,size=0");
        assert.ok(!Object.hasOwn(read(dir), "contextUsage"), "cost-only is unavailable, not an unknown occupancy");
        await runtime.getWorkBuddySessionTitleTracker().poll();
        assert.deepEqual(state.sessions.get("s1").contextUsage,
          { used: 250, limit: 1000, percent: 25, source: "workbuddy" });
        writeDatabase(dir, "UPDATE session_usage SET used=0,size=1000");
        await runtime.getWorkBuddySessionTitleTracker().poll();
        assert.deepEqual(state.sessions.get("s1").contextUsage,
          { used: 0, limit: 1000, percent: 0, source: "workbuddy" });
        const after = state.sessions.get("s1");
        assert.deepEqual({ updatedAt: after.updatedAt, state: after.state, event: after.event }, lifecycle);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("updates two native gauges without hooks, accepts post-compaction decreases, and leaves activity unchanged", async () => {
    await fixture(async (dir) => {
      createDatabase(dir, { title: null });
      writeDatabase(dir, "INSERT INTO sessions VALUES ('s2',NULL,NULL,'/project',NULL,'Pending')");
      writeDatabase(dir, "INSERT INTO session_usage VALUES ('s2',900,1000,1,NULL)");
      const { state, runtime, sounds } = makeRuntime(dir);
      try {
        submit(runtime, dir); submit(runtime, dir, "s2");
        await waitFor(() => state.sessions.get("s1").contextUsage && state.sessions.get("s2").contextUsage);
        const before = [...state.sessions].map(([id, value]) => [id, {
          updatedAt: value.updatedAt, state: value.state, event: value.event, recentEvents: [...value.recentEvents],
        }]);
        const soundCount = sounds.length;
        writeDatabase(dir, "UPDATE session_usage SET used=150,size=300 WHERE session_id='s1'");
        writeDatabase(dir, "UPDATE session_usage SET used=50,size=1000 WHERE session_id='s2'");
        await waitFor(() => state.sessions.get("s1").contextUsage.percent === 50 && state.sessions.get("s2").contextUsage.percent === 5);
        const snapshot = state.buildSessionSnapshot();
        const renderer = fs.readFileSync(path.join(__dirname, "../src/session-hud-renderer.js"), "utf8");
        const actualUsageChip = renderer.match(/^function usageChipInfo\(session\) \{[\s\S]*?^\}/m)[0];
        const hud = vm.createContext({ snapshot: { hudShowContextUsage: true }, formatTokenCount: String, t: () => "{used}/{limit} ({percent}%)" });
        vm.runInContext(actualUsageChip, hud);
        for (const [id, lifecycle] of before) {
          const session = state.sessions.get(id);
          assert.deepEqual({ updatedAt: session.updatedAt, state: session.state, event: session.event, recentEvents: session.recentEvents }, lifecycle);
          assert.equal(session.contextUsageOrigin, "workbuddy-native");
          const projected = snapshot.sessions.find((value) => value.id === id);
          assert.equal(projected.contextUsage.source, "workbuddy");
          assert.equal(hud.usageChipInfo(projected).label, id === "s1" ? "50%" : "5%");
        }
        assert.equal(sounds.length, soundCount);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("preserves unavailable usage and foreign telemetry, clears readable unknown native usage, and never creates a row", async () => {
    await fixture(async (dir) => {
      createDatabase(dir);
      const { state, runtime } = makeRuntime(dir);
      try {
        submit(runtime, dir);
        await waitFor(() => state.sessions.get("s1").contextUsage?.source === "workbuddy");
        writeDatabase(dir, "DROP TABLE session_usage");
        await runtime.getWorkBuddySessionTitleTracker().poll();
        assert.equal(state.sessions.get("s1").contextUsage.percent, 25);
        writeDatabase(dir, "CREATE TABLE session_usage (session_id TEXT PRIMARY KEY, used, size)");
        await runtime.getWorkBuddySessionTitleTracker().poll();
        assert.equal(state.sessions.get("s1").contextUsage, null);
        for (const source of ["codex", "workbuddy"]) {
          state.updateSessionMetadata("s1", { contextUsage: { used: 8, limit: 10, percent: 80, source } });
          await runtime.getWorkBuddySessionTitleTracker().poll();
          assert.equal(state.sessions.get("s1").contextUsage.source, source);
          assert.equal(state.sessions.get("s1").contextUsageOrigin, null);
        }
        state.dismissSession("s1");
        await runtime.getWorkBuddySessionTitleTracker().poll();
        assert.equal(state.sessions.size, 0);
      } finally { runtime.cleanup(); state.cleanup(); }
    });
  });

  it("does no local database reads for remote, WSL, headless, disabled, or foreign-agent sessions", async () => {
    await fixture(async (dir) => {
      createDatabase(dir);
      let reads = 0;
      const { state, runtime } = makeRuntime(dir, { isAgentEnabled: () => true,
        workBuddySessionTitleOptions: { dataDirs: [dir], openDatabase() { reads++; throw new Error("must not read"); } } });
      try {
        for (const extra of [{ profileId: "remote" }, { host: "remote" }, { wslDistro: "Ubuntu" }, { headless: true }, { agentId: "codex" }]) {
          submit(runtime, dir, "s1", extra);
        }
        await nextTurn(); assert.equal(reads, 0);
      } finally { runtime.cleanup(); state.cleanup(); }
      const disabled = makeRuntime(dir, { isAgentEnabled: () => false,
        workBuddySessionTitleOptions: { dataDirs: [dir], openDatabase() { reads++; throw new Error("must not read"); } } });
      try { submit(disabled.runtime, dir); await nextTurn(); assert.equal(reads, 0); }
      finally { disabled.runtime.cleanup(); disabled.state.cleanup(); }
    });
  });
});
