import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getKimiQuota, refreshKimiToken, type KimiCredential } from "../src/quota/kimi.ts";

interface FetchCall {
  url: string;
  method?: string;
  body?: string;
  authorization?: string;
}

function makeFetcher(
  responder: (call: FetchCall) => { status: number; body: any },
): { fetcher: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = (async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    const headers = new Headers(init?.headers ?? {});
    const authorization = headers.get("authorization") ?? undefined;
    calls.push({ url, method, body, authorization });
    const { status, body: payload } = responder({ url, method, body, authorization });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

function withTmp<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-kimi-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86_400;
const ALREADY_EXPIRED = Math.floor(Date.now() / 1000) - 60;

test("refreshKimiToken throws when refresh_token is empty", async () => {
  const cred: KimiCredential = {
    access_token: "at",
    refresh_token: "",
    expires_at: ALREADY_EXPIRED,
  };
  await assert.rejects(
    () => refreshKimiToken(cred, "/tmp/whatever.json", 5000, async () => new Response("")),
    /missing refresh_token/,
  );
});

test("refreshKimiToken raises when the OAuth endpoint rejects", async () => {
  const { fetcher } = makeFetcher(() => ({
    status: 400,
    body: { error: "invalid_grant" },
  }));
  const cred: KimiCredential = {
    access_token: "at",
    refresh_token: "rt",
    expires_at: ALREADY_EXPIRED,
  };
  await withTmp(async (dir) => {
    const path = join(dir, "cred.json");
    writeFileSync(path, JSON.stringify(cred));
    await assert.rejects(
      () => refreshKimiToken(cred, path, 5000, fetcher),
      /HTTP 400/,
    );
  });
});

test("refreshKimiToken persists new tokens and computes expires_at from expires_in", async () => {
  const { fetcher, calls } = makeFetcher(({ body }) => {
    assert.match(String(body), /grant_type=refresh_token/);
    assert.match(String(body), /refresh_token=old-rt/);
    return {
      status: 200,
      body: {
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 1800,
        token_type: "Bearer",
        scope: "kimi-code",
      },
    };
  });
  await withTmp(async (dir) => {
    const path = join(dir, "cred.json");
    const cred: KimiCredential = {
      access_token: "old-at",
      refresh_token: "old-rt",
      expires_at: ALREADY_EXPIRED,
    };
    writeFileSync(path, JSON.stringify(cred));

    const next = await refreshKimiToken(cred, path, 5000, fetcher);
    assert.equal(next.access_token, "new-at");
    assert.equal(next.refresh_token, "new-rt");
    assert.ok(next.expires_at > Math.floor(Date.now() / 1000) + 1500);

    const onDisk = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(onDisk.access_token, "new-at");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "POST");
  });
});

test("getKimiQuota refreshes proactively when access token has already expired", async () => {
  await withTmp(async (dir) => {
    const credPath = join(dir, "cred.json");
    const cacheDir = join(dir, "cache");
    writeFileSync(
      credPath,
      JSON.stringify({
        access_token: "stale-at",
        refresh_token: "rt",
        expires_at: ALREADY_EXPIRED,
      }),
    );

    const { fetcher, calls } = makeFetcher(({ url, authorization }) => {
      if (url.includes("/oauth/token")) {
        return {
          status: 200,
          body: { access_token: "fresh-at", refresh_token: "rt", expires_in: 3600 },
        };
      }
      // /usages must be hit with the freshly-refreshed token, never the stale one.
      assert.equal(authorization, "Bearer fresh-at");
      return {
        status: 200,
        body: { usage: { limit: "10", used: "3" }, limits: [] },
      };
    });

    const q = await getKimiQuota({
      credentialPath: credPath,
      cacheDir,
      ttlSeconds: 0,
      fetcher,
    });
    assert.equal(q.source, "fresh");
    assert.equal(q.weekly.used, 3);
    const persisted = JSON.parse(readFileSync(credPath, "utf8"));
    assert.equal(persisted.access_token, "fresh-at");
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        "https://auth.kimi.com/api/oauth/token",
        "https://api.kimi.com/coding/v1/usages",
      ],
    );
  });
});

test("getKimiQuota retries with a refreshed token after a 401 from /usages", async () => {
  await withTmp(async (dir) => {
    const credPath = join(dir, "cred.json");
    const cacheDir = join(dir, "cache");
    writeFileSync(
      credPath,
      JSON.stringify({
        access_token: "valid-looking-at",
        refresh_token: "rt",
        expires_at: FAR_FUTURE,
      }),
    );

    let usageCalls = 0;
    const { fetcher } = makeFetcher(({ url }) => {
      if (url.includes("/oauth/token")) {
        return {
          status: 200,
          body: { access_token: "rotated-at", refresh_token: "rt", expires_in: 3600 },
        };
      }
      usageCalls += 1;
      if (usageCalls === 1) return { status: 401, body: { error: "expired" } };
      return {
        status: 200,
        body: { usage: { limit: "100", remaining: "10" }, limits: [] },
      };
    });

    const q = await getKimiQuota({
      credentialPath: credPath,
      cacheDir,
      ttlSeconds: 0,
      fetcher,
    });
    assert.equal(q.source, "fresh");
    assert.equal(q.weekly.remaining, 10);
    assert.equal(usageCalls, 2, "usage endpoint should be retried after refresh");
  });
});

test("getKimiQuota returns stale cache marked as stale when a fresh fetch errors", async () => {
  await withTmp(async (dir) => {
    const credPath = join(dir, "cred.json");
    const cacheDir = join(dir, "cache");
    writeFileSync(
      credPath,
      JSON.stringify({
        access_token: "tok",
        refresh_token: "rt",
        expires_at: FAR_FUTURE,
      }),
    );

    // Prime the cache with a successful first call.
    const ok = makeFetcher(({ url }) => {
      if (url.includes("/oauth/token")) {
        return { status: 200, body: { access_token: "tok", refresh_token: "rt", expires_in: 3600 } };
      }
      return { status: 200, body: { usage: { limit: "10", used: "1" }, limits: [] } };
    });
    const first = await getKimiQuota({
      credentialPath: credPath,
      cacheDir,
      ttlSeconds: 60,
      fetcher: ok.fetcher,
    });
    assert.equal(first.source, "fresh");

    // Now simulate /usages returning 500 — cache should be returned stale-marked.
    const bad = makeFetcher(({ url }) => {
      if (url.includes("/oauth/token")) {
        return { status: 200, body: { access_token: "tok", refresh_token: "rt", expires_in: 3600 } };
      }
      return { status: 500, body: { error: "boom" } };
    });
    const second = await getKimiQuota({
      credentialPath: credPath,
      cacheDir,
      ttlSeconds: 0, // force-bypass cache freshness check
      forceRefresh: true,
      fetcher: bad.fetcher,
    });
    // ttlSeconds=0 makes the fallback see the cache as stale (not fresh).
    assert.equal(second.source, "stale");
    assert.match(second.error ?? "", /HTTP 500/);
    assert.equal(second.weekly.used, 1, "stale payload preserved");
  });
});

test("getKimiQuota returns unknown when no cache and no credential exists", async () => {
  await withTmp(async (dir) => {
    const q = await getKimiQuota({
      credentialPath: join(dir, "missing.json"),
      cacheDir: join(dir, "cache"),
      ttlSeconds: 0,
    });
    assert.equal(q.source, "unknown");
    assert.match(q.error ?? "", /not readable/);
  });
});
