import { startRuntimeServer } from "./server.js";

const options = JSON.parse(process.argv[2] ?? "{}");
let server: Awaited<ReturnType<typeof startRuntimeServer>> | undefined;
try {
  server = await startRuntimeServer(options);
  const shutdown = () => { void server!.close(); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  const configured = Number(process.env.CHAT_WEB_RUNTIME_IDLE_MS ?? 600_000);
  const idleMs = Number.isFinite(configured) && configured >= 1000 ? configured : 600_000;
  const timer = setInterval(() => {
    const status = server!.runtime.status();
    if (!status.activeTurns && !status.pinnedChats.length && Date.now() - server!.lastActivity > idleMs) void server!.close();
  }, 1000);
  timer.unref();
  try { await server.closed; }
  finally { clearInterval(timer); process.off("SIGTERM", shutdown); process.off("SIGINT", shutdown); }
} catch (error) {
  // Concurrent starters share the winner; never stop an existing daemon.
  if ((error as { code?: string }).code !== "RUNTIME_LOCKED") { console.error(error); process.exitCode = 1; }
}
