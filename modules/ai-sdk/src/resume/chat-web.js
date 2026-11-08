import { buildResumeContext, normalizeSessionId } from "./shared.js";

export const BACKEND = "chat-web";

/**
 * Managed Kimi/DeepSeek sessions use a stable chat-web-runtime:<id> token.
 * RuntimeChatSession restores the saved isolated profile and provider URL.
 * Other chat-web modes retain their existing provider-specific resume behavior.
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
      note: normalizedSessionId.startsWith("chat-web-runtime:")
        ? "The isolated chat runtime restores this saved conversation; a missing runtime id is an error."
        : "The selected chat-web transport resolves this provider conversation id when opening.",
    },
  });
}
