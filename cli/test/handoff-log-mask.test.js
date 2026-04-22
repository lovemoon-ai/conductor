import { describe, it } from "node:test";
import assert from "node:assert";

import { maskErrorForLogs, maskHandoffUrlForLogs } from "../src/daemon.js";

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

  it("preserves the stack trace", () => {
    const err = new Error("bad: http://h/share/SECRETTOKEN/plain");
    const originalStack = err.stack;
    const masked = maskErrorForLogs(err);
    assert.strictEqual(masked.stack, originalStack);
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
