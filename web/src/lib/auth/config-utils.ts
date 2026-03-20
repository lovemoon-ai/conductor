export const normalizeConfiguredAgentWsUrl = (value: string | undefined): string | null => {
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
