import { CodexAppServerSession } from "./providers/codex-app-server-session.js";
import { ClaudeAgentSdkSession } from "./providers/claude-agent-sdk-session.js";
import { OpencodeSdkSession } from "./providers/opencode-sdk-session.js";

export const DEFAULT_PROVIDER_VARIANT = "codex-app-server";
export const CLAUDE_PROVIDER_VARIANT = "claude-agent-sdk";
export const OPENCODE_PROVIDER_VARIANT = "opencode-sdk";

export function normalizeBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  if (normalized === "code") {
    return "codex";
  }
  if (normalized === "claude-code") {
    return "claude";
  }
  if (normalized === "open-code" || normalized === "open_code") {
    return "opencode";
  }
  return normalized;
}

export function isSupportedBackend(backend) {
  const normalized = normalizeBackend(backend);
  return normalized === "codex" || normalized === "claude" || normalized === "opencode";
}

export function providerVariantForBackend(backend) {
  const normalized = normalizeBackend(backend);
  if (normalized === "claude") {
    return CLAUDE_PROVIDER_VARIANT;
  }
  if (normalized === "opencode") {
    return OPENCODE_PROVIDER_VARIANT;
  }
  return DEFAULT_PROVIDER_VARIANT;
}

export function assertSupportedBackend(backend) {
  const normalized = normalizeBackend(backend);
  if (normalized === "codex" || normalized === "claude" || normalized === "opencode") {
    return normalized;
  }
  throw new Error(
    `Unsupported AI SDK backend "${backend}". Only codex app-server, claude agent-sdk, and opencode sdk are supported.`,
  );
}

export function createLocalAiSession(backend, options = {}) {
  const normalized = assertSupportedBackend(backend);
  if (normalized === "claude") {
    return new ClaudeAgentSdkSession(normalized, options);
  }
  if (normalized === "opencode") {
    return new OpencodeSdkSession(normalized, options);
  }
  return new CodexAppServerSession(normalized, options);
}

export { CodexAppServerSession };
export { ClaudeAgentSdkSession };
export { OpencodeSdkSession };
