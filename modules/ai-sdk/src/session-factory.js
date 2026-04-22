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

export const DEFAULT_PROVIDER_VARIANT = "codex-app-server";
export const CODEX_EXEC_PROVIDER_VARIANT = "codex-exec";
export const CLAUDE_PROVIDER_VARIANT = "claude-agent-sdk";
export const COPILOT_PROVIDER_VARIANT = "copilot-sdk";
export const KIMI_PROVIDER_VARIANT = "kimi-cli-wire";
export const KIMI_PRINT_PROVIDER_VARIANT = "kimi-cli-print";
export const OPENCODE_PROVIDER_VARIANT = "opencode-sdk";

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

function normalizeBuiltInBackendName(backend) {
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
  if (normalized === "kimi-cli" || normalized === "kimi-code") {
    return "kimi";
  }
  return normalized;
}

export async function normalizeBackend(backend, options = {}) {
  const normalized = normalizeBuiltInBackendName(backend);
  if (normalized === "codex" || normalized === "claude" || normalized === "copilot" || normalized === "kimi" || normalized === "opencode") {
    return normalized;
  }
  return await resolveExternalBackend(normalized, options);
}

export async function isSupportedBackend(backend, options = {}) {
  const normalized = await normalizeBackend(backend, options);
  if (normalized === "codex" || normalized === "claude" || normalized === "copilot" || normalized === "kimi" || normalized === "opencode") {
    return true;
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  return Boolean(descriptor);
}

export async function providerVariantForBackend(backend, options = {}) {
  const normalized = await normalizeBackend(backend, options);
  if (normalized === "claude") {
    return CLAUDE_PROVIDER_VARIANT;
  }
  if (normalized === "copilot") {
    return COPILOT_PROVIDER_VARIANT;
  }
  if (normalized === "kimi") {
    return hasStructuredOutputPreference(options) ? KIMI_PRINT_PROVIDER_VARIANT : KIMI_PROVIDER_VARIANT;
  }
  if (normalized === "opencode") {
    return OPENCODE_PROVIDER_VARIANT;
  }
  if (normalized === "codex") {
    return hasStructuredOutputPreference(options) ? CODEX_EXEC_PROVIDER_VARIANT : DEFAULT_PROVIDER_VARIANT;
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  if (descriptor?.variant) {
    return descriptor.variant;
  }
  return DEFAULT_PROVIDER_VARIANT;
}

export async function assertSupportedBackend(backend, options = {}) {
  const normalized = await normalizeBackend(backend, options);
  if (normalized === "codex" || normalized === "claude" || normalized === "copilot" || normalized === "kimi" || normalized === "opencode") {
    return normalized;
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  if (descriptor) {
    return normalized;
  }
  throw new Error(
    `Unsupported AI SDK backend "${backend}". Built-in backends are codex app-server/exec, claude agent-sdk, copilot sdk, kimi cli wire/print, and opencode sdk. Set AISDK_PROVIDER_PATH to load external providers.`,
  );
}

export async function createLocalAiSession(backend, options = {}) {
  const normalized = await assertSupportedBackend(backend, options);
  if (normalized === "claude") {
    return new ClaudeAgentSdkSession(normalized, options);
  }
  if (normalized === "copilot") {
    return new CopilotSdkSession(normalized, options);
  }
  if (normalized === "kimi") {
    if (hasStructuredOutputPreference(options)) {
      return new KimiPrintSession(normalized, options);
    }
    return new KimiCliSession(normalized, options);
  }
  if (normalized === "opencode") {
    return new OpencodeSdkSession(normalized, options);
  }
  if (normalized === "codex") {
    if (hasStructuredOutputPreference(options)) {
      return new CodexExecSession(normalized, options);
    }
    return new CodexAppServerSession(normalized, options);
  }
  const descriptor = await getExternalProviderDescriptor(normalized, options);
  if (!descriptor) {
    throw new Error(`External AI SDK provider "${normalized}" is unavailable.`);
  }
  return await descriptor.createSession(normalized, options);
}

export { CodexAppServerSession };
export { CodexExecSession };
export { ClaudeAgentSdkSession };
export { CopilotSdkSession };
export { KimiCliSession };
export { KimiPrintSession };
export { OpencodeSdkSession };
