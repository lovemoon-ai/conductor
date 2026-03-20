import fs from "fs";
import path from "path";

export function loadEnv(): Record<string, string> {
  const envPath = path.join(import.meta.dirname, "../.env");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env file not found");
  }
  const content = fs.readFileSync(envPath, "utf-8");
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
    }
  }
  return env;
}
