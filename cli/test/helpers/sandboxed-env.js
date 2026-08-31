// Build the environment for a test that spawns a REAL conductor binary
// (daemon, fire, …) as a child process.
//
// Why allowlist instead of `{ ...process.env, ...overrides }`:
//
// On 2026-08-31 three fully-functional PRODUCTION daemons were spawned by
// `cli/test/daemon-lock.test.js` and survived on a developer's machine for 20
// hours, fighting the real daemon for the same `daemon_name` and mass-killing
// live user tasks. The test believed it was sandboxed because it set
// `CONDUCTOR_HOME` and `CONDUCTOR_WS` — but it ran inside a Conductor task
// shell, which by design exports `CONDUCTOR_CONFIG`, `CONDUCTOR_AGENT_TOKEN`
// and `CONDUCTOR_BACKEND_URL`, and `resolveConductorConfigPath` consults
// `CONDUCTOR_CONFIG` *before* falling back to `$CONDUCTOR_HOME/config.yaml`.
// The spawned process therefore loaded the developer's real config (real
// `daemon_name`) with the real agent token attached.
//
// The lesson is not "also unset CONDUCTOR_CONFIG": these variables have a
// precedence order, so overriding a subset is not isolation. Anything not
// named here does not reach the child.

// The only variables a conductor binary needs to run at all. Everything
// Conductor-specific must be passed explicitly by the caller.
const PASSTHROUGH_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "SystemRoot", // Windows: node cannot start without it
  "NODE_EXTRA_CA_CERTS",
];

// Named purely so a regression is legible in a diff/assertion: these are the
// variables that turned a sandboxed test into a production daemon.
export const PRODUCTION_IDENTITY_ENV_KEYS = [
  "CONDUCTOR_CONFIG",
  "CONDUCTOR_HOME",
  "CONDUCTOR_WS",
  "CONDUCTOR_AGENT_TOKEN",
  "CONDUCTOR_BACKEND_URL",
  "CONDUCTOR_WS_URL",
  "CONDUCTOR_DAEMON_NAME",
  "CONDUCTOR_TASK_ID",
  "CONDUCTOR_PROJECT_ID",
  "CONDUCTOR_LAUNCHED_BY_DAEMON",
  "CONDUCTOR_LAUNCHER_SCRIPT",
  "CONDUCTOR_SUBCOMMAND",
  "CONDUCTOR_SUBCOMMAND_ARGS_JSON",
  "CONDUCTOR_CLI_COMMAND",
  "CONDUCTOR_RESUME_CWD",
];

export function buildSandboxedEnv(overrides = {}, sourceEnv = process.env) {
  const env = {};
  for (const key of PASSTHROUGH_ENV_KEYS) {
    if (typeof sourceEnv[key] === "string") {
      env[key] = sourceEnv[key];
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    env[key] = String(value);
  }
  return env;
}
