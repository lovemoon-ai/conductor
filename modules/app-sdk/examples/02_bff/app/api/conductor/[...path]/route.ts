/**
 * BFF pass-through for the widget's default REST adapter.
 *
 * Routes (relative to this catch-all):
 *
 *   GET  /tasks/:taskId/messages?pagination=1&limit&before_id
 *        → forwarded to client.tasks.history()
 *   POST /tasks/:taskId/messages
 *        → forwarded to client.tasks.sendMessage()
 *   POST /tasks/:taskId/interrupt
 *        → forwarded to client.tasks.interrupt()
 *   GET  /tasks/:taskId/events
 *        → SSE stream from client.tasks.subscribe()
 *
 * In a real BFF you'd:
 *   - Authenticate the requesting *user* (cookie / JWT) before each call.
 *   - Look up which Conductor task they're allowed to drive.
 *   - Probably rate-limit per user.
 *   - Possibly translate / strip metadata before forwarding to Conductor.
 *
 * The demo skips all of that — it trusts the local browser session.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@/lib/conductor';
import { isConductorAppError, ConductorAppError } from '@love-moon/app-sdk';

export const runtime = 'nodejs';
// SSE streams are long-lived; tell Next not to time them out.
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(req: NextRequest, ctx: RouteContext) {
  const segments = (await ctx.params).path ?? [];
  // Expect /tasks/:taskId/<messages|events>
  if (segments[0] !== 'tasks' || !segments[1]) return notFound();
  const taskId = decodeURIComponent(segments[1]);
  const op = segments[2];

  try {
    const client = await getClient();
    if (op === 'messages') {
      const url = new URL(req.url);
      const beforeId = url.searchParams.get('before_id') ?? undefined;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
      const page = await client.tasks.history(taskId, { beforeId, limit });
      // Translate to the wire shape the widget's REST adapter expects.
      return NextResponse.json({
        messages: page.messages,
        pagination: {
          has_more_before: page.hasMoreBefore,
          oldest_message_id: page.oldestMessageId,
        },
      });
    }

    if (op === 'events') {
      return startEventStream(req, taskId);
    }

    return notFound();
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const segments = (await ctx.params).path ?? [];
  if (segments[0] !== 'tasks' || !segments[1]) return notFound();
  const taskId = decodeURIComponent(segments[1]);
  const op = segments[2];

  try {
    const client = await getClient();
    const body = await req.json().catch(() => ({}));

    if (op === 'messages') {
      const content = String(body?.content ?? '');
      if (!content) {
        return NextResponse.json({ error: 'content required' }, { status: 400 });
      }
      // Threat model: the BFF is a trust boundary between the browser and
      // Conductor. The browser cannot be trusted to:
      //   - Author messages as `system` / `assistant` (would let an attacker
      //     forge AI replies in the chat log).
      //   - Stamp `audit.actor='app'` (would let an attacker disguise a
      //     browser-originated message as a server-side app message and
      //     defeat `streamReply`'s SDK-echo filter).
      // We therefore hard-code role='user' and strip metadata.audit before
      // forwarding. The SDK then stamps its own audit fields server-side.
      const incomingMetadata =
        body?.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
          ? { ...(body.metadata as Record<string, unknown>) }
          : undefined;
      if (incomingMetadata) delete incomingMetadata.audit;
      const msg = await client.tasks.sendMessage(taskId, {
        content,
        clientRequestId: typeof body?.clientRequestId === 'string' ? body.clientRequestId : undefined,
        role: 'user',
        ...(incomingMetadata ? { metadata: incomingMetadata } : {}),
      });
      return NextResponse.json(msg);
    }

    if (op === 'interrupt') {
      const targetReplyTo = String(body?.target_reply_to ?? body?.targetReplyTo ?? '');
      if (!targetReplyTo) {
        return NextResponse.json({ error: 'target_reply_to required' }, { status: 400 });
      }
      await client.tasks.interrupt(taskId, { targetReplyTo });
      return NextResponse.json({ ok: true });
    }

    if (op === 'restart') {
      // Only reached when the widget's adapter is created with
      // `enableRestart: true` (see app/page.tsx). Forward to Conductor.
      const restartMode =
        typeof body?.restart_mode === 'string' ? body.restart_mode : 'refresh_session';
      await client.tasks.restart(taskId, { restartMode });
      return NextResponse.json({ ok: true });
    }

    return notFound();
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Bridge the SDK's `subscribe(taskId)` AsyncIterable to a Server-Sent Events
 * response. The widget connects via `new EventSource(...)` and renders each
 * `data: <JSON>` line as a ChatEvent.
 *
 * Lifecycle:
 *   - Client navigates away → req.signal aborts → we break the loop, the
 *     AsyncIterator's return() runs, and the underlying WS subscription is
 *     released.
 */
