import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { profileDir } from "./paths.js";

export const BROKER_PROTOCOL = 1;

export function brokerPaths(provider: string): { socket: string; lock: string } {
  const profile = profileDir(provider);
  fs.mkdirSync(profile, { recursive: true });
  const key = createHash("sha256").update(fs.realpathSync(profile)).digest("hex").slice(0, 24);
  let dir = path.join(os.tmpdir(), `cw-${process.getuid?.() ?? "user"}`);
  if (process.platform !== "win32" && path.join(dir, `${key}.sock`).length > 100) {
    dir = path.join("/tmp", `cw-${process.getuid?.() ?? "user"}`);
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error(`Unsafe chat-web broker directory: ${dir}`);
  }
  return {
    socket: process.platform === "win32" ? `\\.\pipe\chat-web-${key}` : path.join(dir, `${key}.sock`),
    lock: path.join(dir, `${key}.lock`),
  };
}

export interface WireError {
  name: string;
  message: string;
  code?: string;
  provider?: string;
  hint?: string;
}

export function wireError(error: unknown): WireError {
  const e = error as Partial<WireError>;
  return { name: e?.name ?? "Error", message: e?.message ?? String(error), code: e?.code, provider: e?.provider, hint: e?.hint };
}
