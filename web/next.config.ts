import type { NextConfig } from "next";
import nextra from "nextra";
import fs from "node:fs";
import path from "node:path";
import { apiRewrites } from "./src/lib/api-rewrites";

const withNextra = nextra({
  contentDirBasePath: "/docs",
});

interface CliPackageInfo {
  version?: string;
  gitCommitId?: string;
}

function resolveCliPackageInfo(): CliPackageInfo {
  const envVersion = process.env.NEXT_PUBLIC_CLI_VERSION?.trim();

  try {
    const cliPackagePath = path.resolve(process.cwd(), "../cli/package.json");
    const cliPackageRaw = fs.readFileSync(cliPackagePath, "utf8");
    const cliPackage = JSON.parse(cliPackageRaw) as CliPackageInfo;

    return {
      version: envVersion || cliPackage.version?.trim() || "unknown",
      gitCommitId: cliPackage.gitCommitId?.trim() || "unknown",
    };
  } catch (error) {
    console.warn("[next.config] Failed to read CLI package info:", error);
    return {
      version: envVersion || "unknown",
      gitCommitId: "unknown",
    };
  }
}

const cliInfo = resolveCliPackageInfo();

const nextConfig: NextConfig = {
  // Allow deploy-prod.sh to build into .next.build and atomically swap afterwards
  // so the live server never reads a half-written .next.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    resolveAlias: {
      "next-mdx-import-source-file": "./src/mdx-components.tsx",
    },
  },
  env: {
    NEXT_PUBLIC_CLI_VERSION: cliInfo.version,
    NEXT_PUBLIC_GIT_COMMIT_ID: cliInfo.gitCommitId,
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
  serverExternalPackages: ["@prisma/client", "prisma"],
  async rewrites() {
    return apiRewrites();
  },
};

export default withNextra(nextConfig);
