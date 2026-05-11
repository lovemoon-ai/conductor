import {
  buildResumeContext,
  isExistingDirectory,
  listCandidateWorkingDirectories,
  normalizeProjectPathCandidate,
  normalizeSessionId,
} from "./shared.js";

export const BACKEND = "opencode";

export function buildCliArgs(sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    return [];
  }
  // opencode sessions are reattached via the SDK (`session.get({ sessionID })`),
  // not via CLI flags. We still return the canonical flag so CLI integrations
  // that need to pass a sessionId on the command line have a consistent shape.
  return ["--session", normalizedSessionId];
}

export async function findSessionPath() {
  // opencode sessions live inside the opencode server; there is no local
  // filesystem path to discover.
  return null;
}

export async function resolveResumeContext(sessionId, options = {}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error("--resume requires a session id");
  }

  const explicitCwd = normalizeProjectPathCandidate(options.cwd);
  let selectedCwd = "";
  let cwdSource = "";
  if (explicitCwd) {
    // When an explicit cwd is provided, require it to exist; do NOT fall
    // through to PWD/process.cwd() so tests and callers get a deterministic
    // result.
    if (!(await isExistingDirectory(explicitCwd))) {
      throw new Error(`Resume workspace path does not exist: ${explicitCwd}`);
    }
    selectedCwd = explicitCwd;
    cwdSource = "options_cwd";
  } else {
    for (const candidate of listCandidateWorkingDirectories(options)) {
      if (await isExistingDirectory(candidate)) {
        selectedCwd = candidate;
        cwdSource = "current_working_directory";
        break;
      }
    }
  }

  if (typeof options.resolveOpencodeCwd === "function" && !selectedCwd) {
    const resolved = await options.resolveOpencodeCwd(normalizedSessionId, options);
    const normalizedResolved = normalizeProjectPathCandidate(resolved);
    if (normalizedResolved && (await isExistingDirectory(normalizedResolved))) {
      selectedCwd = normalizedResolved;
      cwdSource = "lookup";
    }
  }

  if (!selectedCwd) {
    throw new Error(
      `Could not resolve workspace for opencode session ${normalizedSessionId}. Re-run from the original workspace.`,
    );
  }

  return buildResumeContext({
    provider: "opencode",
    sessionId: normalizedSessionId,
    sessionPath: null,
    cwd: selectedCwd,
    cwdSource: cwdSource || "current_working_directory",
  });
}
