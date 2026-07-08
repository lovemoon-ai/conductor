import { db } from "@/lib/db";

const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_BATCH_SIZE = 200;
let warnedMissingAgentOutboxTable = false;

export type AgentCommandEnvelope = {
  type: string;
  payload: Record<string, unknown>;
};

export type AgentCommandCursor = {
  createdAt: string;
  requestId: string;
};

export type EnqueueAgentCommandInput = {
  userId: string;
  agentHost?: string | null;
  taskId?: string | null;
  eventType: string;
  requestId: string;
  envelope: AgentCommandEnvelope;
};

export type DeliverAgentOutboxOptions = {
  userId: string;
  agentHost: string;
  sendToAgentHost: (args: {
    userId: string;
    agentHost: string;
    envelope: AgentCommandEnvelope;
  }) => boolean;
  resolveTaskHost?: (taskId: string) => string | null;
  retryDelayMs?: number;
  batchSize?: number;
  ignoreRetryAt?: boolean;
};

export type AgentOutboxDeliveryRow = {
  id: string;
  userId: string;
  agentHost: string | null;
  taskId: string | null;
  eventType: string;
  requestId: string;
  createdAt: Date;
  payloadJson: string;
};

export function isMissingAgentOutboxTableError(error: unknown): boolean {
  const code = (error as any)?.code;
  const message = String((error as any)?.message || "");
  return code === "P2021" && message.includes("agent_outbox");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "P2002";
}

