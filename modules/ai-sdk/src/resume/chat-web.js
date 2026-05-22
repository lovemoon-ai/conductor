import { buildResumeContext, normalizeSessionId } from "./shared.js";

export const BACKEND = "chat-web";

/**
 * chat-web's "session" is a Chromium browser context, not a conversation id.
 * There is no native resume primitive: closing and reopening produces a
 * fresh ChatSession with a new in-memory chat. We satisfy ai-sdk's resume
 * contract by surfacing a synthetic session id and a "best effort" context,
 * but downstream callers should treat resume here as a no-op.
 */

export function buildCliArgs(sessionId) {
  // chat-web has no CLI to pass these args to (it's an in-process SDK), but
  // the resume contract requires every backend to return a non-empty arg
  // vector so downstream resume dispatch stays uniform. We emit a stable,
  // recognisable token; consumers should ignore it for chat-web.
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  return [`--resume-session-id=${normalizedSessionId}`];
}

export async function findSessionPath() {
  // No on-disk JSONL session file — the persistent state lives in the
  // browser profile dir, but that's not what callers expect from this hook.
  return null;
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }
  const cwd =
    typeof options?.cwd === "string" && options.cwd.trim()
      ? options.cwd.trim()
      : process.cwd();
  return buildResumeContext({
    provider: "chat-web",
    sessionId: normalizedSessionId,
    sessionPath: null,
    cwd,
    cwdSource: "process_cwd",
    extraDebug: {
      note: "chat-web does not support cross-process conversation resume; a fresh ChatSession will be opened.",
    },
  });
}
