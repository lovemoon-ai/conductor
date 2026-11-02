import type { Conversation, RuntimeState, Turn } from "./types.js";
import { isTerminal } from "./types.js";

const DAY = 86_400_000;
export const retentionPolicy = Object.freeze({
  maxConversations: 256, maxClosedConversations: 32, maxTurns: 4096,
  closedTtlMs: 7 * DAY, openIdleTtlMs: 7 * DAY, terminalTtlMs: 7 * DAY, resultGraceMs: 60_000,
});
const time = (value: string | undefined, fallback: number) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** Runs inside the store transaction. Never collect work owned by a live operation. */
export function pruneRuntimeState(state: RuntimeState, protectedChats: Set<string>, protectedTurns: Set<string>,
  reserve: { conversations?: number; turns?: number } = {}, now = Date.now()): Conversation[] {
  const removed: Conversation[] = [];
  const byChat = new Map<string, Turn[]>();
  for (const turn of Object.values(state.turns)) {
    const turns = byChat.get(turn.conversationId) ?? [];
    turns.push(turn); byChat.set(turn.conversationId, turns);
  }
  const closed = Object.values(state.conversations).filter(chat => chat.closed && !protectedChats.has(chat.id) &&
    !(byChat.get(chat.id) ?? []).some(turn => !isTerminal(turn.status) || protectedTurns.has(turn.id)))
    .sort((a, b) => time(a.closedAt, now) - time(b.closedAt, now));
  let conversationCount = Object.keys(state.conversations).length;
  let closedCount = closed.length;
  for (const chat of closed) {
    if (now - time(chat.closedAt, now) < retentionPolicy.closedTtlMs &&
      closedCount <= retentionPolicy.maxClosedConversations && conversationCount + (reserve.conversations ?? 0) <= retentionPolicy.maxConversations) continue;
    delete state.conversations[chat.id];
    for (const turn of byChat.get(chat.id) ?? []) delete state.turns[turn.id];
    removed.push(chat); conversationCount--; closedCount--;
  }
  for (const chat of Object.values(state.conversations)) {
    if (chat.closed || chat.needsReview || protectedChats.has(chat.id) ||
      now - time(chat.lastActivityAt, time(chat.createdAt, now)) < retentionPolicy.openIdleTtlMs ||
      (byChat.get(chat.id) ?? []).some(turn => !isTerminal(turn.status) || protectedTurns.has(turn.id))) continue;
    delete state.conversations[chat.id];
    for (const turn of byChat.get(chat.id) ?? []) delete state.turns[turn.id];
    removed.push(chat);
  }
  const candidates = Object.values(state.turns).filter(turn => isTerminal(turn.status) && (turn.status !== "uncertain" || !state.conversations[turn.conversationId]?.needsReview) && !protectedTurns.has(turn.id))
    .map(turn => ({ turn, finished: time(turn.events.at(-1)?.at, time(turn.createdAt, now)) }))
    .filter(entry => now - entry.finished >= retentionPolicy.resultGraceMs)
    .sort((a, b) => a.finished - b.finished);
  let turnCount = Object.keys(state.turns).length;
  // Drop a batch under pressure rather than running into the limit after every turn.
  const pressured = turnCount + (reserve.turns ?? 0) > retentionPolicy.maxTurns;
  const target = pressured ? Math.floor(retentionPolicy.maxTurns * 0.75) : retentionPolicy.maxTurns;
  for (const { turn, finished } of candidates) {
    if (now - finished < retentionPolicy.terminalTtlMs && turnCount + (reserve.turns ?? 0) <= target) continue;
    delete state.turns[turn.id]; turnCount--;
  }
  return removed;
}
