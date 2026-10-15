"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createLinuxX11InputHint,
  loadXcbBindings,
  readXid,
  encodeNoInputWmHints,
} = require("../src/linux-x11-input-hint");

// Pinned wire values: ICCCM WM_HINTS is nine CARD32 fields, and InputHint is
// (1L << 0) in Xutil.h. Only the input field is valid, and it is False.
const NO_INPUT_WM_HINTS = [1, 0, 0, 0, 0, 0, 0, 0, 0];

// Electron hands back the X11 Window id as a native-endian unsigned long.
function handleFor(xid, size = 8) {
  const buf = Buffer.alloc(size);
  const le = os.endianness() === "LE";
  if (size >= 8) {
    if (le) buf.writeBigUInt64LE(BigInt(xid)); else buf.writeBigUInt64BE(BigInt(xid));
  } else if (le) {
    buf.writeUInt32LE(xid);
  } else {
    buf.writeUInt32BE(xid);
  }
  return buf;
}

function makeWindow(xid = 0x00a00004, { destroyed = false, size = 8 } = {}) {
  return {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => handleFor(xid, size),
  };
}

function decodeFields(data) {
  const fields = new Uint32Array(data.buffer, data.byteOffset, data.length / 4);
  return Array.from(fields);
}

function makeBindings({ connectionError = 0, requestError = null } = {}) {
  const calls = [];
  const connection = { id: "conn" };
  const cookie = { sequence: 7 };
  const bindings = {
    calls,
    connect: (displayName, screenp) => {
      calls.push(["connect", displayName, screenp]);
      return connection;
    },
    hasError: (conn) => {
      calls.push(["hasError", conn === connection]);
      return connectionError;
    },
    changePropertyChecked: (conn, mode, window, property, type, format, length, data) => {
      calls.push(["changePropertyChecked", {
        sameConnection: conn === connection,
        mode,
        window,
        property,
        type,
        format,
        length,
        fields: decodeFields(data),
      }]);
      return cookie;
    },
    requestCheck: (conn, checkedCookie) => {
      calls.push(["requestCheck", conn === connection, checkedCookie === cookie]);
      return requestError;
    },
    errorCode: (error) => {
      calls.push(["errorCode", error === requestError]);
      return 3;
    },
    freeError: (error) => calls.push(["freeError", error === requestError]),
    disconnect: (conn) => calls.push(["disconnect", conn === connection]),
  };
  return bindings;
}

