import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetCliVersionCacheForTests, GET } from "./route";

const buildFetchResponse = (
  body: Record<string, unknown>,
  init?: { ok?: boolean; status?: number },
) => ({
  ok: init?.ok ?? true,
  status: init?.status ?? 200,
  json: async () => body,
});

describe("GET /api/cli-version", () => {
  beforeEach(() => {
    __resetCliVersionCacheForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-12T18:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fetches from npm registry on cache miss and returns the fresh version", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      buildFetchResponse({ version: "0.3.0", gitCommitId: "abc1234" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const res = await GET();
    const data = await res.json();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@love-moon/conductor-cli/latest",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(data.version).toBe("0.3.0");
    expect(data.gitCommitId).toBe("abc1234");
    expect(data.source).toBe("registry");
    expect(data.fetchedAt).toBe("2026-05-12T18:00:00.000Z");
  });

  it("serves subsequent requests from the in-memory cache within the TTL window", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      buildFetchResponse({ version: "0.3.0", gitCommitId: "abc1234" }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const first = await (await GET()).json();
    vi.advanceTimersByTime(60_000); // 1 minute later, still within TTL
    const second = await (await GET()).json();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(first.source).toBe("registry");
    expect(second.source).toBe("cache");
    expect(second.version).toBe("0.3.0");
    expect(second.fetchedAt).toBe("2026-05-12T18:00:00.000Z");
  });

  it("re-fetches from the registry after the TTL elapses", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        buildFetchResponse({ version: "0.3.0", gitCommitId: "abc" }),
      )
      .mockResolvedValueOnce(
        buildFetchResponse({ version: "0.3.1", gitCommitId: "def" }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await GET();
    vi.advanceTimersByTime(6 * 60 * 1000); // 6 minutes — past the 5-minute TTL
    const refreshed = await (await GET()).json();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(refreshed.version).toBe("0.3.1");
    expect(refreshed.source).toBe("registry");
  });

  it("falls back to the build-time env vars on the first failure (no cache yet)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
    );
    vi.stubEnv("NEXT_PUBLIC_CLI_VERSION", "0.2.42");
    vi.stubEnv("NEXT_PUBLIC_GIT_COMMIT_ID", "fallback-sha");

    const res = await GET();
    const data = await res.json();

    expect(data.version).toBe("0.2.42");
    expect(data.gitCommitId).toBe("fallback-sha");
    expect(data.source).toBe("fallback");
    expect(data.error).toContain("ENOTFOUND");
  });

  it("returns the last successful cache when the next refetch fails (stale-cache)", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        buildFetchResponse({ version: "0.3.0", gitCommitId: "good" }),
      )
      .mockRejectedValueOnce(new Error("registry 503"));
    vi.stubGlobal("fetch", fetchSpy);

    await GET(); // primes cache with 0.3.0
    vi.advanceTimersByTime(6 * 60 * 1000); // force TTL to expire

    const data = await (await GET()).json();
    expect(data.version).toBe("0.3.0");
    expect(data.gitCommitId).toBe("good");
    expect(data.source).toBe("stale-cache");
    expect(data.error).toContain("503");
  });

  it("falls back when the registry responds with a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        buildFetchResponse(
          { error: "not found" },
          { ok: false, status: 404 },
        ),
      ),
    );
    vi.stubEnv("NEXT_PUBLIC_CLI_VERSION", "0.2.42");

    const data = await (await GET()).json();
    expect(data.source).toBe("fallback");
    expect(data.version).toBe("0.2.42");
    expect(data.error).toContain("404");
  });

  it("treats missing/empty registry fields as 'unknown'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(buildFetchResponse({})),
    );

    const data = await (await GET()).json();
    expect(data.version).toBe("unknown");
    expect(data.gitCommitId).toBe("unknown");
    expect(data.source).toBe("registry");
  });
});
