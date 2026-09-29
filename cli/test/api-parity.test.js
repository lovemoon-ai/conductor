/**
 * CLI ↔ web API parity guard.
 *
 * Every `web/src/app/api/**\/route.ts` handler must be listed in
 * `cli/api-parity.json`, either with the CLI command that does the same thing or
 * with a reason the CLI skips it. So a new route (or a new method on an existing
 * route) fails here until someone decides how the CLI covers it, and a stale
 * entry fails when its route goes away.
 *
 * Each mapped command is checked for real: `conductor <command> --help` must
 * print that command's own usage line (an unknown verb falls back to the
 * parent's `conductor task <command>` usage and fails).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "..");
const apiRoot = path.resolve(cliRoot, "../web/src/app/api");
const manifestPath = path.join(cliRoot, "api-parity.json");
const cliEntry = path.join(cliRoot, "bin/conductor.js");

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function findRouteFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === "route.ts" || entry.name === "route.js") out.push(full);
  }
  return out;
}

/** Methods a Next.js route module exports: `export async function GET`, `export const GET =`, `export { GET }`. */
export function exportedMethods(source) {
  const methods = new Set();
  const direct = /export\s+(?:async\s+)?(?:function|const|let)\s+([A-Z]+)\b/g;
  for (const match of source.matchAll(direct)) {
    if (HTTP_METHODS.includes(match[1])) methods.add(match[1]);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (HTTP_METHODS.includes(name)) methods.add(name);
    }
  }
  return [...methods];
}

function collectRoutes() {
  const keys = [];
  for (const file of findRouteFiles(apiRoot)) {
    const rel = path.relative(apiRoot, path.dirname(file)).split(path.sep).join("/");
    const routePath = rel ? `/api/${rel}` : "/api";
    for (const method of exportedMethods(fs.readFileSync(file, "utf8"))) {
      keys.push(`${method} ${routePath}`);
    }
  }
  return keys.sort();
}

function runHelp(commandWords) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliEntry, ...commandWords, "--help"],
      // No update check / config lookups: help must not touch the network.
      { env: { ...process.env, CONDUCTOR_SKIP_UPDATE_CHECK: "1" }, timeout: 30_000 },
      (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) }),
    );
  });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

const hasWeb = fs.existsSync(apiRoot);

describe("CLI / web API parity manifest", { skip: hasWeb ? false : "web/ is not next to cli/ (published package)" }, () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entries = manifest.routes || {};

  it("parses every export style Next.js routes use", () => {
    assert.deepEqual(
      exportedMethods("export async function GET() {}\nexport const POST = wrap(x);\nexport { handler as PATCH, DELETE };").sort(),
      ["DELETE", "GET", "PATCH", "POST"],
    );
  });

  it("lists every API route and method", () => {
    const missing = collectRoutes().filter((key) => !(key in entries));
    assert.deepEqual(
      missing,
      [],
      "New API routes need an entry in cli/api-parity.json: map them to the CLI command that does the same "
        + "thing (add the command first), or give a `skip` reason.",
    );
  });

  it("has no entries for routes that no longer exist", () => {
    const routes = new Set(collectRoutes());
    const stale = Object.keys(entries).filter((key) => !routes.has(key));
    assert.deepEqual(stale, [], "Remove these stale entries from cli/api-parity.json");
  });

  it("gives every entry exactly one of `cli` or a non-empty `skip` reason", () => {
    const bad = Object.entries(entries).filter(([, value]) => {
      const hasCli = typeof value?.cli === "string" && value.cli.trim() !== "";
      const hasSkip = typeof value?.skip === "string" && value.skip.trim() !== "";
      return hasCli === hasSkip;
    }).map(([key]) => key);
    assert.deepEqual(bad, []);
  });

  it("maps to CLI commands that exist", async () => {
    const commands = [...new Set(Object.values(entries).map((value) => value.cli).filter(Boolean))].sort();
    const results = await mapLimit(commands, 8, async (command) => {
      const words = command.trim().split(/\s+/);
      const { code, stdout, stderr } = await runHelp(words);
      const firstLine = (stdout || stderr).split("\n").map((line) => line.trim()).find(Boolean) || "";
      const usage = firstLine.replace(/^Usage:\s*/, "");
      const expected = `conductor ${words.join(" ")}`;
      const ok = code === 0 && (usage === expected || usage.startsWith(`${expected} `));
      return ok ? null : `${command} -> exit ${code}: ${firstLine}`;
    });
    assert.deepEqual(results.filter(Boolean), [], "These cli commands in api-parity.json do not exist");
  });
});
