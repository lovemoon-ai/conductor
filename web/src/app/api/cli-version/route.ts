import { NextResponse } from "next/server";

/**
 * GET /api/cli-version
 *
 * Returns the latest version of `@love-moon/conductor-cli` that's
 * actually installable today (npm registry's `latest` dist-tag),
 * not whatever `cli/package.json` happened to say when the web
 * server was built. The settings page consumes this so a web
 * deploy can lag the npm publish by hours/days without the
 * "CLI Version" line going stale.
 *
 * Caching strategy: in-memory module-level cache with a 5-minute
 * TTL. The whole point is to be fresh on the order of minutes,
 * not seconds, so we don't hammer registry.npmjs.org with one
 * request per settings-page render. A 3-second fetch timeout
 * keeps a slow registry from stalling the request.
 *
 * Fallback chain when the registry is unreachable:
 *   1. last successful cached value if we ever had one
 *   2. NEXT_PUBLIC_CLI_VERSION / NEXT_PUBLIC_GIT_COMMIT_ID
 *      (built into the web bundle from cli/package.json)
 *   3. literal "unknown"
 */

type RegistryResponse = {
  version: string;
  gitCommitId: string;
};

type CacheEntry = RegistryResponse & {
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
const TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;
const REGISTRY_URL =
  "https://registry.npmjs.org/@love-moon/conductor-cli/latest";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const buildFallback = (): RegistryResponse => ({
  version: isNonEmptyString(process.env.NEXT_PUBLIC_CLI_VERSION)
    ? process.env.NEXT_PUBLIC_CLI_VERSION!.trim()
    : "unknown",
  gitCommitId: isNonEmptyString(process.env.NEXT_PUBLIC_GIT_COMMIT_ID)
    ? process.env.NEXT_PUBLIC_GIT_COMMIT_ID!.trim()
    : "unknown",
});

async function fetchFromRegistry(): Promise<RegistryResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(new Error("npm registry timeout")),
    FETCH_TIMEOUT_MS,
  );
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      // Disable Next.js fetch caching — we manage caching ourselves so we
      // can return a `source` field and observe cache hit/miss in tests.
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`npm registry returned status ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      version: isNonEmptyString(data.version) ? data.version : "unknown",
      gitCommitId: isNonEmptyString(data.gitCommitId)
        ? data.gitCommitId
        : "unknown",
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Test helper to drop the module-level cache between cases.
 * Not exported in the public route surface — callers grab it via the
 * same module import in tests.
 */
export const __resetCliVersionCacheForTests = () => {
  cache = null;
};

export async function GET() {
  const now = Date.now();

  if (cache && now - cache.fetchedAt < TTL_MS) {
    return NextResponse.json({
      version: cache.version,
      gitCommitId: cache.gitCommitId,
      source: "cache",
      fetchedAt: new Date(cache.fetchedAt).toISOString(),
    });
  }

  try {
    const fresh = await fetchFromRegistry();
    cache = { ...fresh, fetchedAt: now };
    return NextResponse.json({
      version: fresh.version,
      gitCommitId: fresh.gitCommitId,
      source: "registry",
      fetchedAt: new Date(now).toISOString(),
    });
  } catch (error) {
    const fallback = cache ?? { ...buildFallback(), fetchedAt: 0 };
    const errMessage =
      error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        version: fallback.version,
        gitCommitId: fallback.gitCommitId,
        source: cache ? "stale-cache" : "fallback",
        error: errMessage,
        fetchedAt:
          fallback.fetchedAt > 0
            ? new Date(fallback.fetchedAt).toISOString()
            : null,
      },
      { status: 200 },
    );
  }
}
