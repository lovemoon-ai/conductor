import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCodexQuota,
  parseCodexRateLimitsResponse,
} from "../../src/manager/quota/codex.ts";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-codex-quota-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("parseCodexRateLimitsResponse reads the current weekly-only account bucket", () => {
  const quota = parseCodexRateLimitsResponse({
    rateLimits: {
      limitId: "codex",
      planType: "prolite",
      primary: {
        usedPercent: 33,
        windowDurationMins: 10080,
        resetsAt: 1784812905,
      },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: "0E-10" },
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        limitName: "GPT-5.3-Codex-Spark",
        primary: { usedPercent: 1, windowDurationMins: 10080 },
      },
    },
  });

  assert.equal(quota.activeLimit, "codex");
  assert.equal(quota.plan, "prolite");
  assert.equal(quota.weekly?.usedPercent, 33);
  assert.equal(quota.weekly?.remainingPercent, 67);
  assert.equal(quota.weekly?.windowMinutes, 10080);
  assert.equal(quota.weekly?.resetAt, 1784812905);
  assert.equal(quota.credits?.balance, "0E-10");
  assert.equal("fiveHour" in quota, false);
});

test("parseCodexRateLimitsResponse locates weekly quota in the legacy secondary window", () => {
  const quota = parseCodexRateLimitsResponse({
    rateLimits: {
      primary: { usedPercent: 80, windowDurationMins: 300 },
      secondary: { usedPercent: 20, windowDurationMins: 10080 },
    },
  });

  assert.equal(quota.weekly?.usedPercent, 20);
  assert.equal(quota.weekly?.windowMinutes, 10080);
});

test("parseCodexRateLimitsResponse never labels a shorter primary window as weekly", () => {
  const quota = parseCodexRateLimitsResponse({
    rateLimits: {
      primary: { usedPercent: 80, windowDurationMins: 300 },
      secondary: null,
    },
  });

  assert.equal(quota.weekly, undefined);
  assert.match(quota.error ?? "", /no weekly window/);
});

test("parseCodexRateLimitsResponse keeps nullable reset metadata absent", () => {
  const quota = parseCodexRateLimitsResponse({
    rateLimits: {
      primary: {
        usedPercent: 12,
        windowDurationMins: 10080,
        resetsAt: null,
      },
    },
  });

  assert.equal(quota.weekly?.resetAt, undefined);
  assert.equal(quota.weekly?.resetAfterSeconds, undefined);
});

test("getCodexQuota reads account rate limits and reuses its app-server cache", async () => {
  await withTmp(async (dir) => {
    const authPath = join(dir, "auth.json");
    const cacheDir = join(dir, "cache");
    writeFileSync(authPath, JSON.stringify({
      tokens: { access_token: "test-access-token-abcdef1234567890" },
    }));
    let calls = 0;
    const rateLimitsReader = async () => {
      calls += 1;
      return {
        rateLimits: {
          limitId: "codex",
          primary: { usedPercent: 45, windowDurationMins: 10080 },
          secondary: null,
        },
      };
    };

    const fresh = await getCodexQuota({
      codexAuthPath: authPath,
      cacheDir,
      rateLimitsReader,
    });
    const cached = await getCodexQuota({
      codexAuthPath: authPath,
      cacheDir,
      rateLimitsReader,
    });

    assert.equal(fresh.source, "fresh");
    assert.equal(fresh.weekly?.usedPercent, 45);
    assert.equal(cached.source, "cached");
    assert.equal(cached.weekly?.remainingPercent, 55);
    assert.equal(calls, 1);
  });
});
