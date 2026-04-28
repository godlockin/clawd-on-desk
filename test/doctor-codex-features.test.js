const { describe, it } = require("node:test");
const assert = require("node:assert");
const { checkCodexHooksFeatureText } = require("../src/doctor-detectors/codex-features-check");

describe("Codex codex_hooks feature check", () => {
  it("returns enabled when [features].codex_hooks is true", () => {
    assert.deepStrictEqual(
      checkCodexHooksFeatureText("[features]\ncodex_hooks = true\n"),
      { value: "enabled", detail: "codex_hooks=true" }
    );
  });

  it("returns disabled when [features].codex_hooks is false", () => {
    assert.deepStrictEqual(
      checkCodexHooksFeatureText("[features]\ncodex_hooks = false\n"),
      { value: "disabled", detail: "codex_hooks=false" }
    );
  });

  it("ignores codex_hooks outside the features table", () => {
    assert.deepStrictEqual(
      checkCodexHooksFeatureText("codex_hooks = true\n[other]\ncodex_hooks = false\n"),
      { value: "uncertain", detail: "codex_hooks not found" }
    );
  });

  it("stops scanning at the next table", () => {
    assert.deepStrictEqual(
      checkCodexHooksFeatureText("[features]\nfoo = true\n[model]\ncodex_hooks = true\n"),
      { value: "uncertain", detail: "codex_hooks not found" }
    );
  });

  it("returns uncertain for non-boolean codex_hooks values", () => {
    assert.deepStrictEqual(
      checkCodexHooksFeatureText("[features]\ncodex_hooks = \"true\"\n"),
      { value: "uncertain", detail: "codex_hooks is not a boolean" }
    );
  });

  it("allows comments around the feature setting", () => {
    assert.deepStrictEqual(
      checkCodexHooksFeatureText("# top\n[features] # table\ncodex_hooks = true # enabled\n"),
      { value: "enabled", detail: "codex_hooks=true" }
    );
  });
});
