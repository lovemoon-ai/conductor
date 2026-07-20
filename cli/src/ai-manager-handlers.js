// Daemon-side glue between the realtime WebSocket and the @love-moon/ai-sdk manager facade.
// The web backend sends `ai_manager_request`; we dispatch by `action`, run it, and
// reply with `ai_manager_response` carrying the same `request_id`.

import { AiManager } from "@love-moon/ai-sdk";

const VALID_ACTIONS = new Set(["status", "quota", "list_accounts", "switch_account"]);
const BASE_QUOTA_TOOLS = ["codex", "claude", "kimi", "copilot"];

/**
 * @param {object} opts
 * @param {string} [opts.configPath] Path to config.yaml. Defaults to $CONDUCTOR_HOME/config.yaml.
 */
export function createAiManagerHandlers(opts = {}) {
  const manager = new AiManager(opts.configPath ? { configPath: opts.configPath } : undefined);

  async function status() {
    // Probe install first; only check network for tools that are actually
    // present so we don't pay an outbound HTTP timeout for a CLI the user
    // never installed.
    const [install, current] = await Promise.all([
      manager.checkInstallAll(),
      manager.getCurrentCodexAccount().catch(() => null),
    ]);
    const network = {};
    const tools = ["codex", "claude", "kimi", "copilot"];
    await Promise.all(
      tools.map(async (tool) => {
        if (install[tool]?.installed) {
          network[tool] = await manager.checkNetwork(tool);
        } else {
          network[tool] = {
            reachable: false,
            endpoint: "",
            error: "not installed",
          };
        }
      }),
    );
    return { install, network, currentCodexAccount: current };
  }

  async function quota(args = {}) {
    const tools = pickToolFilter(args);
    const out = {};
    const forceRefresh = Boolean(args.forceRefresh);
    const jobs = [];
    const addJob = (tool, fetcher) => {
      if (!tools.has(tool)) {
        return;
      }
      jobs.push((async () => {
        try {
          return [tool, await fetcher()];
        } catch (err) {
          return [tool, { tool, error: errMsg(err), source: "unknown" }];
        }
      })());
    };

    addJob("codex", () => manager.getCodexQuota({
      forceRefresh,
    }));
    addJob("claude", () => manager.getClaudeQuota({
      forceRefresh,
    }));
    addJob("kimi", () => manager.getKimiQuota({
      forceRefresh,
    }));
    addJob("copilot", () => manager.getCopilotQuota({
      forceRefresh,
    }));
    const externalBackends = pickExternalQuotaBackends(args);
    for (const backend of externalBackends) {
      if (!tools.has(backend)) {
        continue;
      }
      jobs.push((async () => {
        try {
          const result = await manager.getExternalQuotaList({ backend, forceRefresh });
          return ["external", backend, result];
        } catch (err) {
          return ["external", backend, { backend, error: errMsg(err), source: "unknown" }];
        }
      })());
    }

    const entries = await Promise.all(jobs);
    for (const entry of entries) {
      const [kind, key, result] = entry;
      if (kind === "external") {
        out.external = out.external || {};
        out.external[key] = result;
      } else {
        out[kind] = key;
      }
    }
    return out;
  }

  async function listAccounts() {
    const accounts = await manager.listCodexAccounts();
    // Enrich each account with its on-disk cached quota so the web UI can
    // restore inactive-account snapshots across page refreshes. The cache is
    // read without any network call, so missing/empty caches just leave the
    // field undefined and cost effectively nothing. We swallow per-account
    // errors because one broken auth.json shouldn't fail the whole list.
    const enriched = await Promise.all(
      accounts.map(async (acct) => {
        try {
          const cachedQuota = await manager.readCachedCodexQuota(acct.path);
          return cachedQuota ? { ...acct, cachedQuota } : acct;
        } catch {
          return acct;
        }
      }),
    );
    return { accounts: enriched };
  }

  async function switchAccount(args = {}) {
    if (!args.name || typeof args.name !== "string") {
      throw new Error("switch_account requires a `name` string");
    }
    return await manager.switchCodexAccount(args.name);
  }

  /**
   * Run a single action and return a `result` object, never throwing.
   * @param {{action:string,args?:object}} payload
   */
  async function dispatch(payload) {
    const action = payload?.action;
    if (!VALID_ACTIONS.has(action)) {
      return { error: `unknown action: ${action}` };
    }
    try {
      switch (action) {
        case "status":
          return { result: await status() };
        case "quota":
          return { result: await quota(payload?.args ?? {}) };
        case "list_accounts":
          return { result: await listAccounts() };
        case "switch_account":
          return { result: await switchAccount(payload?.args ?? {}) };
        default:
          return { error: `unhandled action: ${action}` };
      }
    } catch (err) {
      return { error: errMsg(err) };
    }
  }

  return { dispatch, manager };
}

/**
 * Wire a handler against an event payload from the web backend, sending the
 * response back through `client.sendJson` once the action completes.
 *
 * @param {object} client - conductor websocket client (must have sendJson)
 * @param {ReturnType<typeof createAiManagerHandlers>} handlers
 * @param {object} payload - event.payload with shape { request_id, action, args }
 */
export async function handleAiManagerRequest(client, handlers, payload) {
  const requestId = payload?.request_id ? String(payload.request_id) : "";
  const action = payload?.action ? String(payload.action) : "";
  if (!requestId) {
    // Without a request_id we cannot route the response anywhere; drop and log upstream.
    return { error: "missing request_id" };
  }

  const response = await handlers.dispatch({
    action,
    args: payload?.args && typeof payload.args === "object" ? payload.args : {},
  });

  const outgoing = {
    type: "ai_manager_response",
    payload: {
      request_id: requestId,
      action,
      ...(response?.error ? { error: response.error } : { result: response?.result }),
    },
  };
  await client.sendJson(outgoing).catch(() => {});
  return response;
}

function pickToolFilter(args = {}) {
  const tool = typeof args.tool === "string" ? args.tool.trim().toLowerCase() : "";
  if (tool) return new Set([tool]);
  return new Set([...BASE_QUOTA_TOOLS, ...pickExternalQuotaBackends(args)]);
}

function pickExternalQuotaBackends(args = {}) {
  const fromArray = Array.isArray(args.externalQuotaBackends) ? args.externalQuotaBackends : [];
  const fromString = typeof args.externalQuotaBackends === "string"
    ? args.externalQuotaBackends.split(",")
    : [];
  const backends = [...fromArray, ...fromString]
    .map((item) => String(item || "").trim().toLowerCase())
    .filter(Boolean)
    .filter((backend) => !BASE_QUOTA_TOOLS.includes(backend));
  const tool = typeof args.tool === "string" ? args.tool.trim().toLowerCase() : "";
  if (tool && !BASE_QUOTA_TOOLS.includes(tool)) {
    backends.push(tool);
  }
  return [...new Set(backends)];
}

function errMsg(err) {
  return err?.message ?? String(err);
}
