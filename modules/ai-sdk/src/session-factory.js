import {
  BUILT_IN_BACKENDS,
  CLAUDE_AGENT_SDK_VARIANT,
  CODEX_APP_SERVER_VARIANT,
  CODEX_EXEC_VARIANT,
  COPILOT_SDK_VARIANT,
  KIMI_CLI_PRINT_VARIANT,
  KIMI_CLI_WIRE_VARIANT,
  OPENCODE_SDK_VARIANT,
  getBuiltInBackendEntry,
  isBuiltInBackend,
  listBuiltInBackends,
  normalizeBuiltInBackend,
} from "./built-in-backends.js";
import { CodexAppServerSession } from "./providers/codex-app-server-session.js";
import { CodexExecSession } from "./providers/codex-exec-session.js";
import { ClaudeAgentSdkSession } from "./providers/claude-agent-sdk-session.js";
import { CopilotSdkSession } from "./providers/copilot-sdk-session.js";
import { KimiCliSession } from "./providers/kimi-cli-session.js";
import { KimiPrintSession } from "./providers/kimi-print-session.js";
import { OpencodeSdkSession } from "./providers/opencode-sdk-session.js";
import {
  getExternalProviderDescriptor,
  resolveExternalBackend,
} from "./external-provider-registry.js";

export const DEFAULT_PROVIDER_VARIANT = CODEX_APP_SERVER_VARIANT;
export const CODEX_EXEC_PROVIDER_VARIANT = CODEX_EXEC_VARIANT;
export const CLAUDE_PROVIDER_VARIANT = CLAUDE_AGENT_SDK_VARIANT;
export const COPILOT_PROVIDER_VARIANT = COPILOT_SDK_VARIANT;
export const KIMI_PROVIDER_VARIANT = KIMI_CLI_WIRE_VARIANT;
export const KIMI_PRINT_PROVIDER_VARIANT = KIMI_CLI_PRINT_VARIANT;
export const OPENCODE_PROVIDER_VARIANT = OPENCODE_SDK_VARIANT;

const SESSION_FACTORIES_BY_BACKEND = new Map([
  [
    "codex",
    (backend, options) =>
      hasStructuredOutputPreference(options)
        ? new CodexExecSession(backend, options)
        : new CodexAppServerSession(backend, options),
  ],
  ["claude", (backend, options) => new ClaudeAgentSdkSession(backend, options)],
  ["copilot", (backend, options) => new CopilotSdkSession(backend, options)],
  [
    "kimi",
    (backend, options) =>
      hasStructuredOutputPreference(options)
        ? new KimiPrintSession(backend, options)
        : new KimiCliSession(backend, options),
  ],
  ["opencode", (backend, options) => new OpencodeSdkSession(backend, options)],
]);

function hasStructuredOutputPreference(options = {}) {
  if (!options || typeof options !== "object") {
    return false;
  }
  if (options.structuredOutput === true) {
    return true;
  }
  if (options.jsonSchema && typeof options.jsonSchema === "object") {
    return true;
  }
  const outputFormat = options.outputFormat ?? options.responseFormat;
  if (typeof outputFormat === "string") {
    const normalized = outputFormat.trim().toLowerCase();
    return Boolean(normalized) && normalized !== "text";
  }
  if (outputFormat && typeof outputFormat === "object") {
    const type = typeof outputFormat.type === "string" ? outputFormat.type.trim().toLowerCase() : "";
    return type !== "text";
  }
  return false;
}

export async function normalizeBackend(backend, options = {}) {
  const normalized = normalizeBuiltInBackend(backend);
  if (isBuiltInBackend(normalized)) {
    return normalized;
  }
  return await resolveExternalBackend(normalized, options);
}

export async function isSupportedBackend(backend, options = {}) {
  const normalized = await normalizeBackend(backend, options);
  if (isBuiltInBackend(normalized)) {
    return true;
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  return Boolean(descriptor);
}

export async function providerVariantForBackend(backend, options = {}) {
  const normalized = await normalizeBackend(backend, options);
  const entry = getBuiltInBackendEntry(normalized);
  if (entry) {
    if (entry.structuredVariant && hasStructuredOutputPreference(options)) {
      return entry.structuredVariant;
    }
    return entry.defaultVariant;
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  if (descriptor?.variant) {
    return descriptor.variant;
  }
  return DEFAULT_PROVIDER_VARIANT;
}

export async function assertSupportedBackend(backend, options = {}) {
  const normalized = await normalizeBackend(backend, options);
  if (isBuiltInBackend(normalized)) {
    return normalized;
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  if (descriptor) {
    return normalized;
  }
  throw new Error(
    `Unsupported AI SDK backend "${backend}". Built-in backends are ${listBuiltInBackends().join(
      ", ",
    )}. Set AISDK_PROVIDER_PATH to load external providers.`,
  );
}

export async function createLocalAiSession(backend, options = {}) {
  const normalized = await assertSupportedBackend(backend, options);
  const factory = SESSION_FACTORIES_BY_BACKEND.get(normalized);
  if (factory) {
    return factory(normalized, options);
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  if (!descriptor) {
    throw new Error(`External AI SDK provider "${normalized}" is unavailable.`);
  }
  return await descriptor.createSession(normalized, options);
}

export { BUILT_IN_BACKENDS };
export { CodexAppServerSession };
export { CodexExecSession };
export { ClaudeAgentSdkSession };
export { CopilotSdkSession };
export { KimiCliSession };
export { KimiPrintSession };
export { OpencodeSdkSession };
