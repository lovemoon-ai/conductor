import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateToken } from "@/lib/auth/service";
import {
  isDaemonShareUser,
  isShareHostAllowed,
  resolveActiveShareForToken,
} from "@/lib/daemon-share/scope";
import {
  commitAgentCommandAck,
  commitSdkMessage,
  commitTaskStopAck,
  commitTaskStatusUpdate,
} from "@/lib/realtime/agent-upstream";

const sdkMessageSchema = z.object({
  event_type: z.literal("sdk_message"),
  task_id: z.string().min(1),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  message_id: z.string().min(1).optional(),
});

const taskStatusSchema = z.object({
  event_type: z.literal("task_status_update"),
  task_id: z.string().min(1),
  status: z.string().min(1),
  summary: z.string().optional(),
  status_event_id: z.string().min(1).optional(),
});

const agentCommandAckSchema = z.object({
  event_type: z.literal("agent_command_ack"),
  request_id: z.string().min(1),
  task_id: z.string().optional(),
  accepted: z.boolean().optional(),
  command_event_type: z.string().optional(),
});

const taskStopAckSchema = z.object({
  event_type: z.literal("task_stop_ack"),
  task_id: z.string().min(1),
  request_id: z.string().min(1),
  accepted: z.boolean().optional(),
});

const agentEventSchema = z.discriminatedUnion("event_type", [
  sdkMessageSchema,
  taskStatusSchema,
  agentCommandAckSchema,
  taskStopAckSchema,
]);

const requestSchema = z.object({
  agent_host: z.string().min(1),
  events: z.array(agentEventSchema).min(1),
});

const extractBearerToken = (request: NextRequest): string | null => {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || scheme.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  return token;
};

export async function POST(request: NextRequest) {
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await authenticateToken(token);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { agent_host: agentHost, events } = parsed.data;

  // RFC 0035: `agent_host` comes straight from the body and is never checked
  // against the credential. For a share token that is the whole attack:
  // `ensureAgentOwnsTaskRecord` accepts any host equal to the task's assigned
  // host, so an unpinned token could impersonate the grantee's real daemon --
  // appending fabricated `sdk` messages to a live transcript, flipping task
  // status, and rewriting `executionHost` to steer routing. Pin it to the
  // share's own guest host (or one of its fire hosts).
  if (isDaemonShareUser(user)) {
    const binding = await resolveActiveShareForToken(token, user.id);
    if (!binding || !isShareHostAllowed(binding, agentHost)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  // Process events sequentially to preserve causal ordering within a batch
  // (e.g. messages must be committed before the final status update).
  const results = [];
  for (const event of events) {
    if (event.event_type === "sdk_message") {
      const result = await commitSdkMessage({
        userId: user.id,
        agentHost,
        taskId: event.task_id,
        content: event.content,
        metadata: event.metadata,
        messageId: event.message_id,
      });
      results.push({
        event_type: event.event_type,
        task_id: result.taskId,
        message_id: result.messageId,
        duplicate: result.duplicate,
      });
    } else if (event.event_type === "task_status_update") {
      const result = await commitTaskStatusUpdate({
        userId: user.id,
        agentHost,
        taskId: event.task_id,
        status: event.status,
        summary: event.summary,
        statusEventId: event.status_event_id,
      });
      results.push({
        event_type: event.event_type,
        task_id: result.taskId,
        status: result.status,
        duplicate: result.duplicate,
      });
    } else if (event.event_type === "task_stop_ack") {
      const result = await commitTaskStopAck({
        userId: user.id,
        agentHost,
        taskId: event.task_id,
        requestId: event.request_id,
        accepted: event.accepted,
      });
      results.push({
        event_type: event.event_type,
        task_id: result.taskId,
        request_id: result.requestId,
        accepted: result.accepted,
        duplicate: result.duplicate,
      });
    } else {
      const result = await commitAgentCommandAck({
        userId: user.id,
        agentHost,
        requestId: event.request_id,
        taskId: event.task_id,
        eventType: event.command_event_type,
        accepted: event.accepted,
      });
      results.push({
        event_type: event.event_type,
        request_id: result.requestId,
        accepted: result.accepted,
        duplicate: result.duplicate,
      });
    }
  }

  return NextResponse.json({ results });
}
