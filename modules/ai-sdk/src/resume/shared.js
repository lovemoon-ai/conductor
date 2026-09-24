import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export function normalizeBackend(backend) {
  return String(backend || "").trim().toLowerCase();
}

export function normalizeSessionId(sessionId) {
  return typeof sessionId === "string" ? sessionId.trim() : "";
}

export function resolveHomeDir(options) {
  if (options?.homeDir) {
    return options.homeDir;
  }
  return os.homedir();
}

export function normalizeProjectPathCandidate(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function pathExists(targetPath, expectedType) {
  try {
    const stats = await fsp.stat(targetPath);
    if (expectedType === "file") {
      return stats.isFile();
    }
    if (expectedType === "directory") {
      return stats.isDirectory();
    }
    return true;
  } catch {
    return false;
  }
}

/** Collapses whitespace and truncates a session title for list display. */
export function normalizeSessionTitle(text, maxLength = 80) {
  const collapsed = String(text || "").replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return null;
  }
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

/**
 * Parses the head of a jsonl file (bounded by lines and bytes so multi-MB
 * session files stay cheap to inspect). Unreadable files and unparsable lines
 * are skipped.
 */
export async function readJsonlHeadEntries(filePath, maxLines = 200, maxBytes = 128 * 1024) {
  const entries = [];
  const input = fs.createReadStream(filePath, { end: maxBytes - 1 });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    let lineCount = 0;
    for await (const line of rl) {
      if (++lineCount > maxLines) {
        break;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        continue;
      }
    }
  } catch {
    // Ignore read errors; callers degrade to null cwd/title.
  } finally {
    // Close both: rl.close() alone leaves the fd open.
    rl.close();
    input.destroy();
  }
  return entries;
}

/**
 * Parses the tail of a jsonl file (last `maxBytes`); the first, possibly
 * partial, line is dropped unless the read started at the file's beginning.
 */
export async function readJsonlTailEntries(filePath, maxBytes = 64 * 1024) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    if (start > 0) {
      lines.shift();
    }
    const entries = [];
    for (const line of lines) {
      try {
        if (line.trim()) entries.push(JSON.parse(line));
      } catch {
        continue;
      }
    }
    return entries;
  } catch {
    return [];
  } finally {
    await handle?.close();
  }
}

function clipPreviewText(text, maxLength = 2000) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…` : trimmed;
}

/**
 * Session preview for the resume picker, from `{ role, text }` messages read
 * off the head and tail of a session file: the first user message, the
 * assistant text that answered it, and the session's last message.
 */
export function buildSessionPreview(headMessages, tailMessages) {
  const firstUserIndex = headMessages.findIndex((message) => message.role === "user");
  const replies = [];
  if (firstUserIndex >= 0) {
    for (const message of headMessages.slice(firstUserIndex + 1)) {
      if (message.role === "user") break;
      replies.push(message.text);
    }
  }
  const last = tailMessages[tailMessages.length - 1] || headMessages[headMessages.length - 1] || null;
  return {
    firstUserMessage: firstUserIndex >= 0 ? clipPreviewText(headMessages[firstUserIndex].text) : null,
    firstReply: clipPreviewText(replies.join("\n\n")),
    lastMessage: last ? { role: last.role, text: clipPreviewText(last.text) } : null,
  };
}

export async function isExistingDirectory(targetPath) {
  const normalizedPath = typeof targetPath === "string" ? targetPath.trim() : "";
  if (!normalizedPath) {
    return false;
  }
  try {
    const stats = await fsp.stat(normalizedPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function resolveSessionRunDirectory(sessionPath) {
  const normalizedPath = typeof sessionPath === "string" ? sessionPath.trim() : "";
  if (!normalizedPath) {
    throw new Error("Invalid session path");
  }
  let stats;
  try {
    stats = await fsp.stat(normalizedPath);
  } catch {
    throw new Error(`Session path does not exist: ${normalizedPath}`);
  }
  return stats.isDirectory() ? normalizedPath : path.dirname(normalizedPath);
}

export function listCandidateWorkingDirectories(options = {}) {
  const candidates = [];
  const push = (value) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) {
      return;
    }
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  push(options.cwd);
  push(options.currentWorkingDirectory);
  push(process.env.PWD);
  push(process.cwd());

  return candidates;
}

export async function* iterateJsonlEntries(sessionPath) {
  if (!sessionPath || !sessionPath.endsWith(".jsonl")) {
    return;
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    yield entry;
  }
}

export function buildResumeContext({
  provider,
  sessionId,
  sessionPath = null,
  cwd,
  cwdSource,
  extraDebug = {},
}) {
  return {
    provider,
    sessionId,
    sessionPath: sessionPath || null,
    cwd,
    debugMetadata: {
      cwdSource,
      sessionPath: sessionPath || null,
      ...extraDebug,
    },
  };
}
