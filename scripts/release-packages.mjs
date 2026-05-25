#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_URL = process.env.NPM_REGISTRY_URL || "https://registry.npmjs.org";
const PUBLISH_VISIBILITY_ATTEMPTS = 12;
const PUBLISH_VISIBILITY_DELAY_MS = 5_000;

const PACKAGES = [
  { path: "modules/chat-web/package.json" },
  { path: "modules/ai-sdk/package.json" },
  { path: "modules/app-sdk/package.json" },
  { path: "modules/conductor-sdk/package.json" },
  { path: "cli/package.json", cli: true },
];

function readPackage(packageJsonPath) {
  const absolutePath = path.join(ROOT_DIR, packageJsonPath);
  const raw = fs.readFileSync(absolutePath, "utf8");
  const pkg = JSON.parse(raw);
  return {
    ...pkg,
    packageJsonPath,
    absolutePath,
  };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
  }).trim();
}

function npm(args, options = {}) {
  return execFileSync("npm", args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : "pipe",
    env: {
      ...process.env,
      npm_config_registry: REGISTRY_URL,
    },
  }).trim();
}

async function packageVersionExists(name, version) {
  const encodedName = encodeURIComponent(name);
  const response = await fetch(`${REGISTRY_URL}/${encodedName}/${version}`);
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(`Failed to query npm for ${name}@${version}: ${response.status} ${response.statusText}`);
  }
  return true;
}

async function waitForPackageVersion(name, version) {
  for (let attempt = 1; attempt <= PUBLISH_VISIBILITY_ATTEMPTS; attempt += 1) {
    if (await packageVersionExists(name, version)) {
      return true;
    }
    if (attempt < PUBLISH_VISIBILITY_ATTEMPTS) {
      console.warn(
        `[release-packages] ${name}@${version} is not visible on npm yet; retrying ` +
          `in ${PUBLISH_VISIBILITY_DELAY_MS / 1000}s (${attempt}/${PUBLISH_VISIBILITY_ATTEMPTS}).`,
      );
      await new Promise((resolve) => setTimeout(resolve, PUBLISH_VISIBILITY_DELAY_MS));
    }
  }
  return false;
}

async function getPendingPackages() {
  const packages = PACKAGES.map((entry) => readPackage(entry.path)).filter((pkg) => pkg.private !== true);
  const pending = [];

  for (const pkg of packages) {
    const exists = await packageVersionExists(pkg.name, pkg.version);
    if (!exists) {
      pending.push(pkg);
    }
  }

  return pending;
}

function updateGitCommitIds(packages) {
  if (packages.length === 0) {
    return;
  }

  const commitId = (process.env.GITHUB_SHA || git(["rev-parse", "HEAD"])).slice(0, 7);
  for (const pkg of packages) {
    if (!Object.prototype.hasOwnProperty.call(pkg, "gitCommitId")) {
      continue;
    }

    const nextPkg = JSON.parse(fs.readFileSync(pkg.absolutePath, "utf8"));
    nextPkg.gitCommitId = commitId;
    fs.writeFileSync(pkg.absolutePath, `${JSON.stringify(nextPkg, null, 2)}\n`);
  }
}

function writeGitHubOutput(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  const lines = [];
  for (const [key, value] of Object.entries(outputs)) {
    lines.push(`${key}=${value}`);
  }
  fs.appendFileSync(outputPath, `${lines.join("\n")}\n`);
}

async function statusCommand() {
  const pending = await getPendingPackages();
  const result = {
    pending: pending.map(({ name, version, packageJsonPath }) => ({
      name,
      version,
      packageJsonPath,
    })),
  };

  writeGitHubOutput({
    pending_count: String(result.pending.length),
    pending_names: result.pending.map((pkg) => pkg.name).join(","),
    cli_version: result.pending.find((pkg) => pkg.name === "@love-moon/conductor-cli")?.version || "",
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function publishCommand() {
  const pending = await getPendingPackages();
  if (pending.length === 0) {
    writeGitHubOutput({
      published: "false",
      pending_count: "0",
      pending_names: "",
      cli_version: "",
    });
    console.log("No unpublished package versions found.");
    return;
  }

  updateGitCommitIds(pending);

  console.log(
    `Publishing ${pending.length} package(s): ${pending.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ")}`,
  );

  // changeset publish has been observed to exit non-zero in the 0.3.0
  // release even though every targeted version reached npm — likely a
  // post-publish step (e.g. token attestation parse, summary print) that
  // is non-essential to the actual artifact upload. The downstream tag
  // and archive-dispatch steps must still run as long as the packages
  // actually shipped, otherwise an operator has to push tags by hand.
  //
  // Catch the spawn failure here, then derive the published set from direct
  // npm registry probes. A freshly-published scoped version can take several
  // seconds to become visible on the exact-version endpoint, so post-publish
  // confirmation retries for a bounded interval before declaring it missing.
  // If everything is on npm we log a warning and continue so GitHub Actions
  // outputs get set and the next step (cli-release-archives dispatch) fires.
  // `--no-git-tag` skips changesets' default behavior of running
  // `git tag <pkg>@<version> -m <msg>` after each successful publish.
  // Annotated tag creation requires `user.name` / `user.email` to be
  // configured on the runner; GitHub Actions doesn't set those, so the
  // tag step throws "Please tell me who you are" and trips changesets'
  // exit status — even though every package already reached npm. The
  // per-package tags it would create (e.g. `@love-moon/conductor-cli@0.3.0`)
  // are local-only anyway: this repo only pushes the unified `vX.Y.Z`
  // tag via scripts/dispatch-cli-release-archive.sh, so the per-package
  // tags would be dead weight even if they did get created.
  let changesetSpawnError = null;
  try {
    npm(["exec", "--", "changeset", "publish", "--no-git-tag"], { capture: false });
  } catch (error) {
    changesetSpawnError = error;
    console.warn(
      `[release-packages] changeset publish exited non-zero: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const stillMissing = [];
  const confirmed = [];
  for (const pkg of pending) {
    const exists = await waitForPackageVersion(pkg.name, pkg.version);
    if (exists) {
      confirmed.push(pkg);
    } else {
      stillMissing.push(pkg);
    }
  }

  writeGitHubOutput({
    published: confirmed.length > 0 ? "true" : "false",
    pending_count: String(confirmed.length),
    pending_names: confirmed.map((pkg) => pkg.name).join(","),
    cli_version: confirmed.find((pkg) => pkg.name === "@love-moon/conductor-cli")?.version || "",
  });

  if (stillMissing.length > 0) {
    const missing = stillMissing.map((pkg) => `${pkg.name}@${pkg.version}`).join(", ");
    throw new Error(`Publish completed without these versions reaching npm: ${missing}`);
  }

  if (changesetSpawnError) {
    console.warn(
      "[release-packages] changeset publish reported a non-zero exit but every pending package is on npm; continuing so tag + archive dispatch can run.",
    );
  }
}

const command = process.argv[2];

if (command === "status") {
  await statusCommand();
} else if (command === "publish") {
  await publishCommand();
} else {
  console.error("Usage: node scripts/release-packages.mjs <status|publish>");
  process.exit(1);
}
