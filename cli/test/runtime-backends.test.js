import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BUILT_IN_BACKENDS } from "@love-moon/ai-sdk";

import {
  RUNTIME_SUPPORTED_BACKENDS,
  assertCliAndAiSdkBackendsAgree,
} from "../src/runtime-backends.js";

describe("runtime-backends invariant", () => {
  it("module-load self-check passes for the current registry", () => {
    // The fact that the import above succeeded already proves this, but assert
    // explicitly so a future regression in the self-check itself is caught.
    assert.doesNotThrow(() =>
      assertCliAndAiSdkBackendsAgree(RUNTIME_SUPPORTED_BACKENDS, BUILT_IN_BACKENDS),
    );
  });

  it("rejects when ai-sdk adds a new backend that CLI doesn't list", () => {
    const cliBackends = ["codex", "claude"];
    const aiSdkBackends = [
      { backend: "codex" },
      { backend: "claude" },
      { backend: "gemini" }, // new built-in only in ai-sdk
    ];
    assert.throws(
      () => assertCliAndAiSdkBackendsAgree(cliBackends, aiSdkBackends),
      /ai-sdk has built-in backend "gemini" but BUILT_IN_RUNTIME_BACKENDS does not list it/,
    );
  });

  it("rejects when CLI lists a backend that ai-sdk doesn't know about", () => {
    const cliBackends = ["codex", "ghost-removed"];
    const aiSdkBackends = [{ backend: "codex" }];
    assert.throws(
      () => assertCliAndAiSdkBackendsAgree(cliBackends, aiSdkBackends),
      /BUILT_IN_RUNTIME_BACKENDS lists "ghost-removed" but ai-sdk does not know about it/,
    );
  });

  it("accepts arbitrary ordering as long as the sets agree", () => {
    const cliBackends = ["claude", "codex", "kimi"];
    const aiSdkBackends = [
      { backend: "kimi" },
      { backend: "codex" },
      { backend: "claude" },
    ];
    assert.doesNotThrow(() =>
      assertCliAndAiSdkBackendsAgree(cliBackends, aiSdkBackends),
    );
  });

  it("rejects duplicates that mask drift (CLI has only 2 unique entries vs ai-sdk's 3)", () => {
    const cliBackends = ["codex", "codex"];
    const aiSdkBackends = [{ backend: "codex" }, { backend: "claude" }];
    assert.throws(
      () => assertCliAndAiSdkBackendsAgree(cliBackends, aiSdkBackends),
      /ai-sdk has built-in backend "claude"/,
    );
  });
});
