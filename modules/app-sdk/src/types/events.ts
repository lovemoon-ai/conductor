import type { Message } from './message.js';
import type { RuntimeStatus } from './runtime.js';

/**
 * ChatEvent: the minimal set of events the chat widget needs to render.
 *
 * This is intentionally a small union — the widget should not have to
 * pattern-match dozens of envelope types. The default REST/WS adapter
 * funnels raw `/ws/app` envelopes into ChatEvents; custom adapters can do the
 * same translation against any wire format.
 */
/**
 * Error shape carried inside `task_failed` ChatEvents and `error`
 * StreamReplyDeltas.
 *
 * `details` and `cause` are optional, free-form passthroughs of the original
 * SDK error's structured fields — useful for surfacing request IDs / server
 * payloads in host UIs without depending on the SDK error class directly.
 */
export interface ChatEventError {
  code: string;
  message: string;
  details?: unknown;
  cause?: unknown;
}

export type ChatEvent =
  | { type: 'message_appended'; message: Message }
  | { type: 'message_updated'; message: Message }
  | { type: 'runtime_status'; status: RuntimeStatus }
  | { type: 'task_finished'; taskId: string }
  | {
      type: 'task_failed';
      taskId: string;
      error: ChatEventError;
    }
  | {
      type: 'connection_state';
      state: 'connected' | 'reconnecting' | 'offline';
    };

/**
 * StreamReplyDelta: a streaming AI reply chunk yielded by
 * `client.tasks.streamReply(id)`.
 *
 * v1 semantics: each `text` delta is a *cumulative* preview-style chunk
 * (built from `task_runtime_status.reply_preview` rolling state). The final
 * `done` delta carries the full reply Message. A future RFC may add real
 * token-level streaming; the shape is forward-compatible.
 */
export type StreamReplyDelta =
  | { type: 'text'; text: string; replyTo: string }
  | { type: 'status'; status: RuntimeStatus }
  | { type: 'done'; message: Message }
  | {
      type: 'error';
      error: ChatEventError;
    };
