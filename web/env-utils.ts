import fs from "fs";
import path from "path";
import { config as loadDotenv } from "dotenv";

export function resolveEnvCandidates(nodeEnv: string | undefined): string[] {
  if (nodeEnv === "production") {
    return [".env.production.local", ".env.local", ".env.production", ".env"];
  }
  if (nodeEnv === "test") {
    return [".env.test.local", ".env.test", ".env"];
  }
  return [".env.local", ".env.production.local", ".env.development", ".env"];
}

export function resolveEnvFile(cwd: string, nodeEnv: string | undefined = process.env.NODE_ENV): string | null {
  for (const candidate of resolveEnvCandidates(nodeEnv)) {
    const resolved = path.join(cwd, candidate);
    if (fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

export function loadAppEnv(options?: { cwd?: string; nodeEnv?: string; override?: boolean }): string | null {
  const cwd = options?.cwd ?? process.cwd();
  const nodeEnv = options?.nodeEnv ?? process.env.NODE_ENV;
  const override = options?.override ?? false;
  const envFile = resolveEnvFile(cwd, nodeEnv);
  if (!envFile) {
    return null;
  }
  loadDotenv({ path: envFile, override });
  return envFile;
}
