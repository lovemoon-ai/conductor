// Daemon-side glue between the realtime WebSocket and the @love-moon/ai-manager module.
// The web backend sends `ai_manager_request`; we dispatch by `action`, run it, and
// reply with `ai_manager_response` carrying the same `request_id`.

import { AiManager } from "@love-moon/ai-manager";

const VALID_ACTIONS = new Set(["status", "quota", "list_accounts", "switch_account"]);

/**
 * @param {object} opts
 * @param {string} [opts.configPath] Path to ~/.conductor/config.yaml. Defaults to ai-manager's default.
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
    const tools = ["codex", "claude", "kimi"];
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
    if (tools.has("codex")) {
      try {
        out.codex = await manager.getCodexQuota({
          forceRefresh: Boolean(args.forceRefresh),
        });
      } catch (err) {
        out.codex = { tool: "codex", error: errMsg(err), source: "unknown" };
      }
    }
    if (tools.has("claude")) {
      try {
        out.claude = await manager.getClaudeQuota({
          forceRefresh: Boolean(args.forceRefresh),
        });
      } catch (err) {
        out.claude = { tool: "claude", error: errMsg(err), source: "unknown" };
      }
    }
    if (tools.has("kimi")) {
      try {
        out.kimi = await manager.getKimiQuota({
          forceRefresh: Boolean(args.forceRefresh),
        });
      } catch (err) {
        out.kimi = { tool: "kimi", error: errMsg(err), source: "unknown" };
      }
    }
    return out;
  }

  async function listAccounts() {
    return { accounts: await manager.listCodexAccounts() };
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

  const out = await handlers.dispatch({ action, args: payload?.args });
  await client
    .sendJson({
      type: "ai_manager_response",
      payload: {
        request_id: requestId,
        action,
        result: out.result,
        error: out.error,
      },
    })
    .catch(() => {});
  return out;
}

function pickToolFilter(args) {
  const t = args?.tool;
  if (t === "codex") return new Set(["codex"]);
  if (t === "claude") return new Set(["claude"]);
  if (t === "kimi") return new Set(["kimi"]);
  return new Set(["codex", "claude", "kimi"]);
}

function errMsg(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}
