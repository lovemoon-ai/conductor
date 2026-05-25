import { test } from "node:test";
import assert from "node:assert/strict";
import { headersToMap, num, str, bool } from "../../src/manager/quota/headers.ts";

test("headersToMap lowercases keys", () => {
  const h = new Headers({ "X-Foo": "1", "X-Bar": "hi" });
  const m = headersToMap(h);
  assert.equal(m["x-foo"], "1");
  assert.equal(m["x-bar"], "hi");
});

test("num/str/bool coerce correctly", () => {
  const m: Record<string, string> = {
    "x-num": "42",
    "x-float": "0.07",
    "x-str": "hello",
    "x-true": "True",
    "x-false": "false",
    "x-empty": "",
  };
  assert.equal(num(m, "x-num"), 42);
  assert.equal(num(m, "x-float"), 0.07);
  assert.equal(num(m, "x-empty"), undefined);
  assert.equal(num(m, "missing"), undefined);
  assert.equal(str(m, "x-str"), "hello");
  assert.equal(str(m, "x-empty"), undefined);
  assert.equal(bool(m, "x-true"), true);
  assert.equal(bool(m, "x-false"), false);
  assert.equal(bool(m, "x-str"), undefined);
});
