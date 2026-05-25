import type { NetworkStatus, Tool } from "./types.js";

const ENDPOINTS: Record<Tool, string> = {
  codex: "https://chatgpt.com/",
  claude: "https://api.anthropic.com/v1/messages",
  kimi: "https://api.kimi.com/coding/v1/usages",
  copilot: "https://api.githubcopilot.com/",
};

const DEFAULT_TIMEOUT_MS = 5000;

export async function checkNetwork(
  tool: Tool,
  opts: { timeoutMs?: number; endpoint?: string } = {},
): Promise<NetworkStatus> {
  const endpoint = opts.endpoint ?? ENDPOINTS[tool];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();

  try {
    // Unauthenticated HEAD; we only care whether the host is reachable.
    // api.anthropic.com returns 401/405 on HEAD, which still counts as reachable.
    const res = await fetch(endpoint, { method: "HEAD", signal: controller.signal });
    const latencyMs = Date.now() - start;
    return {
      reachable: true,
      latencyMs,
      httpStatus: res.status,
      endpoint,
    };
  } catch (err: any) {
    return {
      reachable: false,
      latencyMs: Date.now() - start,
      endpoint,
      error: err?.name === "AbortError" ? "timeout" : err?.message ?? String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkNetworkAll(opts?: {
  timeoutMs?: number;
}): Promise<Record<Tool, NetworkStatus>> {
  const [codex, claude, kimi, copilot] = await Promise.all([
    checkNetwork("codex", opts),
    checkNetwork("claude", opts),
    checkNetwork("kimi", opts),
    checkNetwork("copilot", opts),
  ]);
  return { codex, claude, kimi, copilot };
}
