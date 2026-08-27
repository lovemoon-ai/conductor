/**
 * Runtime health preflight (borrowed from AgentsServer's `runtime_unavailable`
 * rejection). Conductor already refuses task creation when a backend is not in
 * a daemon's advertised `supportedBackends`. This adds a finer signal: a
 * backend can be configured yet unable to *start a turn* (not signed in, or a
 * runtime error). Catching that here rejects before any task/timeline activity
 * with an actionable recovery message instead of creating a task that dies on
 * first launch.
 *
 * Only states that unambiguously mean "the runtime exists but cannot run" are
 * treated as blocking: `unauthenticated` and `error`. A `missing` signal is
 * deliberately NOT blocking — the daemon derives install status from a PATH
 * `which` probe that cannot see custom/absolute CLI paths (e.g. `allow_cli_list`
 * commands, or a systemd unit whose `PATH` differs from the login shell), so
 * blocking on it would false-reject valid setups. The whole signal is
 * best-effort: daemons that advertise no `runtimeHealth`, or report a non-
 * blocking/unknown state, pass through (fail open) so this can never block a
 * task on missing or unreliable information.
 */

export type RuntimeHealthReason = "unauthenticated" | "error";

// Health states that block task creation. `ready`, `missing`, and any unknown
// value are advisory only (see the module doc comment for why `missing` is
// intentionally excluded).
const BLOCKING_STATES = new Set<RuntimeHealthReason>(["unauthenticated", "error"]);

export type RuntimePreflightProblem = {
  backend: string;
  daemonHost: string;
  reason: RuntimeHealthReason;
  message: string;
  recovery: string;
};

type PreflightAgent = {
  host: string;
  runtimeHealth?: Record<string, string>;
};

const recoveryFor = (
  reason: RuntimeHealthReason,
  backend: string,
  host: string,
): { message: string; recovery: string } => {
  if (reason === "unauthenticated") {
    return {
      message: `Backend "${backend}" is not authenticated on daemon "${host}".`,
      recovery: `Sign in to the ${backend} CLI on "${host}", then retry.`,
    };
  }
  return {
    message: `Backend "${backend}" reported a runtime error on daemon "${host}".`,
    recovery: `Check the daemon logs and ${backend} CLI health on "${host}", then retry.`,
  };
};

/**
 * Decide whether the selected backend is unable to start on the chosen daemon.
 * Returns a structured problem only when the daemon positively reports a
 * blocking state (`unauthenticated`/`error`); otherwise null (fail open).
 */
export function evaluateRuntimeHealth(input: {
  agent: PreflightAgent | undefined | null;
  backend: string | null | undefined;
}): RuntimePreflightProblem | null {
  const backend = input.backend?.trim();
  if (!backend || !input.agent) {
    return null;
  }
  const health = input.agent.runtimeHealth?.[backend.toLowerCase()];
  if (!health || !BLOCKING_STATES.has(health as RuntimeHealthReason)) {
    return null;
  }
  const reason = health as RuntimeHealthReason;
  const { message, recovery } = recoveryFor(reason, backend, input.agent.host);
  return { backend, daemonHost: input.agent.host, reason, message, recovery };
}
