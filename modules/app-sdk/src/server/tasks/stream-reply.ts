/**
 * streamReply: yield the AI's reply as it builds up.
 *
 * v1 source material is what the backend already emits:
 *   - task_runtime_status.reply_preview → rolling-text deltas.
 *   - task_sdk_message  (role=assistant) → the final, persisted Message.
 *   - task_status_update (status=failed) → error termination.
 *
 * We yield `{ type: 'text', text, replyTo }` whenever `reply_preview` changes,
 * then a `{ type: 'done', message }` when the assistant message persists, and
 * close. Caller can `for await ... break;` early; we clean up the underlying
 * subscription.
 *
 * Forward compat: when the backend gains a true token-level envelope, we add
 * a new delta type and switch the source. Callers using `text` continue to
 * work; callers using the new richer delta opt in.
 */
import type { StreamReplyDelta } from '../../types/events.js';
import { subscribeToTask } from './subscribe.js';
import type { AppWebSocket } from '../ws/socket.js';

export interface StreamReplyOptions {
  signal?: AbortSignal;
  /**
   * If a reply is already mid-flight when the iterator starts, the first
   * `text` chunk will reflect the existing preview, not a true delta from
   * zero. Set to `false` to skip the bootstrap preview.
   */
  emitInitialPreview?: boolean;
  /**
   * Maximum time (ms) to wait between two `text`/`status` deltas before
   * yielding a terminal `error` with code `stream_aborted` and closing the
   * iterator. Prevents the loop from hanging forever if only user echoes /
   * app echoes / synthetic system messages flow on the socket.
   *
   * Default `120_000` (2 minutes). Set to `0` to disable.
   */
  idleTimeoutMs?: number;
}

function isAppOriginEcho(metadata: Record<string, unknown> | null): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const audit = (metadata as { audit?: unknown }).audit;
  if (!audit || typeof audit !== 'object') return false;
  return (audit as { actor?: unknown }).actor === 'app';
}

function isSyntheticSystemMessage(metadata: Record<string, unknown> | null): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as { synthetic?: unknown }).synthetic === true;
}

export function streamReplyForTask(
  socket: AppWebSocket,
  taskId: string,
  opts?: StreamReplyOptions,
): AsyncIterable<StreamReplyDelta> {
  const emitInitial = opts?.emitInitialPreview ?? true;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? 120_000;
  return {
    async *[Symbol.asyncIterator]() {
      let lastPreview = '';
      let lastStatusState: string | null = null;
      let bootstrapped = !emitInitial;
      let currentReplyTo: string | null = null;

      // Idle timeout: if no text/status delta is yielded within
      // `idleTimeoutMs`, abort the underlying subscription via this
      // controller so the for-await loop unblocks. The race below then
      // synthesizes a terminal `error` delta.
      const idleController = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let idleFired = false;
      const armIdle = () => {
        if (idleTimeoutMs <= 0) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleFired = true;
          idleController.abort();
        }, idleTimeoutMs);
      };
      const disarmIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
      };

      // Compose external signal with the idle controller so either ends
      // the inner iterator.
      let composedSignal: AbortSignal | undefined;
      const externalSignal = opts?.signal;
      // Name the listener so we can remove it on cleanup; otherwise long-lived
      // external AbortControllers accumulate listeners every time streamReply
      // is invoked. `{ once: true }` is belt-and-suspenders — abort can only
      // fire once anyway, but it documents intent and lets the platform free
      // the slot immediately.
      const onExternalAbort = (): void => idleController.abort();
      if (externalSignal && externalSignal.aborted) {
        composedSignal = externalSignal;
      } else if (externalSignal) {
        externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        composedSignal = idleController.signal;
      } else {
        composedSignal = idleController.signal;
      }

      armIdle();

      try {
        for await (const event of subscribeToTask(socket, taskId, {
          signal: composedSignal,
        })) {
          if (event.type === 'runtime_status') {
            const status = event.status;
            const replyTo = status.replyTo ?? currentReplyTo ?? '';
            if (status.replyTo) currentReplyTo = status.replyTo;
            const preview = status.replyPreview ?? '';
            const previewAdvanced = preview !== '' && preview !== lastPreview;
            if (previewAdvanced) {
              // Emit the preview delta. Backend `reply_preview` is the
              // cumulative text so far, not a single delta. We slice off
              // the previously seen prefix when possible; on a reset
              // (preview not monotonically growing) we treat the new
              // preview as a fresh delta.
              const isContinuation = preview.startsWith(lastPreview);
              yield {
                type: 'text',
                text: bootstrapped && isContinuation
                  ? preview.slice(lastPreview.length)
                  : preview,
                replyTo,
              };
              lastPreview = preview;
              bootstrapped = true;
            }
            yield { type: 'status', status };
            // Only re-arm the idle timer when there's been real progress:
            // the preview advanced, OR the status.state transitioned. The
            // backend can republish identical `runtime_status` envelopes
            // (e.g. keep-alive heartbeats); re-arming on those would defeat
            // the idle-timeout safety net for stuck streams.
            const stateChanged = status.state !== lastStatusState;
            if (previewAdvanced || stateChanged) {
              armIdle();
              lastStatusState = status.state;
            }
            continue;
          }

          if (event.type === 'message_appended') {
            const message = event.message;
            // Skip the user's own outbound: either the human prompt (role=user)
            // or the SDK's outbound echo (role=sdk + audit.actor='app' that we
            // stamped on send). Everything else is an AI / system reply.
            //
            // Why role alone isn't enough: backends like codex emit their AI
            // reply as role='sdk' (the daemon writes it via commitSdkMessage),
            // identical role to what the SDK uses for outbound. The audit
            // marker is the only deterministic signal that distinguishes
            // "the message we just sent" from "the AI's reply".
            if (message.role === 'user') {
              continue;
            }
            if (isAppOriginEcho(message.metadata)) {
              continue;
            }
            // Skip daemon-emitted system info (codex "session started", etc.).
            // These carry `metadata.synthetic === true` per the backend
            // convention; they're system-info messages, not the AI's reply.
            if (isSyntheticSystemMessage(message.metadata)) {
              continue;
            }
            yield { type: 'done', message };
            return;
          }

          if (event.type === 'task_failed') {
            yield { type: 'error', error: event.error };
            return;
          }

          if (event.type === 'task_finished') {
            // Task finished without a final assistant message (e.g. interrupted).
            // Emit a terminal error so callers receive a definitive signal.
            yield {
              type: 'error',
              error: {
                code: 'task_not_running',
                message: 'task finished without reply',
              },
            };
            return;
          }
        }

        // If the inner iterator ended because of the idle timer aborting,
        // surface that as a terminal error.
        if (idleFired) {
          yield {
            type: 'error',
            error: {
              code: 'stream_aborted',
              message: 'idle timeout',
            },
          };
        }
      } finally {
        disarmIdle();
        // Remove the external-signal listener so we don't leak it on
        // long-lived AbortControllers. Safe to call even if abort already
        // fired (removeEventListener is a no-op for unregistered listeners).
        if (externalSignal && !externalSignal.aborted) {
          externalSignal.removeEventListener('abort', onExternalAbort);
        }
      }
    },
  };
}
