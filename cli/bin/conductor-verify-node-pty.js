#!/usr/bin/env node

import process from "node:process";

import { verifyNodePtyForPackageDirectory } from "../src/native-deps.js";

async function main() {
  const packageDirectory = process.argv[2];
  if (!packageDirectory) {
    process.stderr.write("Usage: conductor-verify-node-pty <package-directory>\n");
    process.exit(1);
    return;
  }

  await verifyNodePtyForPackageDirectory({
    packageDirectory,
  });
  process.stdout.write("Verified node-pty native binding\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
