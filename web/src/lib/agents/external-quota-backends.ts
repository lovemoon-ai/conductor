// Backends whose quota the daemon reports directly under its own key; they
// must not be routed through the external-provider quota path.
const BUILT_IN_AI_BACKENDS = new Set(['codex', 'claude', 'kimi', 'copilot', 'dsh', 'deepseek-harness']);

/** The daemon's non-built-in backends, whose quota must be requested explicitly. */
export function externalQuotaBackends(backends: string[] | undefined): string[] {
  return [...new Set(
    (backends ?? []).flatMap((backend) => {
      const normalized = backend.trim().toLowerCase();
      return normalized && !BUILT_IN_AI_BACKENDS.has(normalized) ? [normalized] : [];
    }),
  )];
}
