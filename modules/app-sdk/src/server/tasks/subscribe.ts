/**
 * Async-iterable wrapper around AppWebSocket: yields ChatEvents for a single
 * task. Bridges the push-based socket into a pull-based for-await loop with
 * back-pressure tolerance (events arriving while no consumer is awaiting
 * are buffered in memory).
 */
import type { ChatEvent } from '../../types/events.js';
import type { AppWebSocket } from '../ws/socket.js';
import { envelopeToChatEvent } from '../ws/envelope.js';

export interface SubscribeOptions {
  signal?: AbortSignal;
  /**
   * Cap on the in-memory event buffer. When exceeded, we drop the oldest
   * `runtime_status` first (these are rolling previews; missing one is
   * harmless because the next one supersedes it). Only if no runtime_status
   * remains in the buffer do we fall back to plain drop-oldest. The chat
   * surface prioritizes preserving `message_appended` / `task_failed` /
   * `task_finished` events over preview deltas.
   * Default 1024.
   */
  bufferCap?: number;
}

export function subscribeToTask(
  socket: AppWebSocket,
  taskId: string,
  opts?: SubscribeOptions,
): AsyncIterable<ChatEvent> {
  const bufferCap = opts?.bufferCap ?? 1024;
  // Multi-iteration safety:
  //
  //   All per-iteration state — the queue, the pending resolver, the done
  //   flag, AND the socket subscriptions themselves — lives inside
  //   [Symbol.asyncIterator](). Each `for await ... of` consumes a fresh
  //   iterator with its own buffered queue and listener set. Iterating twice
  //   over the same returned AsyncIterable yields two independent streams
  //   (modulo the underlying socket, which is shared).
  //
  //   Previously these were hoisted to module-call scope; a second
  //   iteration would have shared a single queue, double-fired listeners,
  //   and broken `signal` cleanup. The async-iteration protocol allows
  //   re-iteration, so we honor it.
  return {
    [Symbol.asyncIterator](): AsyncIterator<ChatEvent> {
      const queue: ChatEvent[] = [];
      let pendingResolver:
        | { resolve: (value: IteratorResult<ChatEvent>) => void }
        | null = null;
      let done = false;

      const drain = (): void => {
        if (!pendingResolver) return;
        if (queue.length > 0) {
          const value = queue.shift()!;
          const resolver = pendingResolver;
          pendingResolver = null;
          resolver.resolve({ value, done: false });
          return;
        }
        if (done) {
          const resolver = pendingResolver;
          pendingResolver = null;
          resolver.resolve({ value: undefined as never, done: true });
        }
      };

      /**
       * On overflow, prefer to drop the oldest `runtime_status` entry — these
       * are cumulative preview deltas and the next one supersedes any dropped
       * predecessor. Only when none remain do we fall back to plain
       * drop-oldest, so terminal events (message_appended / task_failed /
       * task_finished) survive even under heavy churn.
       */
      const evictForCap = (): void => {
        while (queue.length > bufferCap) {
          const idx = queue.findIndex((e) => e.type === 'runtime_status');
          if (idx >= 0) {
            queue.splice(idx, 1);
          } else {
            queue.shift();
          }
        }
      };

      const envelopeSub = socket.onEnvelope((envelope) => {
        if (done) return;
        const event = envelopeToChatEvent(envelope, taskId);
        if (!event) return;
        queue.push(event);
        evictForCap();
        drain();
      });

      const stateSub = socket.onConnectionState((state) => {
        if (done) return;
        queue.push({ type: 'connection_state', state });
        evictForCap();
        drain();
      });

      // When the client closes the socket, surface a synthetic terminal
      // `task_failed` and end the iterator. Without this, the consumer's
      // for-await would park forever after AppClient.close() — the
      // rawListener was cleared by socket.close() so no further envelopes
      // can wake it.
      const closeUnsub = socket.onClose(() => {
        if (done) return;
        queue.push({
          type: 'task_failed',
          taskId,
          error: {
            code: 'subscribe_failed',
            message: 'client closed',
          },
        });
        evictForCap();
        drain();
        finish();
      });

      const onAbort = (): void => finish();
      const finish = (): void => {
        if (done) return;
        done = true;
        envelopeSub.unsubscribe();
        stateSub.unsubscribe();
        closeUnsub();
        if (opts?.signal) {
          opts.signal.removeEventListener('abort', onAbort);
        }
        drain();
      };

      if (opts?.signal) {
        if (opts.signal.aborted) {
          finish();
        } else {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }

      return {
        next(): Promise<IteratorResult<ChatEvent>> {
          if (queue.length > 0) {
            const value = queue.shift()!;
            return Promise.resolve({ value, done: false });
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => {
            pendingResolver = { resolve };
          });
        },
        return(): Promise<IteratorResult<ChatEvent>> {
          finish();
          return Promise.resolve({ value: undefined as never, done: true });
        },
      };
    },
  };
}