export function warnMissingAgentOutboxTable(error: unknown): void {
  if (warnedMissingAgentOutboxTable) {
    return;
  }
  warnedMissingAgentOutboxTable = true;
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[agent-outbox] table missing, falling back to direct delivery. Run 'pnpm -C web db:push' to enable durable outbox. (${message})`,
  );
}

function safeParseEnvelope(payloadJson: string): AgentCommandEnvelope | null {
  try {
    const parsed = JSON.parse(payloadJson);
    if (!parsed || typeof parsed !== "object") return null;
    const type = typeof (parsed as any).type === "string" ? (parsed as any).type : "";
    const payload =
      (parsed as any).payload && typeof (parsed as any).payload === "object"
        ? ((parsed as any).payload as Record<string, unknown>)
        : {};
    if (!type) return null;
    return { type, payload };
  } catch {
    return null;
  }
}

function nextRetryAt(delayMs: number): Date {
  return new Date(Date.now() + Math.max(delayMs, 0));
}

function buildAgentCommandCursor(row: { createdAt: Date; requestId: string }): AgentCommandCursor {
  return {
    createdAt: row.createdAt.toISOString(),
    requestId: row.requestId,
  };
}

function injectDeliveryCursor(
  envelope: AgentCommandEnvelope,
  row: { createdAt: Date; requestId: string },
): AgentCommandEnvelope {
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      delivery_cursor: buildAgentCommandCursor(row),
    },
  };
}

async function markDelivered(
  rowId: string,
  host: string | null,
  delayMs: number,
): Promise<void> {
  await db.agentOutbox.update({
    where: { id: rowId },
    data: {
      status: "sent",
      sentAt: new Date(),
      nextRetryAt: nextRetryAt(delayMs),
      lastError: null,
      agentHost: host ?? undefined,
      attemptCount: { increment: 1 },
    },
  });
}

async function markDeliveryDeferred(
  rowId: string,
  host: string | null,
  reason: string,
  delayMs: number,
): Promise<void> {
  await db.agentOutbox.update({
    where: { id: rowId },
    data: {
      status: "pending",
      nextRetryAt: nextRetryAt(delayMs),
      lastError: reason,
      agentHost: host ?? undefined,
      attemptCount: { increment: 1 },
    },
  });
}

async function tryDeliverRow(
  row: AgentOutboxDeliveryRow,
  options: DeliverAgentOutboxOptions,
): Promise<boolean> {
  const envelope = safeParseEnvelope(row.payloadJson);
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  if (!envelope) {
    await db.agentOutbox.update({
      where: { id: row.id },
      data: {
        status: "failed",
        lastError: "invalid_payload_json",
        nextRetryAt: nextRetryAt(retryDelayMs),
        attemptCount: { increment: 1 },
      },
    });
    return false;
  }

  const resolvedTaskHost =
    !row.agentHost && row.taskId && options.resolveTaskHost
      ? options.resolveTaskHost(row.taskId)
      : null;
  const targetHost = row.agentHost || resolvedTaskHost || null;
  if (!targetHost) {
    return false;
  }
  if (targetHost !== options.agentHost) {
    return false;
  }

  let delivered = false;
  try {
    delivered = options.sendToAgentHost({
      userId: row.userId,
      agentHost: targetHost,
      envelope: injectDeliveryCursor(envelope, row),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markDeliveryDeferred(row.id, targetHost, message, retryDelayMs);
    return false;
  }

  if (!delivered) {
    await markDeliveryDeferred(row.id, targetHost, "send_to_agent_host_failed", retryDelayMs);
    return false;
  }

  await markDelivered(row.id, targetHost, retryDelayMs);
  return true;
}

export async function enqueueAgentCommand(input: EnqueueAgentCommandInput) {
  return db.agentOutbox.create({
    data: {
      userId: input.userId,
      agentHost: input.agentHost ?? null,
      taskId: input.taskId ?? null,
      eventType: input.eventType,
      requestId: input.requestId,
      payloadJson: JSON.stringify(input.envelope),
      status: "pending",
      attemptCount: 0,
      nextRetryAt: null,
    },
  });
}

export async function enqueueAndAttemptAgentCommand(
  input: EnqueueAgentCommandInput,
  options?: Omit<DeliverAgentOutboxOptions, "userId" | "agentHost"> & { agentHost?: string | null },
): Promise<{ requestId: string; delivered: boolean }> {
  const targetHost = options?.agentHost ?? input.agentHost ?? null;
  let row: Awaited<ReturnType<typeof enqueueAgentCommand>> | null = null;
  try {
    row = await enqueueAgentCommand(input);
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      warnMissingAgentOutboxTable(error);
      if (!targetHost || !options?.sendToAgentHost) {
        return { requestId: input.requestId, delivered: false };
      }
      const delivered = options.sendToAgentHost({
        userId: input.userId,
        agentHost: targetHost,
        envelope: input.envelope,
      });
      return { requestId: input.requestId, delivered };
    }
    if (isUniqueConstraintError(error)) {
      row = await db.agentOutbox.findUnique({
        where: { requestId: input.requestId },
      });
      if (!row) {
        throw error;
      }
    } else {
      throw error;
    }
  }
  if (!row) {
    throw new Error(`failed to enqueue agent command ${input.requestId}`);
  }
  if (!targetHost || !options?.sendToAgentHost) {
    return { requestId: row.requestId, delivered: false };
  }

  const delivered = await tryDeliverRow(
    {
      id: row.id,
      userId: row.userId,
      agentHost: row.agentHost,
      taskId: row.taskId,
      eventType: row.eventType,
      requestId: row.requestId,
      createdAt: row.createdAt,
      payloadJson: row.payloadJson,
    },
    {
      userId: input.userId,
      agentHost: targetHost,
      sendToAgentHost: options.sendToAgentHost,
      resolveTaskHost: options.resolveTaskHost,
      retryDelayMs: options.retryDelayMs,
      batchSize: options.batchSize,
    },
  );
  return { requestId: row.requestId, delivered };
}

export async function deliverAgentOutboxForHost(options: DeliverAgentOutboxOptions): Promise<{
  attempted: number;
  delivered: number;
}> {
  const now = new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const retryWindowFilter = options.ignoreRetryAt
    ? []
    : [{ OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }] }];
  let rows: AgentOutboxDeliveryRow[] = [];
  try {
    rows = await db.agentOutbox.findMany({
      where: {
        userId: options.userId,
        status: { in: ["pending", "sent"] },
        AND: [
          { OR: [{ agentHost: options.agentHost }, { agentHost: null }] },
          ...retryWindowFilter,
        ],
      },
      // Fresh pending commands must not be starved behind old sent rows that
      // are being retried for ack cleanup.
      orderBy: [{ status: "asc" }, { createdAt: "asc" }, { requestId: "asc" }],
      take: batchSize,
    });
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      warnMissingAgentOutboxTable(error);
      return { attempted: 0, delivered: 0 };
    }
    throw error;
  }

  const deliveryResults = await Promise.all(rows.map((row) =>
    tryDeliverRow(
      {
        id: row.id,
        userId: row.userId,
        agentHost: row.agentHost,
        taskId: row.taskId,
        eventType: row.eventType,
        requestId: row.requestId,
        createdAt: row.createdAt,
        payloadJson: row.payloadJson,
      },
      options,
    )
  ));

  return {
    attempted: rows.length,
    delivered: deliveryResults.filter(Boolean).length,
  };
}

export async function deliverAgentOutboxRow(
  row: AgentOutboxDeliveryRow,
  options: DeliverAgentOutboxOptions,
): Promise<{ delivered: boolean }> {
  try {
    const delivered = await tryDeliverRow(row, options);
    return { delivered };
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      warnMissingAgentOutboxTable(error);
      return { delivered: false };
    }
    throw error;
  }
}

export async function acknowledgeAgentCommand(input: {
  userId: string;
  requestId: string;
  accepted?: boolean;
  eventType?: string;
}): Promise<{ count: number }> {
  const accepted = input.accepted !== false;
  let countResult;
  try {
    countResult = await db.agentOutbox.updateMany({
      where: {
        userId: input.userId,
        requestId: input.requestId,
        status: { not: "acked" },
      },
      data: {
        status: "acked",
        ackedAt: new Date(),
        lastError: accepted ? null : `nack:${input.eventType || "unknown"}`,
      },
    });
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      warnMissingAgentOutboxTable(error);
      return { count: 0 };
    }
    throw error;
  }
  return { count: countResult.count };
}
