"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const Module = require("node:module");
const { test } = require("node:test");
const { classifyPermissionInteraction } = require("../src/permission-automation-policy");

function createHarness(overrides = {}) {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.visible = options.show === true;
      this.destroyed = false;
      this.placements = [];
      this.shows = [];
      this.failPlacement = overrides.failPlacement === true;
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.webContents.setZoomFactor = () => {};
      this.webContents.__window = this;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    setAlwaysOnTop() {}
    setSkipTaskbar() {}
    loadFile() { return Promise.resolve(); }
    setBounds(bounds) {
      if (this.failPlacement) throw new Error("placement unavailable");
      this.bounds = { ...bounds };
      this.placements.push({ ...bounds });
    }
    getBounds() { return { ...this.bounds }; }
    showInactive() { this.shows.push({ ...this.bounds }); this.visible = true; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; this.emit("closed"); }
    static fromWebContents(sender) { return sender.__window; }
  }
  const modulePath = require.resolve("../src/permission");
  delete require.cache[modulePath];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === "electron") return {
      BrowserWindow: FakeWindow,
      globalShortcut: { register: () => true, unregister() {}, isRegistered: () => false },
    };
    return originalLoad.apply(this, arguments);
  };
  let initPermission;
  try { initPermission = require("../src/permission"); }
  finally { Module._load = originalLoad; }
  const owner = { isDestroyed: () => false };
  const workArea = { x: 0, y: 0, width: 1280, height: 900 };
  const ctx = {
    win: owner, lang: "en", sessions: new Map(), bubbleFollowPet: false,
    bubbleFixedCorner: "bottom-right", getBubblePolicy: () => ({ enabled: true, autoCloseMs: 0 }),
    getSettingsSnapshot: () => ({ shortcuts: {} }), subscribeShortcuts: () => () => {},
    isAgentPermissionsEnabled: () => true, getPetWindowBounds: () => ({ x: 800, y: 700, width: 100, height: 100 }),
    getNearestWorkArea: () => workArea, getHitRectScreen: () => null, getHudReservedOffset: () => 0,
    guardAlwaysOnTop() {}, reapplyMacVisibility() {}, repositionUpdateBubble() {},
    ...overrides,
  };
  const api = initPermission(ctx);
  function addEntry() {
    const entry = {
      sessionId: "position-test", agentId: "zcode", isZcode: true, toolName: "Bash",
      toolInput: { command: "echo synthetic" }, suggestions: [], createdAt: Date.now(),
      interaction: classifyPermissionInteraction({ agentId: "zcode", toolName: "Bash" }),
    };
    api.addPendingPermission(entry);
    api.showPermissionBubble(entry);
    return entry;
  }
  return { api, ctx, owner, windows, workArea, addEntry };
}

test("a request receives valid placement before its first show", () => {
  const { addEntry } = createHarness();
  const entry = addEntry();
  assert.equal(entry.bubble.shows.length, 1);
  assert.deepEqual(entry.bubble.shows[0], entry.bubble.placements[0]);
  assert.ok(entry.bubble.shows[0].x > 0 && entry.bubble.shows[0].y > 0);
});

for (const unavailable of ["absent", "destroyed"]) {
  test(`an unavailable pet owner (${unavailable}) keeps a new request hidden until owner recovery`, () => {
    const harness = createHarness({ win: unavailable === "absent" ? null : { isDestroyed: () => true } });
    const entry = harness.addEntry();
    assert.equal(entry.bubble.isVisible(), false);
    assert.equal(entry.bubble.shows.length, 0);
    assert.deepEqual(harness.api.pendingPermissions, [entry], "placement cannot decide or remove the request");
    entry.bubble.webContents.emit("did-finish-load");
    harness.ctx.win = harness.owner;
    harness.api.repositionBubbles();
    assert.equal(entry.bubble.isVisible(), true);
    assert.deepEqual(entry.bubble.shows[0], entry.bubble.placements[0]);
  });
}

test("failed native placement keeps a request hidden and retries on reconciliation", () => {
  const harness = createHarness({ failPlacement: true });
  const entry = harness.addEntry();
  assert.equal(entry.bubble.isVisible(), false);
  assert.equal(entry.bubble.shows.length, 0);
  assert.deepEqual(harness.api.pendingPermissions, [entry]);
  entry.bubble.failPlacement = false;
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), true);
  assert.deepEqual(entry.bubble.shows[0], entry.bubble.placements[0]);
});

