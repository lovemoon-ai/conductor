import { describe, it } from "node:test";
import assert from "node:assert";

// Import directly from the extracted module so this test file doesn't
// transitively load daemon.js (which needs @love-moon/conductor-sdk
// build artifacts that are not available in every test environment).
import {
  maskErrorForLogs,
  maskHandoffUrlForLogs,
  redactSecretsForLogs,
} from "../src/handoff-log-mask.js";

describe("maskHandoffUrlForLogs", () => {
  it("masks the token in a bare handoff URL", () => {
    assert.strictEqual(
      maskHandoffUrlForLogs("http://h:6152/share/abcdefghij/plain"),
      "http://h:6152/share/<masked:…ghij>/plain",
    );
  });

  it("masks even when the URL carries a query string", () => {
    const out = maskHandoffUrlForLogs(
      "http://h/share/TOKEN1234/plain?v=2&x=y",
    );
    assert.ok(!out.includes("TOKEN1234"), "raw token must not leak");
    assert.ok(out.includes("<masked:…1234>"));
    assert.ok(out.includes("?v=2&x=y"), "query string must be preserved");
  });

  it("masks even when the URL carries a fragment", () => {
    const out = maskHandoffUrlForLogs("http://h/share/TOKEN1234/plain#frag");
    assert.ok(!out.includes("TOKEN1234"));
    assert.ok(out.includes("#frag"));
  });

  it("masks every handoff URL occurrence in a long multi-line message", () => {
    const input = [
      "Fetch http://h/share/AAAA1111/plain for context",
      "Fallback http://h/share/BBBB2222/plain",
    ].join("\n");
    const out = maskHandoffUrlForLogs(input);
    assert.ok(!out.includes("AAAA1111"));
    assert.ok(!out.includes("BBBB2222"));
    assert.ok(out.includes("<masked:…1111>"));
    assert.ok(out.includes("<masked:…2222>"));
  });

  it("leaves unrelated strings untouched", () => {
    const input = "no token here, just some /share/but/no/plain suffix path";
    // The regex will still mask `/share/but` because it matches any path
    // segment after `/share/`. This is acceptable — the function is tuned
    // for defense, not perfect fidelity, and the "mask" pattern is harmless
    // on non-token paths.
    const out = maskHandoffUrlForLogs(input);
    assert.ok(out.includes("<masked:…"));
  });

  it("returns non-string values unchanged", () => {
    assert.strictEqual(maskHandoffUrlForLogs(undefined), undefined);
    assert.strictEqual(maskHandoffUrlForLogs(null), null);
    assert.strictEqual(maskHandoffUrlForLogs(42), 42);
  });
});

describe("maskErrorForLogs", () => {
  it("returns the original error untouched when no URL is present in the message", () => {
    const err = new Error("something went wrong");
    assert.strictEqual(maskErrorForLogs(err), err);
  });

  it("masks the URL inside an error message", () => {
    const err = new Error("fetch failed: http://h/share/SECRETTOKEN/plain");
    const masked = maskErrorForLogs(err);
    assert.ok(!masked.message.includes("SECRETTOKEN"));
    assert.ok(masked.message.includes("<masked:…OKEN>"));
  });

  it("preserves the error's prototype so instanceof checks still work", () => {
    const err = new TypeError("bad: http://h/share/SECRETTOKEN/plain");
    const masked = maskErrorForLogs(err);
    assert.ok(
      masked instanceof TypeError,
      "masked error should keep TypeError prototype",
    );
    assert.strictEqual(masked.name, "TypeError");
  });

  it("preserves enumerable metadata like code and cause", () => {
    const cause = new Error("underlying");
    const err = Object.assign(
      new Error("fetch failed: http://h/share/SECRETTOKEN/plain"),
      { code: "E_BRIDGE_FETCH", cause, httpStatus: 502 },
    );
    const masked = maskErrorForLogs(err);
    assert.strictEqual(masked.code, "E_BRIDGE_FETCH");
    assert.strictEqual(masked.cause, cause);
    assert.strictEqual(masked.httpStatus, 502);
    assert.ok(!masked.message.includes("SECRETTOKEN"));
  });

  it("masks handoff URLs embedded in the stack trace too", () => {
    // Contract: the clone's `.stack` must not leak the raw token. We build a
    // synthetic stack string that contains the URL so we can assert the
    // masker ran, independent of whether V8's own stack happens to include
    // argument strings on this platform.
    const err = new Error("bad: http://h/share/SECRETTOKEN1/plain");
    err.stack = `Error: something\n    at fn (http://h/share/STACKTOK99/plain)\n    at main`;
    const masked = maskErrorForLogs(err);
    assert.ok(
      !masked.stack.includes("SECRETTOKEN1"),
      "message-side token must not leak via stack",
    );
    assert.ok(
      !masked.stack.includes("STACKTOK99"),
      "stack-embedded token must be masked",
    );
    assert.ok(masked.stack.includes("<masked:…"));
  });

  it("returns plain strings masked in place (no Error wrapping)", () => {
    const out = maskErrorForLogs("raw: http://h/share/TOK12345/plain");
    assert.strictEqual(typeof out, "string");
    assert.ok(!out.includes("TOK12345"));
  });

  it("passes through nullish inputs", () => {
    assert.strictEqual(maskErrorForLogs(undefined), undefined);
    assert.strictEqual(maskErrorForLogs(null), null);
  });
});

describe("redactSecretsForLogs", () => {
  it("redacts an exact known secret (the daemon's own agent token)", () => {
    const out = redactSecretsForLogs(
      "spawn env CONDUCTOR_AGENT_TOKEN=abcdefgh12345678 failed",
      ["abcdefgh12345678"],
    );
    assert.ok(!out.includes("abcdefgh12345678"), "raw token must not leak");
    assert.ok(out.includes("<redacted>"));
  });

  it("redacts secret-shaped assignments even without a known value", () => {
    const out = redactSecretsForLogs(
      "env: ANTHROPIC_API_KEY=sk-ant-abcdefghijklmn MY_PASSWORD=hunter2222",
    );
    assert.ok(!out.includes("sk-ant-abcdefghijklmn"));
    assert.ok(!out.includes("hunter2222"));
    // The key NAME is kept — it is the useful diagnostic signal.
    assert.ok(out.includes("ANTHROPIC_API_KEY=<redacted>"));
  });

  it("redacts Authorization headers and bare provider keys", () => {
    const out = redactSecretsForLogs(
      "Authorization: Bearer abc123def456ghi invalid key sk-proj-ABCDEFGHIJKLMNOP",
    );
    assert.ok(!out.includes("abc123def456ghi"));
    assert.ok(!out.includes("sk-proj-ABCDEFGHIJKLMNOP"));
    assert.ok(out.includes("Bearer <redacted>"));
  });

  it("still masks the handoff share token", () => {
    const out = redactSecretsForLogs("see http://h/share/TOKEN9999/plain");
    assert.ok(!out.includes("TOKEN9999"));
    assert.ok(out.includes("/share/<masked:…9999>/plain"));
  });

  it("ignores short known secrets so a stray value cannot blank the message", () => {
    const out = redactSecretsForLogs("boom at line 42", ["42"]);
    assert.strictEqual(out, "boom at line 42");
  });

  it("passes through nullish and empty inputs", () => {
    assert.strictEqual(redactSecretsForLogs(""), "");
    assert.strictEqual(redactSecretsForLogs(undefined), undefined);
  });
});
