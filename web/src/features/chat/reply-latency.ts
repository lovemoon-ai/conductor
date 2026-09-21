import type { Message } from '@/shared/types';

type Attempt = { taskId: string; startedAt: number; replyTo?: string };
type Observation = { taskId: string; replyTo: string; messageId: string; receivedAt?: number; committedAt?: number };
const attempts = new Set<Attempt>();
const observations = new Map<string, Observation>();
const MAX_ENTRIES = 100;
const MAX_AGE_MS = 30 * 60 * 1000;

function enabled() {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem('CONDUCTOR_DEBUG') === '1';
  } catch {
    return false;
  }
}

function prune(now: number) {
  for (const attempt of attempts) {
    if (now - attempt.startedAt > MAX_AGE_MS) attempts.delete(attempt);
  }
  for (const [key, observation] of observations) {
    if (now - (observation.receivedAt ?? observation.committedAt ?? now) > MAX_AGE_MS) observations.delete(key);
  }
  while (attempts.size > MAX_ENTRIES) attempts.delete(attempts.values().next().value!);
  while (observations.size > MAX_ENTRIES) observations.delete(observations.keys().next().value!);
}

function report(attempt: Attempt) {
  if (!attempt.replyTo) return;
  const observed = observations.get(JSON.stringify([attempt.taskId, attempt.replyTo]));
  if (observed?.committedAt === undefined || observed.committedAt < attempt.startedAt) return;
  attempts.delete(attempt);
  if (!enabled()) return;
  console.info('[conductor-reply-latency]', {
    taskId: attempt.taskId,
    replyTo: attempt.replyTo,
    messageId: observed.messageId,
    // DOM commit is a measurable boundary, not a browser paint or visibility guarantee.
    sendToFirstReplyCommitMs: observed.committedAt - attempt.startedAt,
    sendToReceivedMs: observed.receivedAt === undefined ? null : observed.receivedAt - attempt.startedAt,
    receivedToCommitMs: observed.receivedAt === undefined ? null : observed.committedAt - observed.receivedAt,
    documentHidden: document.hidden,
  });
}

export function beginReplyTiming(taskId: string) {
  if (!enabled()) return undefined;
  const attempt: Attempt = { taskId, startedAt: performance.now() };
  attempts.add(attempt);
  prune(attempt.startedAt);
  return {
    bind(replyTo: string) {
      if (!attempts.has(attempt)) return;
      attempt.replyTo = replyTo;
      report(attempt);
    },
    cancel() { attempts.delete(attempt); },
  };
}

export function observeReplyTiming(message: Message, stage: 'received' | 'committed') {
  if (!attempts.size) return;
  const now = performance.now();
  prune(now);
  const replyTo = message.metadata?.reply_to;
  if (typeof replyTo !== 'string' || !replyTo || message.metadata?.synthetic === true ||
      !['sdk', 'assistant'].includes(message.role) || !message.content.trim()) return;
  if (![...attempts].some((attempt) => attempt.taskId === message.taskId)) return;
  const key = JSON.stringify([message.taskId, replyTo]);
  const observed = observations.get(key) ?? { taskId: message.taskId, replyTo, messageId: message.id };
  // A turn can contain many messages. Only the first text reply is the TTFT candidate.
  if (observed.messageId !== message.id) return;
  if (stage === 'received') observed.receivedAt ??= now;
  else observed.committedAt ??= now;
  observations.set(key, observed);
  prune(now);
  for (const attempt of attempts) report(attempt);
}