test("renderer readiness retries placement after a transient native failure", () => {
  const harness = createHarness({ failPlacement: true });
  const entry = harness.addEntry();
  assert.equal(entry.bubble.isVisible(), false);
  entry.bubble.failPlacement = false;
  entry.bubble.webContents.emit("did-finish-load");
  assert.equal(entry.bubble.isVisible(), true);
  assert.deepEqual(entry.bubble.shows[0], entry.bubble.placements[0]);
});

for (const invalid of [
  { x: NaN, y: 0, width: 1280, height: 900 },
  { x: 0, y: Infinity, width: 1280, height: 900 },
  { x: 0, y: 0, width: 0, height: 900 },
  { x: 0, y: 0, width: 1280, height: -1 },
]) {
  test(`invalid work area ${JSON.stringify(invalid)} never reaches first show`, () => {
    const harness = createHarness({ getNearestWorkArea: () => invalid });
    const entry = harness.addEntry();
    assert.equal(entry.bubble.isVisible(), false);
    assert.equal(entry.bubble.placements.length, 0);
    harness.ctx.getNearestWorkArea = () => harness.workArea;
    harness.api.repositionBubbles();
    assert.equal(entry.bubble.isVisible(), true);
  });
}

test("missing pet bounds can recover without creating an origin bubble", () => {
  const harness = createHarness({ getPetWindowBounds: () => null });
  const entry = harness.addEntry();
  assert.equal(entry.bubble.isVisible(), false);
  harness.ctx.getPetWindowBounds = () => ({ x: 800, y: 700, width: 100, height: 100 });
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), true);
});

test("negative multi-monitor coordinates remain valid placement", () => {
  const harness = createHarness({ getNearestWorkArea: () => ({ x: -1280, y: -900, width: 1280, height: 900 }) });
  const entry = harness.addEntry();
  assert.equal(entry.bubble.isVisible(), true);
  assert.ok(entry.bubble.shows[0].x < 0 && entry.bubble.shows[0].y < 0);
});

test("invalid computed follow-pet bounds cannot expose the constructor origin", () => {
  const harness = createHarness({
    bubbleFollowPet: true,
    getHitRectScreen: () => ({ left: NaN, top: 700, right: NaN, bottom: 800 }),
  });
  const entry = harness.addEntry();
  assert.equal(entry.bubble.isVisible(), false);
  assert.equal(entry.bubble.placements.length, 0);
  harness.ctx.getHitRectScreen = () => ({ left: 800, top: 700, right: 900, bottom: 800 });
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), true);
});

test("IME freeze cannot show a newly-created window before first placement", () => {
  const harness = createHarness({ failPlacement: true });
  const entry = harness.addEntry();
  entry.bubble.__clawdMacImeEditing = true;
  entry.bubble.failPlacement = false;
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), false);
  delete entry.bubble.__clawdMacImeEditing;
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), true);
});

test("an already-positioned editing bubble retains its bounds during IME freeze", () => {
  const harness = createHarness();
  const entry = harness.addEntry();
  const originalBounds = entry.bubble.getBounds();
  const placementCount = entry.bubble.placements.length;
  entry.bubble.__clawdMacImeEditing = true;
  harness.ctx.getNearestWorkArea = () => ({ x: -1280, y: 0, width: 1280, height: 900 });
  harness.api.repositionBubbles();
  assert.deepEqual(entry.bubble.getBounds(), originalBounds);
  assert.equal(entry.bubble.placements.length, placementCount);
  assert.equal(entry.bubble.isVisible(), true);
});

test("a hidden window is not re-shown at stale bounds after placement fails", () => {
  const harness = createHarness();
  const entry = harness.addEntry();
  entry.bubble.hide();
  entry.bubble.failPlacement = true;
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), false);
  assert.equal(entry.bubble.shows.length, 1);
  entry.bubble.failPlacement = false;
  harness.api.repositionBubbles();
  assert.equal(entry.bubble.isVisible(), true);
});
