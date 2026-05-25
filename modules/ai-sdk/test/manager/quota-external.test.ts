import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AiManager, getExternalQuotaList } from "../../src/manager/index.ts";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-external-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

async function withProviderPath<T>(modulePath: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.AISDK_PROVIDER_PATH;
  process.env.AISDK_PROVIDER_PATH = modulePath;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AISDK_PROVIDER_PATH;
    } else {
      process.env.AISDK_PROVIDER_PATH = previous;
    }
  }
}

test("getExternalQuotaList delegates to external provider quota hook", async () => {
  await withTmp(async (dir) => {
    const callsPath = join(dir, "calls.json");
    const providerPath = join(dir, "provider.js");
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      providerPath,
      `
        import { readFileSync, writeFileSync } from "node:fs";
        const callsPath = ${JSON.stringify(callsPath)};
        function appendCall(call) {
          let calls = [];
          try { calls = JSON.parse(readFileSync(callsPath, "utf8")); } catch {}
          calls.push(call);
          writeFileSync(callsPath, JSON.stringify(calls));
        }
        export const providers = [{
          backend: "private-ext",
          variant: "fake-private",
          async createSession() { return { async runTurn() { return { text: "" }; }, async close() {} }; },
          async getQuotaList(options) {
            appendCall({ method: "getQuotaList", options });
            return {
              source: "fresh",
              fetchedAt: 1700000000,
              count: 2,
              label: "Private Provider",
              quotas: [
                {
                  model: "model-a",
                  source: "fresh",
                  fetchedAt: 1700000000,
                  daily: { usedPercent: 1, remainingPercent: 99, limit: 100, used: 1, remaining: 99 },
                },
                {
                  model: "model-b",
                  source: "fresh",
                  fetchedAt: 1700000000,
                  daily: { usedPercent: 40, remainingPercent: 60, limit: 200, used: 80, remaining: 120 },
                },
              ],
            };
          },
          async getQuota(options) {
            appendCall({ method: "getQuota", options });
            return {
              model: options.model,
              source: "fresh",
              fetchedAt: 1700000000,
              daily: { usedPercent: 40, remainingPercent: 60, limit: 200, used: 80, remaining: 120 },
            };
          },
        }];
      `,
    );

    await withProviderPath(providerPath, async () => {
      const list = await getExternalQuotaList({
        backend: "private-ext",
        configPath,
        forceRefresh: true,
        timeoutMs: 1234,
      });
      assert.equal(list.source, "fresh");
      assert.equal(list.backend, "private-ext");
      assert.equal(list.label, "Private Provider");
      assert.equal(list.count, 2);
      assert.equal(list.quotaByModel["model-a"]!.daily.remainingPercent, 99);
      assert.equal(list.quotaByModel["model-b"]!.daily.limit, 200);

      const manager = new AiManager({ configPath });
      const quota = await manager.getExternalQuota({
        backend: "private-ext",
        model: "model-b",
        ttlSeconds: 0,
      });
      assert.equal(quota.model, "model-b");
      assert.equal(quota.daily.remaining, 120);

      const calls = JSON.parse(readFileSync(callsPath, "utf8")) as Array<{
        method: string;
        options: Record<string, unknown>;
      }>;
      assert.equal(calls[0]!.method, "getQuotaList");
      assert.equal(calls[0]!.options.forceRefresh, true);
      assert.equal(calls[0]!.options.timeoutMs, 1234);
      assert.equal(calls[1]!.method, "getQuota");
      assert.equal(calls[1]!.options.model, "model-b");
      assert.equal(calls[1]!.options.ttlSeconds, 0);
    });
  });
});

test("getExternalQuotaList returns unknown when provider quota hook is unavailable", async () => {
  await withTmp(async (dir) => {
    const providerPath = join(dir, "provider-no-quota.js");
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      providerPath,
      `
        export const providers = [{
          backend: "private-ext",
          variant: "fake-private",
          async createSession() { return { async runTurn() { return { text: "" }; }, async close() {} }; },
        }];
      `,
    );

    await withProviderPath(providerPath, async () => {
      const list = await getExternalQuotaList({ backend: "private-ext", configPath });
      assert.equal(list.source, "unknown");
      assert.equal(list.count, 0);
      assert.match(list.error ?? "", /quota list hook unavailable/);
    });
  });
});