describe("linux-x11-input-hint", () => {
  it("encodes ICCCM WM_HINTS with only the input field set, to False", () => {
    assert.deepStrictEqual(decodeFields(encodeNoInputWmHints()), NO_INPUT_WM_HINTS);
  });

  it("reads the X11 window id from a native-endian handle", () => {
    assert.equal(readXid(makeWindow(0x00a00004)), 0x00a00004);
    assert.equal(readXid(makeWindow(0x00a00004, { size: 4 })), 0x00a00004);
  });

  it("rejects handles that cannot be an X11 window", () => {
    assert.equal(readXid(null), null);
    assert.equal(readXid({}), null);
    assert.equal(readXid(makeWindow(0x00a00004, { destroyed: true })), null);
    assert.equal(readXid({ getNativeWindowHandle: () => Buffer.alloc(2) }), null);
    assert.equal(readXid(makeWindow(0)), null);
    assert.equal(readXid(makeWindow(0x20000000)), null);
  });

  it("writes the no-input hint to the window over a private connection, then disconnects", () => {
    const bindings = makeBindings();
    const hint = createLinuxX11InputHint({ isLinuxX11: true, displayName: ":1", bindings });

    assert.equal(hint.available, true);
    assert.equal(hint.applyNoInputHint(makeWindow(0x00a00004)), true);
    assert.deepStrictEqual(bindings.calls, [
      ["connect", ":1", null],
      ["hasError", true],
      ["changePropertyChecked", {
        sameConnection: true,
        mode: 0,
        window: 0x00a00004,
        // WM_HINTS is predefined atom 35 in the X11 core protocol.
        property: 35,
        type: 35,
        format: 32,
        length: 9,
        fields: NO_INPUT_WM_HINTS,
      }],
      ["requestCheck", true, true],
      ["disconnect", true],
    ]);
  });

  it("connects to $DISPLAY when no --display switch was given", () => {
    const bindings = makeBindings();
    const hint = createLinuxX11InputHint({ isLinuxX11: true, displayName: "", bindings });
    hint.applyNoInputHint(makeWindow());
    assert.deepStrictEqual(bindings.calls[0], ["connect", null, null]);
  });

  it("stays inert off the X11 backend and never loads Koffi", () => {
    let koffiLoads = 0;
    const koffi = new Proxy({}, { get() { koffiLoads += 1; throw new Error("must not load"); } });
    const hint = createLinuxX11InputHint({ isLinuxX11: false, koffi });
    assert.equal(hint.available, false);
    assert.equal(hint.applyNoInputHint(makeWindow()), false);
    assert.equal(koffiLoads, 0);
  });

  it("degrades to a reported no-op when libxcb cannot be loaded", () => {
    const errors = [];
    const koffi = { load: () => { throw new Error("libxcb.so.1: cannot open shared object file"); } };
    const hint = createLinuxX11InputHint({ isLinuxX11: true, koffi, onError: (e) => errors.push(e.message) });
    assert.equal(hint.available, false);
    assert.equal(hint.applyNoInputHint(makeWindow()), false);
    assert.deepStrictEqual(errors, ["libxcb.so.1: cannot open shared object file"]);
  });

  it("does not connect for a window without a usable X11 id", () => {
    const bindings = makeBindings();
    const hint = createLinuxX11InputHint({ isLinuxX11: true, bindings });
    assert.equal(hint.applyNoInputHint(makeWindow(0x00a00004, { destroyed: true })), false);
    assert.equal(hint.applyNoInputHint(null), false);
    assert.deepStrictEqual(bindings.calls, []);
  });

  it("still disconnects and reports when the X connection fails", () => {
    const errors = [];
    const bindings = makeBindings({ connectionError: 1 });
    const hint = createLinuxX11InputHint({ isLinuxX11: true, bindings, onError: (e) => errors.push(e.message) });

    assert.equal(hint.applyNoInputHint(makeWindow()), false);
    assert.deepStrictEqual(bindings.calls.map((call) => call[0]), ["connect", "hasError", "disconnect"]);
    assert.deepStrictEqual(errors, ["X11 connection failed (xcb_connection_has_error 1)"]);
  });

  it("frees and reports a refused request, then disconnects", () => {
    const errors = [];
    const requestError = { kind: "xcb_generic_error_t" };
    const bindings = makeBindings({ requestError });
    const hint = createLinuxX11InputHint({ isLinuxX11: true, bindings, onError: (e) => errors.push(e.message) });

    assert.equal(hint.applyNoInputHint(makeWindow()), false);
    assert.deepStrictEqual(bindings.calls.slice(-3), [
      ["errorCode", true],
      ["freeError", true],
      ["disconnect", true],
    ]);
    assert.deepStrictEqual(errors, ["X11 WM_HINTS write failed (error code 3)"]);
  });

  it("contains a throwing native call instead of propagating it", () => {
    const errors = [];
    const bindings = makeBindings();
    bindings.changePropertyChecked = () => { throw new Error("native call failed"); };
    const hint = createLinuxX11InputHint({ isLinuxX11: true, bindings, onError: (e) => errors.push(e.message) });

    assert.doesNotThrow(() => assert.equal(hint.applyNoInputHint(makeWindow()), false));
    assert.equal(bindings.calls.at(-1)[0], "disconnect");
    assert.deepStrictEqual(errors, ["native call failed"]);
  });

  // Calls the real Koffi declarations against the system libxcb. Koffi does
  // not reject a wrong argument count, so the prototypes are compared with the
  // libxcb C signatures, and the write and check are made on an error
  // connection (an impossible display): libxcb answers those without I/O, so
  // the by-value cookie is marshalled both ways without touching an X server.
  // A Koffi that fails to load on Linux fails this test instead of skipping it.
  let koffi = null;
  let koffiLoadError = null;
  let libxcbLoadable = false;
  if (process.platform === "linux") {
    try {
      koffi = require("koffi");
    } catch (error) {
      koffiLoadError = error;
    }
    if (koffi) {
      try {
        koffi.load("libxcb.so.1");
        libxcbLoadable = true;
      } catch {}
    }
  }
  const realBindingSkip = process.platform !== "linux"
    ? "Linux only"
    : (!koffiLoadError && !libxcbLoadable && "needs libxcb.so.1");
  it("calls the real libxcb bindings with the C prototypes on Linux", { skip: realBindingSkip }, () => {
    if (koffiLoadError) throw koffiLoadError;
    const bindings = loadXcbBindings(koffi);
    const prototype = (fn) => ({
      args: fn.info.arguments.map((type) => koffi.introspect(type).name),
      result: koffi.introspect(fn.info.result),
    });

    assert.deepStrictEqual(prototype(bindings.connect).args, ["char *", "int *"]); // Koffi "str"
    assert.deepStrictEqual(prototype(bindings.hasError).args, ["void *"]);
    const change = prototype(bindings.changePropertyChecked);
    assert.deepStrictEqual(change.args, [
      "void *", "uint8_t", "uint32_t", "uint32_t", "uint32_t", "uint8_t", "uint32_t", "void *",
    ]);
    assert.equal(change.result.size, 4); // xcb_void_cookie_t { unsigned int sequence; }
    assert.deepStrictEqual(Object.keys(change.result.members), ["sequence"]);
    const check = prototype(bindings.requestCheck);
    assert.equal(check.args.length, 2);
    assert.equal(koffi.introspect(bindings.requestCheck.info.arguments[1]).size, 4);
    assert.deepStrictEqual(prototype(bindings.freeError).args, ["void *"]);
    assert.deepStrictEqual(prototype(bindings.disconnect).args, ["void *"]);

    const connection = bindings.connect(":65535", null);
    try {
      assert.notEqual(bindings.hasError(connection), 0);
      const cookie = bindings.changePropertyChecked(
        connection, 0, 0x1234, 35, 35, 32, 9, encodeNoInputWmHints(),
      );
      assert.equal(typeof cookie.sequence, "number");
      assert.equal(bindings.requestCheck(connection, cookie), null);
    } finally {
      bindings.disconnect(connection);
    }

    const errors = [];
    const hint = createLinuxX11InputHint({
      isLinuxX11: true,
      displayName: ":65535",
      koffi,
      onError: (e) => errors.push(e.message),
    });
    assert.equal(hint.available, true);
    assert.equal(hint.applyNoInputHint(makeWindow()), false);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^X11 connection failed \(xcb_connection_has_error [1-7]\)$/);
  });

  it("is wired into main.js only for the X11 backend and handed to the render window", () => {
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    assert.match(
      mainSource,
      /createLinuxX11InputHint\(\{\s*isLinuxX11:\s*isLinux && app\.commandLine\.getSwitchValue\("ozone-platform"\) === "x11",\s*displayName:\s*app\.commandLine\.getSwitchValue\("display"\),\s*onError:/,
    );
    const start = mainSource.indexOf("petWindowRuntime.createRenderWindow({");
    const end = mainSource.indexOf("});", start);
    assert.ok(start >= 0 && end > start);
    assert.match(
      mainSource.slice(start, end),
      /applyNoInputHint:\s*\(createdWindow\)\s*=>\s*_linuxX11InputHint\.applyNoInputHint\(createdWindow\)/,
    );
  });
});
