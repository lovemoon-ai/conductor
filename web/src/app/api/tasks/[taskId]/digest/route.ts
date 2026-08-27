import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  buildDigestSourcePacket,
  summarizeHandoffDigest,
  HandoffDigestError,
} from "@/lib/tasks/handoff-digest";

/**
 * Create an LLM-summarized handoff digest for a task.
 *
 * POST /api/tasks/{taskId}/digest
 *
 * Builds a bounded source packet from the task's recent messages and asks the
 * configured LLM to summarize it into a clean Markdown handoff. Fails visibly
 * (5xx) when the summarizer is unavailable rather than returning the raw
 * transcript as if it were a digest. The returned Markdown can then be inserted
 * into another task via POST /api/tasks/{targetTaskId}/insert.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) {
    return userResult;
  }
  const user = userResult;
  const { taskId } = await params;

  const packet = await buildDigestSourcePacket({ userId: user.id, taskId });
  if (!packet) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (packet.messageCount === 0) {
    return NextResponse.json(
      { error: "empty_task", message: "Task has no messages to summarize" },
      { status: 409 },
    );
  }

  try {
    const result = await summarizeHandoffDigest({ packet });
    return NextResponse.json({
      ok: true,
      task_id: taskId,
      digest_markdown: result.digestMarkdown,
      summarizer: result.summarizer,
      source: {
        message_count: packet.messageCount,
        truncated_messages: packet.truncatedMessages,
      },
    });
  } catch (error) {
    if (error instanceof HandoffDigestError) {
      const status = error.reason === "missing_api_key" ? 503 : 502;
      return NextResponse.json(
        { error: "digest_failed", reason: error.reason, message: error.message },
        { status },
      );
    }
    throw error;
  }
}
