/**
 * Wiring `conductor remote mcp` into a remote-worktree task (RFC 0040).
 *
 * The daemon knows the task's `launch_config.remoteWorktree`; fire knows which
 * AI backend it is about to start. The daemon resolves the binding (which
 * daemon, which directory) and hands it to fire in one env var; fire turns it
 * into that backend's MCP configuration. Kept free of heavy imports: both the
 * daemon and fire load it on every task.
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MCP_SERVER_NAME = "conductor_remote";
export const REMOTE_WORKTREE_ENV = "CONDUCTOR_REMOTE_WORKTREE";

/** The server's credentials travel by env, never argv (argv is world-readable in `ps`). */
const FORWARDED_ENV = [
  "CONDUCTOR_AGENT_TOKEN",
  "CONDUCTOR_BACKEND_URL",
  "CONDUCTOR_CONFIG",
  "CONDUCTOR_HOME",
  "CONDUCTOR_REMOTE_CHUNK_BYTES",
  // Codex hands MCP servers only a minimal env; a corporate CA must still reach fetch.
  "NODE_EXTRA_CA_CERTS",
];

/** remote_bash may wait up to 10 minutes; Codex's default MCP tool timeout is 60s. */
const CODEX_TOOL_TIMEOUT_SEC = 900;

const REMOTE_SCRIPT = fileURLToPath(new URL("../../bin/conductor-remote.js", import.meta.url));

const str = (value) => (typeof value === "string" && value.trim() ? value.trim() : "");

const isWindowsStylePath = (value) => /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");

/**
 * Where the remote worktree lives, from `launch_config.remoteWorktree`. Same
 * math as web's `resolveRemoteWorktreePaths` and the daemon's
 * `buildTaskWorktreeRoot`: `<workspacePath>/.conductor/worktrees/<branch>`, and
 * the work dir is the project's offset inside the repository under that.
 */
export function resolveRemoteWorktreeBinding(launchConfig) {
  const raw = launchConfig?.remoteWorktree ?? launchConfig?.remote_worktree;
  if (!raw || typeof raw !== "object") return resolveRemoteWorkspaceBinding(launchConfig);
  const host = str(raw.host);
  const repoRoot = str(raw.repoRoot) || str(raw.repo_root);
  const workspacePath = str(raw.workspacePath) || str(raw.workspace_path);
  const branch = str(raw.branch);
  if (!host || !repoRoot || !workspacePath || !branch) return null;

  const pathApi = isWindowsStylePath(repoRoot) || isWindowsStylePath(workspacePath) ? path.win32 : path.posix;
  const folder = branch.replace(/[/\\]/g, "_").replace(/\.\./g, "_");
  const root = pathApi.join(workspacePath, ".conductor", "worktrees", folder);
  const relative = pathApi.relative(repoRoot, workspacePath);
  if (relative.startsWith("..") || pathApi.isAbsolute(relative)) return null;
  const cwd = relative && relative !== "." ? pathApi.join(root, relative) : root;
  return { host, root, cwd };
}

/**
 * RFC 0041 direct mode: `launch_config.remoteWorkspace` points at the project
 * directory itself (no worktree). The tools stay inside the repository and
 * start in the project's directory.
 */
function resolveRemoteWorkspaceBinding(launchConfig) {
  const raw = launchConfig?.remoteWorkspace ?? launchConfig?.remote_workspace;
  if (!raw || typeof raw !== "object") return null;
  const host = str(raw.host);
  const repoRoot = str(raw.repoRoot) || str(raw.repo_root);
  const workspacePath = str(raw.workspacePath) || str(raw.workspace_path);
  if (!host || !repoRoot || !workspacePath) return null;
  const pathApi = isWindowsStylePath(repoRoot) || isWindowsStylePath(workspacePath) ? path.win32 : path.posix;
  const relative = pathApi.relative(repoRoot, workspacePath);
  if (relative.startsWith("..") || pathApi.isAbsolute(relative)) return null;
  return { host, root: repoRoot, cwd: workspacePath };
}

/** Env the daemon adds when it spawns fire. Empty for an ordinary task. */
export function remoteWorktreeFireEnv(launchConfig) {
  const binding = resolveRemoteWorktreeBinding(launchConfig);
  return binding ? { [REMOTE_WORKTREE_ENV]: JSON.stringify(binding) } : {};
}

export function readRemoteWorktreeBinding(env = process.env) {
  const raw = str(env?.[REMOTE_WORKTREE_ENV]);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const host = str(parsed?.host);
    const root = str(parsed?.root);
    const cwd = str(parsed?.cwd) || root;
    return host && root ? { host, root, cwd } : null;
  } catch {
    return null;
  }
}

function serverArgs(binding, configFile, remoteScript) {
  return [
    remoteScript,
    "mcp",
    "--host", binding.host,
    "--root", binding.root,
    "--cwd", binding.cwd,
    // Absolute: the backend starts the server in the session's cwd, not ours.
    ...(configFile ? ["--config-file", path.resolve(configFile)] : []),
  ];
}

/**
 * Session options that give the backend the remote workspace tools, merged
 * over what the user configured. Only Claude and Codex are wired; any other
 * backend gets nothing and keeps using `conductor remote exec` as before.
 */
export function buildRemoteWorktreeSessionOptions({
  backend,
  binding,
  sessionOptions = {},
  commandLine = "",
  configFile = "",
  env = process.env,
  execPath = process.execPath,
  remoteScript = REMOTE_SCRIPT,
} = {}) {
  if (!binding) return {};
  const args = serverArgs(binding, configFile, remoteScript);
  const normalizedBackend = String(backend || "").trim().toLowerCase();

  if (normalizedBackend === "claude") {
    const allowed = Array.isArray(sessionOptions.allowedTools) ? sessionOptions.allowedTools : [];
    // Same precedence as the Claude session: explicit option, then the
    // configured command line's `--permission-mode`.
    const mode = sessionOptions.permissionMode
      ?? String(commandLine || "").match(/--permission-mode[=\s]+([^\s"']+)/)?.[1];
    return {
      mcpServers: {
        ...(sessionOptions.mcpServers || {}),
        [MCP_SERVER_NAME]: { type: "stdio", command: execPath, args },
      },
      // Under the default bypassPermissions a root install is downgraded to
      // acceptEdits, which would deny every remote_* call headless. A mode the
      // user chose on purpose is left alone rather than widened.
      ...(mode === undefined || mode === "bypassPermissions"
        ? { allowedTools: [...new Set([...allowed, `mcp__${MCP_SERVER_NAME}`])] }
        : {}),
    };
  }

  if (normalizedBackend === "codex") {
    // Values are TOML; JSON strings and string arrays are valid TOML as-is.
    const prefix = `mcp_servers.${MCP_SERVER_NAME}`;
    const forwarded = FORWARDED_ENV.filter((name) => str(env?.[name]));
    return {
      configOverrides: [
        ...(Array.isArray(sessionOptions.configOverrides) ? sessionOptions.configOverrides : []),
        `${prefix}.command=${JSON.stringify(execPath)}`,
        `${prefix}.args=${JSON.stringify(args)}`,
        ...(forwarded.length > 0 ? [`${prefix}.env_vars=${JSON.stringify(forwarded)}`] : []),
        `${prefix}.tool_timeout_sec=${CODEX_TOOL_TIMEOUT_SEC}`,
      ],
    };
  }

  return {};
}
