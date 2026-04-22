import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getCopilotQuota,
  parseCopilotQuotaSnapshots,
} from "../src/quota/copilot.ts";

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
      assert.equal(captured[0]?.githubToken, undefined);
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
      clientOptions: { githubToken: "token-a" },
    });
    assert.equal(first.source, "fresh");
    assert.equal(first.primary?.remainingPercent, 90);
    assert.equal(state.started, 1);
    assert.equal(state.stopped, 1);

    const second = await getCopilotQuota({
      cacheDir: dir,
      ttlSeconds: 60,
      sdkModule: makeSdk({ quotaSnapshots: {} }, state),
      clientOptions: { githubToken: "token-a" },
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
      clientOptions: { githubToken: "token-b" },
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
      clientOptions: { githubToken: "token-b" },
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
