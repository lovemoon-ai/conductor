import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCopilotQuota,
  parseCopilotQuotaSnapshots,
  parseCopilotUserQuota,
  resolveBundledCopilotCliPath,
} from "../../src/manager/quota/copilot.ts";

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-copilot-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function makeSdk(
  payload: any,
  state: { started: number; stopped: number; quotaCalls?: number },
  authStatus?: any,
  capturedOptions?: any[],
) {
  return {
    CopilotClient: class {
      constructor(options?: any) {
        capturedOptions?.push(options);
      }

      rpc = {
        account: {
          getQuota: async () => {
            state.quotaCalls = (state.quotaCalls ?? 0) + 1;
            return payload;
          },
        },
      };

      async start() {
        state.started += 1;
      }

      async stop() {
        state.stopped += 1;
        return [];
      }

      async getAuthStatus() {
        return authStatus ?? { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" };
      }
    },
  } as any;
}

test("parseCopilotQuotaSnapshots normalizes SDK quota snapshots", () => {
  const q = parseCopilotQuotaSnapshots({
    premium_interactions: {
      entitlementRequests: 100,
      usedRequests: 25,
      remainingPercentage: 75,
      overage: 0,
      overageAllowedWithExhaustedQuota: false,
      resetDate: "2026-05-01T00:00:00Z",
    },
    chat: {
      entitlementRequests: 1000,
      usedRequests: 400,
      remainingPercentage: 0.6,
      overageAllowedWithExhaustedQuota: true,
    },
  });

  assert.equal(q.primary?.remainingPercent, 75);
  assert.equal(q.primary?.usedPercent, 25);
  assert.equal(q.premiumInteractions?.limit, 100);
  assert.equal(q.premiumInteractions?.remaining, 75);
  assert.equal(q.chat?.remainingPercent, 60);
  assert.equal(q.chat?.status, "overage_allowed");
  assert.ok(q.premiumInteractions?.resetAt);
  assert.equal(q.premiumInteractions?.resetOnDate, undefined);
});

test("resolveBundledCopilotCliPath prefers Copilot platform executable", () => {
  const resolved = resolveBundledCopilotCliPath({
    platform: "darwin",
    arch: "arm64",
    resolvePackage: (packageName) => {
      if (packageName === "@github/copilot-darwin-arm64") {
        return "/tmp/node_modules/@github/copilot-darwin-arm64/copilot";
      }
      throw new Error(`unexpected package: ${packageName}`);
    },
    resolvePackagePaths: () => ["/tmp/node_modules"],
    existsSyncFn: (candidate) =>
      candidate === "/tmp/node_modules/@github/copilot-darwin-arm64/copilot" ||
      candidate === "/tmp/node_modules/@github/copilot/npm-loader.js",
  });

  assert.equal(resolved, "/tmp/node_modules/@github/copilot-darwin-arm64/copilot");
});

test("resolveBundledCopilotCliPath falls back to Copilot npm loader", () => {
  const resolved = resolveBundledCopilotCliPath({
    platform: "linux",
    arch: "x64",
    resolvePackage: () => {
      throw Object.assign(new Error("not found"), { code: "MODULE_NOT_FOUND" });
    },
    resolvePackagePaths: () => ["/tmp/node_modules"],
    existsSyncFn: (candidate) => candidate === "/tmp/node_modules/@github/copilot/npm-loader.js",
  });

  assert.equal(resolved, "/tmp/node_modules/@github/copilot/npm-loader.js");
});

test("parseCopilotUserQuota normalizes limited-user Copilot quotas", () => {
  const q = parseCopilotUserQuota({
    login: "alice",
    access_type_sku: "free_limited_copilot",
    limited_user_quotas: {
      chat: 470,
      completions: 4000,
    },
    monthly_quotas: {
      chat: 500,
      completions: 4000,
    },
    limited_user_reset_date: "2026-05-17",
  });

  assert.equal(q.chat?.remainingPercent, 94);
  assert.equal(q.chat?.usedPercent, 6);
  assert.equal(q.chat?.remaining, 470);
  assert.equal(q.chat?.limit, 500);
  assert.equal(q.completions?.remainingPercent, 100);
  assert.equal(q.completions?.remaining, 4000);
  assert.equal(q.completions?.limit, 4000);
  assert.equal(q.chat?.resetAt, undefined);
  assert.equal(q.chat?.resetOnDate, "2026-05-17");
  assert.equal(q.completions?.resetOnDate, "2026-05-17");
});

test("parseCopilotUserQuota normalizes snake_case quota snapshots", () => {
  const q = parseCopilotUserQuota({
    quota_reset_date_utc: "2026-05-01T00:00:00Z",
    quota_snapshots: {
      premium_interactions: {
        entitlement: 100,
        remaining: 75,
        percent_remaining: 75,
        overage_count: 0,
        overage_permitted: false,
      },
      completions: {
        entitlement: 1000,
        remaining: 600,
        percent_remaining: 60,
        overage_count: 0,
        overage_permitted: true,
      },
    },
  });

  assert.equal(q.primary?.remainingPercent, 75);
  assert.equal(q.premiumInteractions?.remaining, 75);
  assert.equal(q.completions?.remainingPercent, 60);
  assert.equal(q.completions?.status, "overage_allowed");
  assert.ok(q.premiumInteractions?.resetAt);
  assert.equal(q.premiumInteractions?.resetOnDate, undefined);
});

test("getCopilotQuota reuses remembered logged-in cache before starting SDK", async () => {
  await withTmp(async (dir) => {
    const alice = { started: 0, stopped: 0, quotaCalls: 0 };
    const aliceSdk = makeSdk(
      {
        quotaSnapshots: {
          chat: {
            entitlementRequests: 10,
            usedRequests: 2,
            remainingPercentage: 80,
            overage: 0,
            overageAllowedWithExhaustedQuota: false,
          },
        },
      },
      alice,
      { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" },
    );

    const first = await getCopilotQuota({ cacheDir: dir, ttlSeconds: 60, sdkModule: aliceSdk });
    assert.equal(first.source, "fresh");
    assert.equal(first.chat?.remainingPercent, 80);
    assert.equal(alice.quotaCalls, 1);
    assert.equal(alice.started, 1);

    const second = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 60,
      sdkModule: makeSdk({ quotaSnapshots: {} }, alice, {
        isAuthenticated: true,
        authType: "user",
        host: "github.com",
        login: "alice",
      }),
    });
    assert.equal(second.source, "cached");
    assert.equal(second.chat?.remainingPercent, 80);
    assert.equal(alice.quotaCalls, 1);
    assert.equal(alice.started, 1, "fresh logged-in cache should avoid starting Copilot SDK");

    const bob = { started: 0, stopped: 0, quotaCalls: 0 };
    const bobQuota = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      sdkModule: makeSdk(
        {
          quotaSnapshots: {
            chat: {
              entitlementRequests: 10,
              usedRequests: 8,
              remainingPercentage: 20,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        },
        bob,
        { isAuthenticated: true, authType: "user", host: "github.com", login: "bob" },
      ),
    });
    assert.equal(bobQuota.source, "fresh");
    assert.equal(bobQuota.chat?.remainingPercent, 20);
    assert.equal(bob.quotaCalls, 1, "bypassing the TTL should refresh the authenticated identity");
  });
});

