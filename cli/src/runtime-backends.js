export const RUNTIME_SUPPORTED_BACKENDS = ["codex", "claude", "kimi", "opencode"];

export function normalizeRuntimeBackendName(backend) {
  return String(backend || "").trim().toLowerCase();
}

export function isRuntimeSupportedBackend(backend) {
  return RUNTIME_SUPPORTED_BACKENDS.includes(normalizeRuntimeBackendName(backend));
}

export function filterRuntimeSupportedAllowCliList(allowCliList) {
  if (!allowCliList || typeof allowCliList !== "object") {
    return {};
  }

  const filtered = {};
  for (const [backend, command] of Object.entries(allowCliList)) {
    const normalizedBackend = normalizeRuntimeBackendName(backend);
    if (!RUNTIME_SUPPORTED_BACKENDS.includes(normalizedBackend)) {
      continue;
    }
    if (typeof command !== "string" || !command.trim()) {
      continue;
    }
    if (filtered[normalizedBackend] !== undefined) {
      continue;
    }
    filtered[normalizedBackend] = command;
  }
  return filtered;
}
