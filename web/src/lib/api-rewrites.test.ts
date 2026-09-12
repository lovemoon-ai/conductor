import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";
import nextConfig from "../../next.config";
import { apiRewrites, resolveRewrittenApiPath } from "./api-rewrites";

const repoRoot = path.join(__dirname, "..", "..", "..");

/**
 * Callers that address this app with UNPREFIXED paths (`/tasks`,
 * `/agent/events`, ...) and rely on the rewrite table to reach the real
 * `/api/...` route.
 */
const CALLER_FILES = [
  "modules/conductor-sdk/src/backend/client.ts",
  "cli/src/daemon.js",
];

/**
 * Static leading path of each backend call: `this.request(METHOD, PATH)` in the
 * SDK client, and `${backendUrl}/path` string-building in the CLI.
 */
const collectBackendPaths = (source: string): { paths: string[]; dropped: string[] } => {
  const paths = new Set<string>();
  const dropped: string[] = [];

  const patterns = [
    /this\.request\(\s*['"][A-Z]+['"]\s*,\s*(['"`])([^'"`]*)/g,
    /\$\{[^}]*[Bb]ackendUrl[^}]*\}([^'"`]*)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[match.length - 1];
      // Template literals stop at the first interpolation: `/tasks/${id}/group`
      // contributes `/tasks/`, which is what a rewrite has to match.
      const literal = raw.split("${")[0];
      if (literal.startsWith("/")) {
        paths.add(literal.replace(/\/$/, "") || "/");
      } else if (raw.startsWith("${")) {
        // A path that opens with an interpolation yields no static prefix, so
        // this check cannot see it. Surface it instead of silently passing.
        dropped.push(match[0]);
      }
    }
  }
  return { paths: [...paths], dropped };
};

describe("api rewrite aliases", () => {
  test("cover every unprefixed path a backend caller builds", () => {
    const allPaths: string[] = [];
    for (const relative of CALLER_FILES) {
      const source = fs.readFileSync(path.join(repoRoot, relative), "utf8");
      const { paths, dropped } = collectBackendPaths(source);
      // A dynamic path prefix would slip past this guard unchecked.
      expect(dropped, `${relative} builds a path with no static prefix`).toEqual([]);
      allPaths.push(...paths);
    }
    expect(allPaths.length).toBeGreaterThan(0);

    // Every path must resolve to a real `/api/...` route, either because the
    // caller already wrote the prefix or because an alias supplies it.
    const unresolved = allPaths.filter(
      (p) => !resolveRewrittenApiPath(p).startsWith("/api/"),
    );
    expect(unresolved).toEqual([]);
  });

  test("next.config serves exactly the shared alias table", async () => {
    const rewrites = await nextConfig.rewrites!();
    expect(rewrites).toEqual(apiRewrites());

    // A typo'd destination would still match its source, so check the mapping
    // itself rather than only that an entry exists.
    for (const { source, destination } of rewrites as Array<{
      source: string;
      destination: string;
    }>) {
      expect(destination).toBe(`/api${source}`);
    }
  });

  test("leaves paths no alias claims alone, so the SDK's 404 probe still works", () => {
    expect(resolveRewrittenApiPath("/nope/t1")).toBe("/nope/t1");
    expect(resolveRewrittenApiPath("/api/tasks/t1")).toBe("/api/tasks/t1");
    // Not a prefix match: `/tasksfoo` is a different route than `/tasks`.
    expect(resolveRewrittenApiPath("/tasksfoo")).toBe("/tasksfoo");
  });

  test("resolves the aliases that were missing a rewrite", () => {
    expect(resolveRewrittenApiPath("/agent/events")).toBe("/api/agent/events");
    expect(resolveRewrittenApiPath("/issues")).toBe("/api/issues");
    expect(resolveRewrittenApiPath("/agents/host/exec")).toBe("/api/agents/host/exec");
  });
});