test("getCopilotQuota defaults to logged-in auth and ignores GitHub token env", async () => {
  await withTmp(async (dir) => {
    const previous = {
      COPILOT_GITHUB_TOKEN: process.env.COPILOT_GITHUB_TOKEN,
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    };
    process.env.COPILOT_GITHUB_TOKEN = "copilot-env-token";
    process.env.GH_TOKEN = "gh-env-token";
    process.env.GITHUB_TOKEN = "github-env-token";

    try {
      const state = { started: 0, stopped: 0, quotaCalls: 0 };
      const captured: any[] = [];
      const sdkModule = makeSdk(
        {
          quotaSnapshots: {
            chat: {
              entitlementRequests: 10,
              usedRequests: 3,
              remainingPercentage: 70,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        },
        state,
        { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" },
        captured,
      );

      const first = await getCopilotQuota({ cacheDir: dir, ttlSeconds: 60, sdkModule });
      assert.equal(first.source, "fresh");
      assert.equal(first.chat?.remainingPercent, 70);
      assert.equal(captured[0]?.gitHubToken, undefined);
      assert.equal(captured[0]?.useLoggedInUser, true);
      assert.equal(captured[0]?.env?.COPILOT_GITHUB_TOKEN, undefined);
      assert.equal(captured[0]?.env?.GH_TOKEN, undefined);
      assert.equal(captured[0]?.env?.GITHUB_TOKEN, undefined);

      const second = await getCopilotQuota({
        cacheDir: dir,
        ttlSeconds: 60,
        sdkModule: makeSdk({ quotaSnapshots: {} }, state, undefined, captured),
      });
      assert.equal(second.source, "cached");
      assert.equal(state.started, 1, "fresh logged-in cache should avoid a second SDK start");
    } finally {
      restoreEnv("COPILOT_GITHUB_TOKEN", previous.COPILOT_GITHUB_TOKEN);
      restoreEnv("GH_TOKEN", previous.GH_TOKEN);
      restoreEnv("GITHUB_TOKEN", previous.GITHUB_TOKEN);
    }
  });
});

test("getCopilotQuota keeps explicit COPILOT_CLI_PATH env instead of overriding cliPath", async () => {
  await withTmp(async (dir) => {
    const state = { started: 0, stopped: 0, quotaCalls: 0 };
    const captured: any[] = [];
    const result = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      sdkModule: makeSdk(
        {
          quotaSnapshots: {
            chat: {
              entitlementRequests: 10,
              usedRequests: 1,
              remainingPercentage: 90,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        },
        state,
        { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" },
        captured,
      ),
      clientOptions: {
        env: { COPILOT_CLI_PATH: "/custom/copilot" },
      },
    });

    assert.equal(result.source, "fresh");
    assert.equal(captured[0]?.cliPath, undefined);
    assert.equal(captured[0]?.env?.COPILOT_CLI_PATH, "/custom/copilot");
  });
});

test("getCopilotQuota does not reuse logged-in cache when SDK auth lacks login", async () => {
  await withTmp(async (dir) => {
    const alice = { started: 0, stopped: 0, quotaCalls: 0 };
    const aliceSdk = makeSdk(
      {
        quotaSnapshots: {
          chat: {
            entitlementRequests: 10,
            usedRequests: 2,
            remainingPercentage: 80,
            overage: 0,
            overageAllowedWithExhaustedQuota: false,
          },
        },
      },
      alice,
      { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" },
    );

    const first = await getCopilotQuota({ cacheDir: dir, ttlSeconds: 60, sdkModule: aliceSdk });
    assert.equal(first.source, "fresh");
    assert.equal(first.chat?.remainingPercent, 80);

    const unknown = { started: 0, stopped: 0, quotaCalls: 0 };
    const second = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      sdkModule: makeSdk(
        {
          quotaSnapshots: {
            chat: {
              entitlementRequests: 10,
              usedRequests: 5,
              remainingPercentage: 50,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        },
        unknown,
        { isAuthenticated: true, authType: "user", host: "github.com" },
      ),
    });
    assert.equal(second.source, "fresh");
    assert.equal(second.chat?.remainingPercent, 50);

    const thirdState = { started: 0, stopped: 0, quotaCalls: 0 };
    const third = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 60,
      sdkModule: makeSdk(
        {
          quotaSnapshots: {
            chat: {
              entitlementRequests: 10,
              usedRequests: 6,
              remainingPercentage: 40,
              overage: 0,
              overageAllowedWithExhaustedQuota: false,
            },
          },
        },
        thirdState,
        { isAuthenticated: true, authType: "user", host: "github.com" },
      ),
    });
    assert.equal(third.source, "fresh");
    assert.equal(third.chat?.remainingPercent, 40);
    assert.equal(thirdState.started, 1, "missing login must not reuse a previous account cache");
  });
});

test("getCopilotQuota does not fallback to previous account cache when auth lacks login", async () => {
  await withTmp(async (dir) => {
    const alice = { started: 0, stopped: 0, quotaCalls: 0 };
    const aliceSdk = makeSdk(
      {
        quotaSnapshots: {
          chat: {
            entitlementRequests: 10,
            usedRequests: 2,
            remainingPercentage: 80,
            overage: 0,
            overageAllowedWithExhaustedQuota: false,
          },
        },
      },
      alice,
      { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" },
    );

    const first = await getCopilotQuota({ cacheDir: dir, ttlSeconds: 60, sdkModule: aliceSdk });
    assert.equal(first.source, "fresh");
    assert.equal(first.chat?.remainingPercent, 80);

    const unknown = { started: 0, stopped: 0, quotaCalls: 0 };
    const second = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      sdkModule: makeSdk(
        { quotaSnapshots: {} },
        unknown,
        { isAuthenticated: true, authType: "user", host: "github.com" },
      ),
    });
    assert.equal(second.source, "unknown");
    assert.match(second.error ?? "", /no quota snapshots/);
    assert.equal(second.chat, undefined);
    assert.equal(unknown.quotaCalls, 1);
  });
});

test("getCopilotQuota uses GITHUB_TOKEN to enrich login info when SDK auth lacks login", async () => {
  await withTmp(async (dir) => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "github-login-token";

    try {
      const state = { started: 0, stopped: 0, quotaCalls: 0 };
      const fetchCalls: Array<{ url: string; headers: Headers }> = [];
      const result = await getCopilotQuota({
        cacheDir: dir,
        ttlSeconds: 0,
        sdkModule: makeSdk(
          {
            quotaSnapshots: {
              chat: {
                entitlementRequests: 10,
                usedRequests: 4,
                remainingPercentage: 60,
                overage: 0,
                overageAllowedWithExhaustedQuota: false,
              },
            },
          },
          state,
          { isAuthenticated: true, authType: "user", host: "github.com" },
        ),
        fetcher: async (input, init) => {
          fetchCalls.push({
            url: String(input),
            headers: new Headers(init?.headers),
          });
          return new Response(JSON.stringify({ login: "octocat" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      });

      assert.equal(result.source, "fresh");
      assert.equal(result.login, "octocat");
      assert.equal(result.loginSource, "github_token");
      assert.equal(result.authType, "user");
      assert.equal(fetchCalls.length, 1);
      assert.equal(fetchCalls[0]?.url, "https://api.github.com/user");
      assert.equal(fetchCalls[0]?.headers.get("authorization"), "Bearer github-login-token");
      assert.equal(fetchCalls[0]?.headers.get("user-agent"), "conductor-ai-manager");
    } finally {
      restoreEnv("GITHUB_TOKEN", previousGithubToken);
    }
  });
});

test("getCopilotQuota ignores GITHUB_TOKEN lookup failures and still returns quota", async () => {
  await withTmp(async (dir) => {
    const previousGithubToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "github-login-token";

    try {
      const state = { started: 0, stopped: 0, quotaCalls: 0 };
      const result = await getCopilotQuota({
        cacheDir: dir,
        ttlSeconds: 0,
        sdkModule: makeSdk(
          {
            quotaSnapshots: {
              completions: {
                entitlementRequests: 20,
                usedRequests: 5,
                remainingPercentage: 75,
                overage: 0,
                overageAllowedWithExhaustedQuota: false,
              },
            },
          },
          state,
          { isAuthenticated: true, authType: "user", host: "github.com" },
        ),
        fetcher: async () => {
          throw new Error("lookup failed");
        },
      });

      assert.equal(result.source, "fresh");
      assert.equal(result.login, undefined);
      assert.equal(result.loginSource, undefined);
      assert.equal(result.completions?.remainingPercent, 75);
    } finally {
      restoreEnv("GITHUB_TOKEN", previousGithubToken);
    }
  });
});

test("getCopilotQuota falls back to copilot_internal/user when SDK quota snapshots are empty", async () => {
  await withTmp(async (dir) => {
    const state = { started: 0, stopped: 0, quotaCalls: 0 };
    const fetchCalls: Array<{ url: string; headers: Headers }> = [];
    const result = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      sdkModule: makeSdk(
        { quotaSnapshots: {} },
        state,
        { isAuthenticated: true, authType: "user", host: "https://github.com", login: "alice" },
      ),
      storedTokenResolver: async () => "copilot-token",
      fetcher: async (input, init) => {
        fetchCalls.push({
          url: String(input),
          headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify({
          login: "alice",
          access_type_sku: "free_limited_copilot",
          limited_user_quotas: {
            chat: 470,
            completions: 4000,
          },
          monthly_quotas: {
            chat: 500,
            completions: 4000,
          },
          limited_user_reset_date: "2026-05-17",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    assert.equal(result.source, "fresh");
    assert.equal(result.login, "alice");
    assert.equal(result.chat?.remainingPercent, 94);
    assert.equal(result.chat?.remaining, 470);
    assert.equal(result.completions?.remainingPercent, 100);
    assert.equal(result.error, undefined);
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "https://api.github.com/copilot_internal/user");
    assert.equal(fetchCalls[0]?.headers.get("authorization"), "Bearer copilot-token");
    assert.equal(fetchCalls[0]?.headers.get("user-agent"), "conductor-ai-manager");
  });
});

test("getCopilotQuota fetches through SDK RPC and returns cached quota", async () => {
  await withTmp(async (dir) => {
    const state = { started: 0, stopped: 0 };
    const sdkModule = makeSdk(
      {
        quotaSnapshots: {
          premium_interactions: {
            entitlementRequests: 50,
            usedRequests: 5,
            remainingPercentage: 90,
            overage: 0,
            overageAllowedWithExhaustedQuota: false,
          },
        },
      },
      state,
    );

    const first = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 60,
      sdkModule,
      clientOptions: { gitHubToken: "token-a" },
    });
    assert.equal(first.source, "fresh");
    assert.equal(first.primary?.remainingPercent, 90);
    assert.equal(state.started, 1);
    assert.equal(state.stopped, 1);

    const second = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 60,
      sdkModule: makeSdk({ quotaSnapshots: {} }, state),
      clientOptions: { gitHubToken: "token-a" },
    });
    assert.equal(second.source, "cached");
    assert.equal(second.primary?.remainingPercent, 90);
    assert.equal(state.started, 1, "fresh cache should avoid starting Copilot SDK");
  });
});

test("getCopilotQuota returns stale cache when SDK fetch fails", async () => {
  await withTmp(async (dir) => {
    const state = { started: 0, stopped: 0 };
    const sdkModule = makeSdk(
      {
        quotaSnapshots: {
          chat: {
            entitlementRequests: 10,
            usedRequests: 2,
            remainingPercentage: 80,
            overage: 0,
            overageAllowedWithExhaustedQuota: false,
          },
        },
      },
      state,
    );

    const first = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 60,
      sdkModule,
      clientOptions: { gitHubToken: "token-b" },
    });
    assert.equal(first.source, "fresh");

    const failingSdk = {
      CopilotClient: class {
        rpc = { account: { getQuota: async () => ({ quotaSnapshots: {} }) } };

        async start() {
          throw new Error("auth failed");
        }

        async stop() {
          return [];
        }
      },
    } as any;

    const second = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      forceRefresh: true,
      sdkModule: failingSdk,
      clientOptions: { gitHubToken: "token-b" },
    });
    assert.equal(second.source, "stale");
    assert.match(second.error ?? "", /auth failed/);
    assert.equal(second.chat?.remainingPercent, 80);
  });
});

test("getCopilotQuota applies one deadline across SDK start/auth/quota", async () => {
  await withTmp(async (dir) => {
    const state = { started: 0, stopped: 0, quotaCalls: 0 };
    const realDateNow = Date.now;
    let nowMs = 1_000_000;
    const sdkModule = {
      CopilotClient: class {
        rpc = {
          account: {
            getQuota: async () => {
              state.quotaCalls += 1;
              return { quotaSnapshots: {} };
            },
          },
        };

        async start() {
          state.started += 1;
          nowMs += 20;
        }

        async stop() {
          state.stopped += 1;
          return [];
        }

        async getAuthStatus() {
          nowMs += 20;
          return { isAuthenticated: true, authType: "user", host: "github.com", login: "alice" };
        }
      },
    } as any;

    Date.now = () => nowMs;
    const result = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 0,
      timeoutMs: 30,
      sdkModule,
    }).finally(() => {
      Date.now = realDateNow;
    });

    assert.equal(result.source, "unknown");
    assert.match(result.error ?? "", /timed out/);
    assert.equal(state.quotaCalls, 0, "quota RPC should not start after the overall deadline is exhausted");
    assert.equal(state.stopped, 1);
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
