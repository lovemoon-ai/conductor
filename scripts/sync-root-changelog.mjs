#!/usr/bin/env node
// Sync the latest entry from `cli/CHANGELOG.md` into the repo-root
// `/CHANGELOG.md` as a unified release-line note.
//
// Why this exists: changesets generates a per-package CHANGELOG.md inside
// each published package directory (cli/, modules/*/) and stops touching the
// root CHANGELOG.md that the project used before commit `9908414 add
// changesets release flow`. From 0.3.0 onwards the root changelog would
// otherwise become a hard-cut historical archive frozen at 0.2.42.
//
// This script keeps the root changelog as a continuous, whole-repo view
// while leaving the per-package changelogs untouched (so npm consumers still
// see the package-scoped notes inside their tarball, per the
// `files: [..., "CHANGELOG.md"]` fix in 0.3.1).
//
// Invoked automatically from `npm run release:version` (see package.json),
// which runs inside the changesets/action version step. The version-packages
// PR therefore carries the root CHANGELOG update alongside the per-package
// ones, and a human review of the PR diff catches both at once.
//
// The script is idempotent: re-running on a version already present in the
// root changelog is a no-op and exits 0. The CI workflow that triggers a
// version-packages PR refresh (e.g. when the changeset config or the
// changeset set changes) therefore stays clean.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_CHANGELOG = path.join(ROOT_DIR, "CHANGELOG.md");
const CLI_CHANGELOG = path.join(ROOT_DIR, "cli", "CHANGELOG.md");
const CLI_PACKAGE_JSON = path.join(ROOT_DIR, "cli", "package.json");

const RELEASE_PACKAGES = [
  {
    name: "@love-moon/conductor-cli",
    packageJson: CLI_PACKAGE_JSON,
    changelog: CLI_CHANGELOG,
    primary: true,
  },
  {
    name: "@love-moon/conductor-sdk",
    packageJson: path.join(ROOT_DIR, "modules", "conductor-sdk", "package.json"),
    changelog: path.join(ROOT_DIR, "modules", "conductor-sdk", "CHANGELOG.md"),
  },
  {
    name: "@love-moon/ai-sdk",
    packageJson: path.join(ROOT_DIR, "modules", "ai-sdk", "package.json"),
    changelog: path.join(ROOT_DIR, "modules", "ai-sdk", "CHANGELOG.md"),
  },
  {
    name: "@love-moon/app-sdk",
    packageJson: path.join(ROOT_DIR, "modules", "app-sdk", "package.json"),
    changelog: path.join(ROOT_DIR, "modules", "app-sdk", "CHANGELOG.md"),
  },
  {
    name: "@love-moon/chat-web",
    packageJson: path.join(ROOT_DIR, "modules", "chat-web", "package.json"),
    changelog: path.join(ROOT_DIR, "modules", "chat-web", "CHANGELOG.md"),
  },
];
const PRIMARY_PACKAGE = RELEASE_PACKAGES.find((pkg) => pkg.primary) ?? RELEASE_PACKAGES[0];

function readPackage(packageJsonPath) {
  return JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
}

function readReleasePackages() {
  return RELEASE_PACKAGES.map((pkg) => ({
    ...pkg,
    version: readPackage(pkg.packageJson).version,
  }));
}

function readVersion() {
  return readPackage(PRIMARY_PACKAGE.packageJson).version;
}

/**
 * Extract the body of the latest `## X.Y.Z` section in cli/CHANGELOG.md.
 * Returns the prose under that header, NOT including the header line
 * itself, so we can wrap it in the root changelog's `## [X.Y.Z] - <date>`
 * format.
 */
function extractChangelogSection(changelogPath, version) {
  const content = fs.readFileSync(changelogPath, "utf8");
  // changesets produces `## 0.3.1` (no `[brackets]`). Match exactly to
  // avoid grabbing a longer-prefix version like 0.3.10.
  const headerRegex = new RegExp(`^## ${version.replace(/\./g, "\\.")}\\s*$`, "m");
  const match = content.match(headerRegex);
  if (!match) {
    throw new Error(
      `${path.relative(ROOT_DIR, changelogPath)} has no '## ${version}' section. Run 'changeset version' first.`,
    );
  }
  const sectionStart = match.index + match[0].length;
  // Find the next `## ` header (next version block) or EOF.
  const after = content.slice(sectionStart);
  const nextHeader = after.match(/^## /m);
  const body = nextHeader ? after.slice(0, nextHeader.index) : after;
  return body.replace(/^\s+/, "").replace(/\s+$/, "");
}

function extractCliChangelogSection(version) {
  return extractChangelogSection(CLI_CHANGELOG, version);
}

function alreadyRecorded(version) {
  if (!fs.existsSync(ROOT_CHANGELOG)) {
    return false;
  }
  const content = fs.readFileSync(ROOT_CHANGELOG, "utf8");
  const escaped = version.replace(/\./g, "\\.");
  return new RegExp(`^## \\[${escaped}\\]`, "m").test(content);
}

function packageVersionRecorded(name, version) {
  if (!fs.existsSync(ROOT_CHANGELOG)) {
    return false;
  }
  const content = fs.readFileSync(ROOT_CHANGELOG, "utf8");
  return content.includes(`- \`${name}\` \`${version}\``);
}

function formatEntry(version, body, releasePackages) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const pkgList = releasePackages
    .map((pkg) => `- \`${pkg.name}\` \`${pkg.version}\``)
    .join("\n");
  const extraSections = releasePackages
    .filter((pkg) => !pkg.primary && pkg.version !== version)
    .map((pkg) => ({
      name: pkg.name,
      body: extractChangelogSection(pkg.changelog, pkg.version),
    }))
    .filter((section) => section.body.length > 0);
  const changes = extraSections.length === 0
    ? body
    : [
        `#### ${PRIMARY_PACKAGE.name}\n\n${body}`,
        ...extraSections.map((section) => `#### ${section.name}\n\n${section.body}`),
      ].join("\n\n");
  return `## [${version}] - ${date}

### Released packages

${pkgList}

### Changes

${changes}
`;
}

/**
 * Insert the new entry just before the first existing `## [X.Y.Z]` block
 * so versions stay newest-first. If no existing version block is found
 * (fresh changelog), append below the file's preamble.
 */
function insertEntry(entry) {
  const content = fs.readFileSync(ROOT_CHANGELOG, "utf8");
  const firstVersion = content.match(/^## \[\d+\.\d+\.\d+\]/m);
  let updated;
  if (firstVersion) {
    const insertAt = firstVersion.index;
    updated = content.slice(0, insertAt) + entry + "\n" + content.slice(insertAt);
  } else {
    updated = content.replace(/\s+$/, "\n\n") + entry + "\n";
  }
  fs.writeFileSync(ROOT_CHANGELOG, updated);
}

function main() {
  const versionArg = process.argv[2];
  const version = versionArg && versionArg !== "--auto" ? versionArg : readVersion();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`Refusing to sync a non-semver version: '${version}'`);
    process.exit(1);
  }
  if (alreadyRecorded(version)) {
    console.log(`[sync-root-changelog] version ${version} already in CHANGELOG.md, skipping.`);
    return;
  }
  const releasePackages = readReleasePackages().filter(
    (pkg) => !packageVersionRecorded(pkg.name, pkg.version),
  );
  const body = extractCliChangelogSection(version);
  const entry = formatEntry(version, body, releasePackages);
  insertEntry(entry);
  console.log(`[sync-root-changelog] appended ${version} to CHANGELOG.md`);
}

main();
