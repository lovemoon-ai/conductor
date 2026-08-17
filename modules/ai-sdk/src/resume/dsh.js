import { promises as fsp } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { defaultDshSessionRoot } from "../providers/dsh-sdk-session.js";
import {
  buildResumeContext,
  isExistingDirectory,
  normalizeSessionId,
} from "./shared.js";

export const BACKEND = "dsh";

/**
 * dsh sessions persist as JSONL logs written by the runtime's
 * `@deepseek-ai/dsh-session-persistence-jsonl` plugin under the session root
 * DshSdkSession sets via DSH_SESSION_ROOT:
 *
 *   <root>/<projectKey(cwd)>/<sessionId>/session.jsonl
 *
 * The first line of session.jsonl is a `{"type":"session",...}` header that
 * carries the workspace `cwd`, which is what resume needs back.
 */

export function buildCliArgs(sessionId) {
  // dsh has no standalone CLI resume command inside conductor (the runtime is
  // relaunched by DshSdkSession through the SDK client), but the resume
  // contract requires a stable arg vector; consumers ignore it for dsh.
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return [`--resume-session-id=${normalizedSessionId}`];
}

function resolveSessionRoot(options = {}) {
  if (typeof options.dshSessionRoot === "string" && options.dshSessionRoot.trim()) {
    return options.dshSessionRoot.trim();
  }
  return defaultDshSessionRoot();
}

export async function findSessionPath(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const root = resolveSessionRoot(options);
  let projectEntries = [];
  try {
    projectEntries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory()) {
      continue;
    }
    const sessionDir = path.join(root, projectEntry.name, normalizedSessionId);
    for (const filename of ["session.jsonl", "session.jsonl.zstd"]) {
      const candidate = path.join(sessionDir, filename);
      try {
        const stats = await fsp.stat(candidate);
        if (stats.isFile()) {
          return candidate;
        }
      } catch {
        // keep scanning
      }
    }
  }
  return null;
}

async function readHeaderLine(sessionPath) {
  if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
    return null;
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
  } finally {
    rl.close();
  }
  return null;
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const sessionPath = await findSessionPath(normalizedSessionId, options);
  if (!sessionPath) {
    throw new Error(`Invalid --resume session id for dsh: ${normalizedSessionId}`);
  }
  const header = await readHeaderLine(sessionPath);
  const cwdFromHeader =
    header && header.type === "session" && typeof header.cwd === "string" && header.cwd.trim()
      ? header.cwd.trim()
      : "";
  const cwd =
    cwdFromHeader ||
    (typeof options?.cwd === "string" && options.cwd.trim() ? options.cwd.trim() : "");
  if (!cwd) {
    throw new Error(`Could not resolve workspace for dsh session ${normalizedSessionId}`);
  }
  if (!(await isExistingDirectory(cwd))) {
    throw new Error(`Resume workspace path does not exist: ${cwd}`);
  }
  return buildResumeContext({
    provider: "dsh",
    sessionId: normalizedSessionId,
    sessionPath,
    cwd,
    cwdSource: cwdFromHeader ? "session" : "options_cwd",
  });
}
