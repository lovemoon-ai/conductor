/**
 * Unprefixed aliases this app answers on, rewritten to their real `/api/...`
 * route by `next.config.ts`.
 *
 * They exist because `conductor-sdk`'s backend client sends most paths
 * unprefixed (`/tasks`, `/agent/events`, ...) and the Flutter app predates the
 * `/api` prefix entirely, so the aliases cannot simply be dropped.
 *
 * SECURITY: any auth decision must run on `resolveRewrittenApiPath(pathname)`,
 * never on `request.nextUrl.pathname` directly. Next restores the ORIGINAL
 * pre-rewrite URL on the request before invoking the handler, so inside a route
 * `request.nextUrl.pathname` reads `/tasks/t1`, not `/api/tasks/t1` (verified
 * against a probe route: `/agents/x` reaches the handler reporting pathname
 * `/agents/x`). A rule that keys off the `/api/` prefix is therefore bypassed
 * by simply dropping the prefix — which is what let a `daemon_share` token skip
 * `isResourceInShareScope` entirely by calling `/agents/<host>/exec` instead of
 * `/api/agents/<host>/exec`.
 *
 * Adding an alias here widens that surface, so it is deliberately one list:
 * `next.config.ts` builds its rewrite table from it and `getAuthUser` resolves
 * against it, and the two cannot drift.
 */
export const API_REWRITE_ALIASES = [
  "/auth",
  "/projects",
  "/tasks",
  "/agents",
  "/agent",
  "/issues",
] as const;

/** The rewrite table consumed by `next.config.ts`. */
export const apiRewrites = (): Array<{ source: string; destination: string }> => [
  ...API_REWRITE_ALIASES.map((alias) => ({
    source: `${alias}/:path*`,
    destination: `/api${alias}/:path*`,
  })),
  // Exact, not `/:path*`: `/api/events` is a single route with no subtree.
  { source: "/events", destination: "/api/events" },
];

/**
 * Map an incoming path to the route that will actually serve it.
 * `/tasks/t1` -> `/api/tasks/t1`. Paths no rewrite touches come back unchanged,
 * so a genuine non-API path stays non-API and still 404s at Next's router.
 */
export const resolveRewrittenApiPath = (pathname: string): string => {
  if (pathname === "/api" || pathname.startsWith("/api/")) return pathname;
  if (pathname === "/events") return "/api/events";
  const aliased = API_REWRITE_ALIASES.some(
    (alias) => pathname === alias || pathname.startsWith(`${alias}/`),
  );
  return aliased ? `/api${pathname}` : pathname;
};
