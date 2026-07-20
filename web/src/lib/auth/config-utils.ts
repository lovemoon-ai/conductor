const normalizeConfiguredAgentWsUrl = (value: string | undefined): string | null => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:") {
      parsed.protocol = "ws:";
    } else if (parsed.protocol === "https:") {
      parsed.protocol = "wss:";
    } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    if (!parsed.pathname || parsed.pathname === "/") {
      parsed.pathname = "/ws/agent";
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const LEGACY_CONDUCTOR_PUBLIC_HOST = "conductor-ai.top";
const CONDUCTOR_PUBLIC_ORIGIN = "https://conductor.conductor-ai.top";

export const resolveAgentWebsocketUrl = (backendUrl: string): string => {
  const configured =
    normalizeConfiguredAgentWsUrl(process.env.PUBLIC_AGENT_WS_URL) ||
    normalizeConfiguredAgentWsUrl(process.env.PUBLIC_WS_URL);
  if (configured) {
    return configured;
  }

  try {
    const parsed = new URL(backendUrl);
    const scheme = parsed.protocol === "https:" ? "wss" : "ws";
    return `${scheme}://${parsed.host}/ws/agent`;
  } catch {
    return "";
  }
};

export const resolvePublicBackendUrl = (fallbackOrigin?: string): string => {
  const configured =
    process.env.NEXT_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL;

  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }

  return fallbackOrigin || "http://localhost:6152";
};

export const resolveDeviceAuthorizationBaseUrl = (fallbackOrigin?: string): string => {
  const resolved = resolvePublicBackendUrl(fallbackOrigin).replace(/\/+$/, "");

  try {
    const parsed = new URL(resolved);
    if (parsed.hostname !== LEGACY_CONDUCTOR_PUBLIC_HOST) {
      return resolved;
    }

    const canonicalOrigin = new URL(CONDUCTOR_PUBLIC_ORIGIN);
    parsed.protocol = canonicalOrigin.protocol;
    parsed.host = canonicalOrigin.host;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return resolved;
  }
};

/**
 * True when the public backend URL is sourced from an explicit env var rather
 * than from the request origin fallback. Callers that mint URLs which must be
 * reachable from a different host (e.g. a daemon running on a remote machine)
 * should refuse to proceed in production unless this returns true, otherwise
 * the resulting URL may point at an internal `127.0.0.1:3000` that the daemon
 * cannot reach.
 */
export const hasConfiguredPublicBackendUrl = (): boolean => {
  const configured =
    process.env.NEXT_PUBLIC_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL;
  return typeof configured === "string" && configured.trim().length > 0;
};
