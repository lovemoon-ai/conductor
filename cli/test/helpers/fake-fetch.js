/**
 * Fake `fetch` for CLI commands built on `src/backend-http.js`.
 *
 * Register handlers by "METHOD /api/path" (exact path, no query string). Each
 * handler receives `{ method, path, query, body, headers }` and returns either a
 * plain value (sent as a 200 JSON body) or `{ status, body }`. Every request
 * is recorded in `calls` so tests can assert on the exact wire request.
 */

import { Writable } from "node:stream";

export const TEST_CONFIG = { agentToken: "test-token", backendUrl: "https://backend.example" };

export function createFakeFetch(routes = {}) {
  const calls = [];
  async function fakeFetch(url, init = {}) {
    const parsed = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    // JSON bodies are decoded; multipart (FormData) bodies are passed through as-is.
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    const query = Object.fromEntries(parsed.searchParams.entries());
    const call = { method, path: parsed.pathname, query, body, headers: init.headers || {} };
    calls.push(call);
    const handler = routes[`${method} ${parsed.pathname}`];
    let status = 200;
    let payload;
    if (!handler) {
      status = 404;
      payload = { error: `no fake route for ${method} ${parsed.pathname}` };
    } else {
      const result = typeof handler === "function" ? await handler(call) : handler;
      if (result && typeof result === "object" && "status" in result && "body" in result) {
        status = result.status;
        payload = result.body;
      } else {
        payload = result;
      }
    }
    const text = payload === undefined ? "" : JSON.stringify(payload);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

export function makeStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      cb();
    },
  });
  stream.collect = () => chunks.join("");
  return stream;
}

/**
 * Run a CLI `main(argv, deps)` against a fake fetch. `extraDeps` is merged in
 * last (e.g. `backendApi`/`sdk` for commands that also use the SDK path).
 */
export async function runWithFetch(main, args, routes, extraDeps = {}) {
  const fetchImpl = createFakeFetch(routes);
  const stdout = makeStream();
  const stderr = makeStream();
  const code = await main(args, {
    stdout,
    stderr,
    env: { CONDUCTOR_AGENT_TOKEN: "test-token", CONDUCTOR_BACKEND_URL: "https://backend.example" },
    cwd: "/tmp/cli-test",
    config: TEST_CONFIG,
    fetchImpl,
    ...extraDeps,
  });
  return { code, out: stdout.collect(), err: stderr.collect(), calls: fetchImpl.calls };
}