async function startEventStream(req: NextRequest, taskId: string): Promise<Response> {
  const client = await getClient();
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  // Name the listener so we can remove it in cleanup. Otherwise long-lived
  // edge runtimes / proxies that reuse the same request signal would leak
  // listeners across SSE streams.
  const onRequestAbort = (): void => abortController.abort();
  let removeReqAbortListener: (() => void) | null = null;
  if (req.signal.aborted) {
    abortController.abort();
  } else {
    req.signal.addEventListener('abort', onRequestAbort, { once: true });
    removeReqAbortListener = () => {
      req.signal.removeEventListener('abort', onRequestAbort);
    };
  }

  // Keep-alive timer: emit an SSE comment every 15s to keep idle
  // connections alive past proxy timeouts (nginx default 60s,
  // some CDNs lower).
  let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    async start(controller) {
      // Safe wrapper: enqueue can throw `TypeError` once the controller
      // is closed (e.g. after `cancel()` fires). Returning false signals
      // the producer loop to bail out.
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(chunk);
          return true;
        } catch {
          closed = true;
          return false;
        }
      };

      // SSE preamble: a comment line tells some proxies "keep this alive".
      if (!safeEnqueue(encoder.encode(':ok\n\n'))) return;

      keepAliveTimer = setInterval(() => {
        // Backpressure check: if the client isn't draining the stream fast
        // enough (negative desiredSize means the internal queue is over the
        // high-water mark), skip this keep-alive tick rather than piling
        // more chunks into the buffer. The real events that follow are
        // small; missing a keep-alive comment is harmless.
        if (typeof controller.desiredSize === 'number' && controller.desiredSize < 0) {
          return;
        }
        if (!safeEnqueue(encoder.encode(': keepalive\n\n'))) {
          if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
          }
        }
      }, 15_000);

      try {
        for await (const event of client.tasks.subscribe(taskId, {
          signal: abortController.signal,
        })) {
          if (closed || req.signal.aborted) break;
          const ok = safeEnqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
          if (!ok) break;
        }
      } catch (err) {
        // Surface terminal errors as a synthetic event then close. Preserve
        // the original ConductorAppError `code` (e.g. `task_not_running`,
        // `daemon_offline`) rather than hard-coding `subscribe_failed` — the
        // browser-side widget switches its UI hint based on the code, so
        // collapsing every terminal error to a single bucket would lose
        // useful disambiguation. Fall back to `subscribe_failed` only when
        // the thrown value isn't an SDK error.
        const code =
          err instanceof ConductorAppError ? err.code : 'subscribe_failed';
        const payload = {
          type: 'task_failed',
          taskId,
          error: {
            code,
            message: (err as Error)?.message ?? 'subscribe stream ended',
          },
        };
        safeEnqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      } finally {
        cleanup();
        if (!closed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      abortController.abort();
      cleanup();
    },
  });

  function cleanup() {
    closed = true;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (removeReqAbortListener) {
      removeReqAbortListener();
      removeReqAbortListener = null;
    }
  }

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Prevent buffering proxies (nginx) from holding events back.
      'X-Accel-Buffering': 'no',
    },
  });
}

function notFound() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

function errorResponse(err: unknown) {
  if (isConductorAppError(err)) {
    return NextResponse.json(
      { error: err.message, code: err.code },
      { status: err.status ?? 500 },
    );
  }
  return NextResponse.json(
    { error: (err as Error)?.message ?? 'Internal error' },
    { status: 500 },
  );
}
