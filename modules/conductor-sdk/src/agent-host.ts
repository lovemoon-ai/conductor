const FIRE_HOST_PREFIX = 'conductor-fire-';

const firstNonEmpty = (...values: Array<string | undefined>): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
};

const sanitizeHostSegment = (value: string): string => value.replace(/[^A-Za-z0-9._-]+/g, '-');

/**
 * Build the WebSocket identity of a fire process.
 *
 * Two properties are load-bearing:
 *
 * 1. It must be identical across restarts of the same task. The server pins
 *    undelivered commands to `agentOutbox.agentHost` and signs attachment
 *    transfer tokens against this exact string, so a per-process identity
 *    strands anything still in flight when the process dies.
 * 2. It must stay unique per concurrent fire. One daemon runs a fire per task
 *    and the realtime hub evicts an existing connection that reuses a name, so
 *    a shared identity would make each new fire kick the previous one offline.
 *
 * The `conductor-fire-` prefix is also meaningful: it selects the `manual_fire`
 * plan bucket and keeps fire hosts out of daemon task routing.
 */
export function buildFireHostName(
  env: Record<string, string | undefined>,
  pid: number = process.pid,
): string {
  const owner = firstNonEmpty(env.CONDUCTOR_DAEMON_NAME, env.HOSTNAME, env.COMPUTERNAME) ?? 'unknown-host';
  // Before a task exists there is nothing durable to key on, so an unattached
  // fire keeps a per-process name until it owns a task.
  const scope = firstNonEmpty(env.CONDUCTOR_TASK_ID) ?? `pid-${pid}`;
  return `${FIRE_HOST_PREFIX}${sanitizeHostSegment(owner)}-${sanitizeHostSegment(scope)}`;
}
