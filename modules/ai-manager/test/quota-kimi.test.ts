import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUsagePayload, parseResetTime } from "../src/quota/kimi.ts";

test("parseUsagePayload extracts weekly + 5h windows from real Kimi shape", () => {
  const payload = {
    user: {
      userId: "u-1",
      region: "REGION_CN",
      membership: { level: "LEVEL_TRIAL" },
    },
    usage: {
      limit: "100",
      used: "91",
      remaining: "9",
      resetTime: "2026-04-20T05:20:49.082506Z",
    },
    limits: [
      {
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: {
          limit: "100",
          remaining: "100",
          resetTime: "2026-04-18T06:20:49.082506Z",
        },
      },
    ],
    parallel: { limit: "10" },
  };

  const q = parseUsagePayload(payload);
  assert.equal(q.tool, "kimi");
  assert.equal(q.userId, "u-1");
  assert.equal(q.region, "REGION_CN");
  assert.equal(q.membership, "LEVEL_TRIAL");
  assert.equal(q.parallelLimit, 10);
  assert.equal(q.source, "fresh");

  assert.equal(q.weekly.limit, 100);
  assert.equal(q.weekly.used, 91);
  assert.equal(q.weekly.remaining, 9);
  assert.equal(q.weekly.usedPercent, 91);
  assert.equal(q.weekly.remainingPercent, 9);
  assert.equal(q.weekly.windowMinutes, 10080);

  assert.equal(q.fiveHour.limit, 100);
  assert.equal(q.fiveHour.remaining, 100);
  assert.equal(q.fiveHour.used, 0);
  assert.equal(q.fiveHour.remainingPercent, 100);
  assert.equal(q.fiveHour.windowMinutes, 300);
});

test("parseUsagePayload prefers 5h matching window even when others are present", () => {
  const payload = {
    usage: { limit: "10", used: "0" },
    limits: [
      { window: { duration: 60, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "5", remaining: "5" } },
      { window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "20", remaining: "12" } },
      { window: { duration: 24, timeUnit: "TIME_UNIT_HOUR" }, detail: { limit: "100", remaining: "100" } },
    ],
  };
  const q = parseUsagePayload(payload);
  assert.equal(q.fiveHour.limit, 20);
  assert.equal(q.fiveHour.remaining, 12);
});

test("parseUsagePayload handles missing limits array", () => {
  const q = parseUsagePayload({ usage: { limit: "10", used: "3" } });
  assert.equal(q.weekly.limit, 10);
  assert.equal(q.weekly.used, 3);
  assert.equal(q.fiveHour.limit, undefined);
  assert.equal(q.fiveHour.remaining, undefined);
});

test("parseResetTime handles nanosecond precision and ISO without fraction", () => {
  const a = parseResetTime("2026-04-18T06:20:49.082506789Z");
  assert.ok(a && a > 1_700_000_000);
  const b = parseResetTime("2026-04-18T06:20:49Z");
  assert.ok(b && b > 1_700_000_000);
});

test("parseResetTime returns undefined on garbage input", () => {
  assert.equal(parseResetTime(undefined), undefined);
  assert.equal(parseResetTime(""), undefined);
  assert.equal(parseResetTime("not-a-date"), undefined);
  assert.equal(parseResetTime(12345 as any), undefined);
});

test("parseUsagePayload derives used from limit-remaining when only remaining is present", () => {
  const q = parseUsagePayload({ usage: { limit: "100", remaining: "37" } });
  assert.equal(q.weekly.used, 63);
  assert.equal(q.weekly.usedPercent, 63);
  assert.equal(q.weekly.remainingPercent, 37);
});
