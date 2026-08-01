import { config } from "dotenv";

// Load environment variables based on NODE_ENV
const envFile = process.env.NODE_ENV === "production" ? ".env.production.local" : ".env";
config({ path: envFile });

import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import fs from "fs";
import path from "path";
import next from "next";
import { setupAppGateway, APP_WS_PATH } from "./src/lib/realtime/app-gateway";
import { setupAgentGateway, AGENT_WS_PATH } from "./src/lib/realtime/agent-gateway";
import { setupSpeechGateway, SPEECH_WS_PATH } from "./src/lib/speech/gateway";
import { reconcileOrphanedTaskAttachmentFiles, startTaskAttachmentJanitor } from "./src/lib/tasks/task-attachment-janitor";
import { assertTaskAttachmentStorageConfigured } from "./src/lib/tasks/task-file-storage";
import { startScheduledMessageDispatcher } from "./src/lib/tasks/scheduled-messages";
import {
  reconcileDailyReportSchedules,
  startDailyReportDispatcher,
} from "./src/lib/daily-reports/daily-report";
import { ensureDailyReportSchema } from "./src/lib/daily-reports/schema";
import { realtimeHub } from "./src/lib/realtime/hub";
import { db } from "./src/lib/db";
import { backfillIssueAiSessionIfNeeded } from "./src/lib/issues/backfill-ai-session";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "6152", 10);

const resolveAppDir = () => {
  const envDir = process.env.NEXT_STANDALONE_DIR?.trim();
  if (envDir) return envDir;

  const candidate = path.join(process.cwd(), ".next", "standalone");
  if (fs.existsSync(path.join(candidate, ".next"))) {
    return candidate;
  }

  return process.cwd();
};

const app = next({ dev, hostname, port, dir: resolveAppDir() });
const handle = app.getRequestHandler();

// CORS configuration
const corsOrigins = process.env.CORS_ORIGINS?.split(",").flatMap((origin) => {
  const trimmed = origin.trim();
  return trimmed ? [trimmed] : [];
}) ?? [];

function setCorsHeaders(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  // Allow if: no origin (same-origin), origin in whitelist, or whitelist is empty (allow all)
  if (!origin || corsOrigins.length === 0 || corsOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

app.prepare().then(async () => {
  assertTaskAttachmentStorageConfigured();
  await reconcileOrphanedTaskAttachmentFiles().catch((error) => {
    console.warn(`[attachments] orphan reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  startTaskAttachmentJanitor();

  // Restore task bindings from database to prevent tasks stuck in 'init' state after restart
  await realtimeHub.restoreTaskBindingsFromDb(async () => {
    const tasks = await db.task.findMany({
      where: {
        status: { in: ["init", "running"] },
        agentHost: { not: null },
      },
      select: { id: true, agentHost: true },
    });
    return tasks;
  });
  startScheduledMessageDispatcher();
  const dailyReportSchema = await ensureDailyReportSchema();
  if (dailyReportSchema.skippedReason === "error") {
    console.warn(
      `[daily-reports] failed to ensure local schema: ${dailyReportSchema.error}`,
    );
  }
  await reconcileDailyReportSchedules().catch((error) => {
    console.warn(
      `[daily-reports] failed to reconcile schedules: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  startDailyReportDispatcher();

  // Idempotent boot-time backfill of issue.ai_backend_type / ai_session_id
  // from any task that already carries those values. Required because
  // `prisma db push` (the default Conductor dev flow) does not replay
  // migration files, so the dedicated backfill migration would never run on
  // those installs. Safe to call on every boot — no-ops once everything is
  // already mirrored.
  void backfillIssueAiSessionIfNeeded().catch((error) => {
    // backfillIssueAiSessionIfNeeded never throws, but defensively log just
    // in case a future change introduces one — startup must not crash.
    console.warn(
      `[issue-ai-session-backfill] unexpected backfill failure: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  });
  const handleUpgrade = app.getUpgradeHandler();
  const server = createServer(async (req, res) => {
    // Set CORS headers for all requests
    setCorsHeaders(req, res);

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      const parsedUrl = parse(req.url!, true);
      const pathname = parsedUrl.pathname ?? "/";

      await handle(req, res, parsedUrl);
    } catch (err) {
      console.error("Error handling request:", err);
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  });

  const appWss = setupAppGateway();
  const agentWss = setupAgentGateway();
  const speechWss = setupSpeechGateway();

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url || "", true);

    if (pathname === APP_WS_PATH) {
      appWss.handleUpgrade(req, socket, head, (ws) => {
        appWss.emit("connection", ws, req);
      });
    } else if (pathname === AGENT_WS_PATH) {
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit("connection", ws, req);
      });
    } else if (pathname === SPEECH_WS_PATH) {
      speechWss.handleUpgrade(req, socket, head, (ws) => {
        speechWss.emit("connection", ws, req);
      });
    } else if (dev) {
      // Allow Next.js dev HMR websocket upgrades.
      handleUpgrade(req, socket, head);
    } else {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
