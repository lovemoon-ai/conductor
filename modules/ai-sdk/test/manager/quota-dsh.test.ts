import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getDshQuota,
  normalizeDshBaseUrl,
  parseDshBalance,
  readCachedDshQuota,
  resolveDeepSeekCredential,
} from "../../src/manager/quota/dsh.ts";
import { checkInstall } from "../../src/manager/install.ts";

/** Real `/user/balance` payload shape (amounts arrive as strings). */
const BALANCE_PAYLOAD = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "45.49",
      granted_balance: "0.00",
      topped_up_balance: "45.49",
    },
  ],
};

function stubFetch(payload: unknown, status = 200) {
  let calls = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    calls += 1;
    impl.lastUrl = String(url);
    impl.lastInit = init;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  }) as any;
  impl.callCount = () => calls;
  return impl;
}

test("parseDshBalance coerces string amounts and reads availability", () => {
  const parsed = parseDshBalance(BALANCE_PAYLOAD);
  assert.equal(parsed.isAvailable, true);
  assert.equal(parsed.balances.length, 1);
  assert.deepEqual(parsed.balances[0], {
    currency: "CNY",
    totalBalance: 45.49,
    grantedBalance: 0,
    toppedUpBalance: 45.49,
  });
});

test("parseDshBalance tolerates a missing or malformed payload", () => {
  assert.deepEqual(parseDshBalance({} as never), { isAvailable: false, balances: [] });
  assert.deepEqual(parseDshBalance({ is_available: false, balance_infos: "nope" } as never), {
    isAvailable: false,
    balances: [],
  });
});

test("normalizeDshBaseUrl strips a /v1 inference suffix and trailing slashes", () => {
  assert.equal(normalizeDshBaseUrl(undefined), "https://api.deepseek.com");
  assert.equal(normalizeDshBaseUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com");
  assert.equal(normalizeDshBaseUrl("https://proxy.example.com/"), "https://proxy.example.com");
});

test("resolveDeepSeekCredential reads envs from the conductor config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-quota-config-"));
  try {
    const configPath = join(dir, "config.yaml");
    writeFileSync(
      configPath,
      "envs:\n  DEEPSEEK_API_KEY: sk-from-config\n  DEEPSEEK_BASE_URL: https://proxy.example.com/v1\n",
      "utf8",
    );
    const resolved = await resolveDeepSeekCredential({ configPath });
    assert.equal(resolved.apiKey, "sk-from-config");
    assert.equal(resolved.baseURL, "https://proxy.example.com");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getDshQuota fetches the balance, then serves it from cache", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "dsh-quota-cache-"));
  try {
    const fetchImpl = stubFetch(BALANCE_PAYLOAD);
    const fresh = await getDshQuota({
      apiKey: "sk-test",
      cacheDir,
      forceRefresh: true,
      fetchImpl,
    });

    assert.equal(fresh.tool, "dsh");
    assert.equal(fresh.source, "fresh");
    assert.equal(fresh.isAvailable, true);
    assert.equal(fresh.primaryBalance?.totalBalance, 45.49);
    assert.equal(fresh.primaryBalance?.currency, "CNY");
    assert.equal(fresh.error, undefined);
    assert.equal(fetchImpl.lastUrl, "https://api.deepseek.com/user/balance");
    assert.equal(
      (fetchImpl.lastInit?.headers as Record<string, string>).Authorization,
      "Bearer sk-test",
    );

    const cached = await getDshQuota({ apiKey: "sk-test", cacheDir, fetchImpl });
    assert.equal(cached.source, "cached");
    assert.equal(cached.primaryBalance?.totalBalance, 45.49);
    assert.equal(fetchImpl.callCount(), 1, "cached read must not hit the network");

    const readBack = await readCachedDshQuota({ apiKey: "sk-test", cacheDir });
    assert.equal(readBack?.source, "cached");
    assert.equal(readBack?.primaryBalance?.totalBalance, 45.49);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("getDshQuota falls back to a stale cache when the request fails", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "dsh-quota-stale-"));
  try {
    await getDshQuota({
      apiKey: "sk-test",
      cacheDir,
      forceRefresh: true,
      fetchImpl: stubFetch(BALANCE_PAYLOAD),
    });

    const stale = await getDshQuota({
      apiKey: "sk-test",
      cacheDir,
      forceRefresh: true,
      fetchImpl: stubFetch({}, 401),
    });

    assert.equal(stale.source, "stale");
    assert.equal(stale.primaryBalance?.totalBalance, 45.49);
    assert.match(stale.error ?? "", /HTTP 401/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("getDshQuota reports an unauthorized request with no cache to fall back on", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "dsh-quota-401-"));
  try {
    const quota = await getDshQuota({
      apiKey: "sk-bad",
      cacheDir,
      forceRefresh: true,
      fetchImpl: stubFetch({}, 401),
    });
    assert.equal(quota.isAvailable, false);
    assert.equal(quota.source, "unknown");
    assert.deepEqual(quota.balances, []);
    assert.match(quota.error ?? "", /HTTP 401/);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("getDshQuota reports a missing credential without any network call", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "dsh-quota-nokey-"));
  try {
    const fetchImpl = stubFetch(BALANCE_PAYLOAD);
    // An explicit empty key is a refusal and must not fall back to the
    // ambient DEEPSEEK_API_KEY of the daemon process.
    const quota = await getDshQuota({
      apiKey: "",
      configPath: join(cacheDir, "missing-config.yaml"),
      cacheDir,
      fetchImpl,
    });
    assert.equal(quota.isAvailable, false);
    assert.match(quota.error ?? "", /DEEPSEEK_API_KEY is not configured/);
    assert.equal(fetchImpl.callCount(), 0);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("checkInstall reports the dsh runtime package version", async () => {
  const status = await checkInstall("dsh");
  assert.equal(status.installed, true, status.error);
  assert.equal(status.path, "@deepseek-ai/dsh-sdk-jsonrpc-demo");
  assert.match(status.version ?? "", /^\d+\.\d+\.\d+/);
});
