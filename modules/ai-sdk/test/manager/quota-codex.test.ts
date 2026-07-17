import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCodexHeaders } from "../../src/manager/quota/codex.ts";

test("parseCodexHeaders reads the Codex 0.144 weekly-only primary window", () => {
  const quota = parseCodexHeaders(
    {
      "x-codex-plan-type": "prolite",
      "x-codex-primary-used-percent": "33",
      "x-codex-primary-window-minutes": "10080",
      "x-codex-primary-reset-at": "1784812905",
    },
    {},
  );

  assert.equal(quota.weekly.usedPercent, 33);
  assert.equal(quota.weekly.remainingPercent, 67);
  assert.equal(quota.weekly.windowMinutes, 10080);
  assert.equal(quota.weekly.resetAt, 1784812905);
  assert.equal("fiveHour" in quota, false);
});

test("parseCodexHeaders still locates weekly quota in legacy secondary headers", () => {
  const quota = parseCodexHeaders(
    {
      "x-codex-primary-used-percent": "80",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "20",
      "x-codex-secondary-window-minutes": "10080",
    },
    {},
  );

  assert.equal(quota.weekly.usedPercent, 20);
  assert.equal(quota.weekly.windowMinutes, 10080);
  assert.equal("fiveHour" in quota, false);
});
