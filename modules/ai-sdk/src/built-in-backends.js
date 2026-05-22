/**
 * Canonical registry of built-in AI SDK backends.
 *
 * This is the single source of truth for:
 *   - backend canonical name (e.g. "codex", "claude")
 *   - accepted aliases (e.g. "code" → "codex", "kimi-cli" → "kimi")
 *   - session variants (default + structured-output variant, if any)
 *
 * Provider surfaces that need to know about built-in backends (session
 * factory, resume dispatcher, etc.) import from here so that adding a new
 * built-in backend is a one-line change in this file, plus the provider's own
 * implementation module.
 */

export const CODEX_APP_SERVER_VARIANT = "codex-app-server";
export const CODEX_EXEC_VARIANT = "codex-exec";
export const CLAUDE_AGENT_SDK_VARIANT = "claude-agent-sdk";
export const COPILOT_SDK_VARIANT = "copilot-sdk";
export const KIMI_CLI_WIRE_VARIANT = "kimi-cli-wire";
export const KIMI_CLI_PRINT_VARIANT = "kimi-cli-print";
export const OPENCODE_SDK_VARIANT = "opencode-sdk";
export const CHAT_WEB_SESSION_VARIANT = "chat-web-session";

/**
 * @typedef {Object} BuiltInBackendEntry
 * @property {string}   backend        Canonical backend name.
 * @property {string[]} aliases        All accepted aliases (INCLUDING the canonical name).
 * @property {string}   defaultVariant Variant used when no structured-output preference is set.
 * @property {string=}  structuredVariant Optional variant used when structured output is requested.
 */

/** @type {BuiltInBackendEntry[]} */
export const BUILT_IN_BACKENDS = [
  {
    backend: "codex",
    aliases: ["codex", "code"],
    defaultVariant: CODEX_APP_SERVER_VARIANT,
    structuredVariant: CODEX_EXEC_VARIANT,
  },
  {
    backend: "claude",
    aliases: ["claude", "claude-code"],
    defaultVariant: CLAUDE_AGENT_SDK_VARIANT,
  },
  {
    backend: "copilot",
    aliases: ["copilot"],
    defaultVariant: COPILOT_SDK_VARIANT,
  },
  {
    backend: "kimi",
    aliases: ["kimi", "kimi-cli", "kimi-code"],
    defaultVariant: KIMI_CLI_WIRE_VARIANT,
    structuredVariant: KIMI_CLI_PRINT_VARIANT,
  },
  {
    backend: "opencode",
    aliases: ["opencode", "open-code", "open_code"],
    defaultVariant: OPENCODE_SDK_VARIANT,
  },
  {
    backend: "chat-web",
    aliases: ["chat-web", "chatweb", "chat_web", "web-chat"],
    defaultVariant: CHAT_WEB_SESSION_VARIANT,
  },
];

const ALIAS_TO_BACKEND = new Map();
for (const entry of BUILT_IN_BACKENDS) {
  for (const alias of entry.aliases) {
    ALIAS_TO_BACKEND.set(alias, entry.backend);
  }
}

const BACKEND_SET = new Set(BUILT_IN_BACKENDS.map((entry) => entry.backend));

export function listBuiltInBackends() {
  return BUILT_IN_BACKENDS.map((entry) => entry.backend);
}

export function normalizeBuiltInBackend(backend) {
  const normalized = String(backend || "").trim().toLowerCase();
  return ALIAS_TO_BACKEND.get(normalized) || normalized;
}

export function isBuiltInBackend(backend) {
  return BACKEND_SET.has(normalizeBuiltInBackend(backend));
}

export function getBuiltInBackendEntry(backend) {
  const canonical = normalizeBuiltInBackend(backend);
  return BUILT_IN_BACKENDS.find((entry) => entry.backend === canonical) || null;
}
