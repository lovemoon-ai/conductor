import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findPackageVersionForEntry } from "../../src/manager/install.ts";

test("findPackageVersionForEntry returns the owning package version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-install-"));
  try {
    const pkgDir = join(dir, "node_modules", ".pnpm", "@github+copilot-sdk@0.2.2", "node_modules", "@github", "copilot-sdk");
    const entryDir = join(pkgDir, "dist", "cjs");
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@github/copilot-sdk", version: "0.2.2" }),
      "utf8",
    );
    writeFileSync(join(entryDir, "index.js"), "module.exports = {};\n", "utf8");

    const version = await findPackageVersionForEntry(
      join(entryDir, "index.js"),
      "@github/copilot-sdk",
    );
    assert.equal(version, "0.2.2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findPackageVersionForEntry skips unrelated package.json files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-manager-install-"));
  try {
    const outerDir = join(dir, "node_modules", ".pnpm", "wrapper", "node_modules");
    const pkgDir = join(outerDir, "@github", "copilot-sdk");
    const entryDir = join(pkgDir, "dist");
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(
      join(outerDir, "package.json"),
      JSON.stringify({ name: "wrapper", version: "1.0.0" }),
      "utf8",
    );
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@github/copilot-sdk", version: "0.3.1" }),
      "utf8",
    );
    writeFileSync(join(entryDir, "index.js"), "module.exports = {};\n", "utf8");

    const version = await findPackageVersionForEntry(
      join(entryDir, "index.js"),
      "@github/copilot-sdk",
    );
    assert.equal(version, "0.3.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
