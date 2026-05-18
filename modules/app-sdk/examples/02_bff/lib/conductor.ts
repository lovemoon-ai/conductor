/**
 * Server-side singleton for the Conductor SDK client.
 *
 * Runs in Next.js Route Handlers (Node.js runtime). One AppClient is shared
 * across all requests in the same Node process. The first call to `await
 * getClient()` opens a /ws/app WebSocket; subsequent calls reuse it.
 */
import { connect, type AppClient } from '@love-moon/app-sdk/server';

let cachedClient: AppClient | null = null;
let cachedClientPromise: Promise<AppClient> | null = null;

function readEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing env var ${key}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export async function getClient(): Promise<AppClient> {
  if (cachedClient) return cachedClient;
  if (cachedClientPromise) return cachedClientPromise;
  // We cache the *promise* so concurrent callers share one connect; but if
  // it rejects we clear the cache so the next caller retries from scratch
  // rather than re-receiving the same rejection forever.
  const promise = (async () => {
    const client = await connect({
      baseUrl: readEnv('CONDUCTOR_BASE_URL'),
      bearerToken: readEnv('CONDUCTOR_TOKEN'),
      onUnauthorized: () => {
        // In a real app: page the on-call team, rotate the token, etc.
        // For the demo we just log.
        console.error('[demo] Conductor returned 401 — token invalid or revoked?');
      },
    });
    cachedClient = client;
    return client;
  })();
  cachedClientPromise = promise;
  promise.catch(() => {
    // Clear the cached promise on failure so the next call can retry.
    if (cachedClientPromise === promise) {
      cachedClientPromise = null;
    }
  });
  return promise;
}

/** Idempotent project binding — returns the same project on repeat calls. */
export async function bindDemoProject() {
  const client = await getClient();
  return await client.projects.bind({
    name: process.env.CONDUCTOR_APP_NAME ?? 'App SDK Demo',
    daemonHost: readEnv('CONDUCTOR_DAEMON_HOST'),
    workspacePath: readEnv('CONDUCTOR_WORKSPACE_PATH'),
  });
}
