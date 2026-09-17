'use client';

import type { Message } from '@/shared/types';
import {
  PERSISTENT_ROUND_END_KIND,
  PERSISTENT_ROUND_START_KIND,
} from '@/shared/utils/persistent-task';

/** One round of a persistent task within the loaded messages (RFC 0039). */
export interface PersistentRoundGroup {
  round: number;
  /** Inclusive start / exclusive end index into the message list. */
  startIndex: number;
  endIndex: number;
  /** The `persistent_round_start` divider, absent for round 1. */
  divider: Message | null;
  startedAt: string | null;
  backend: string | null;
  /** First line of the AI's end-of-round summary, if any. */
  summaryLine: string | null;
}

const readKind = (message: Message): unknown => message.metadata?.kind;

export const isPersistentRoundDivider = (message: Message): boolean =>
  message.role === 'sdk' && readKind(message) === PERSISTENT_ROUND_START_KIND;

const readRound = (message: Message): number | null => {
  const round = message.metadata?.round;
  return typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : null;
};

const findSummaryLine = (messages: Message[]): string | null => {
  const request = messages.find(
    (message) => message.role === 'user' && readKind(message) === PERSISTENT_ROUND_END_KIND,
  );
  if (!request) return null;
  const reply = [...messages]
    .reverse()
    .find((message) => message.role !== 'user' && message.metadata?.reply_to === request.id);
  const lines = (reply?.content ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  // Summaries are usually markdown: skip a title heading and strip list/emphasis markers.
  const line = lines.find((entry) => !entry.startsWith('#')) ?? lines[0];
  return line ? line.replace(/^[#>*\-\s]+/, '').replace(/\*\*/g, '') || null : null;
};

/**
 * Splits the loaded messages into rounds at each divider. Returns an empty list
 * when no divider is loaded, so ordinary tasks and a persistent task's first
 * round render exactly as before.
 */
export const buildPersistentRoundGroups = (messages: Message[]): PersistentRoundGroup[] => {
  const dividerIndices = messages.flatMap((message, index) =>
    isPersistentRoundDivider(message) ? [index] : [],
  );
  if (dividerIndices.length === 0) return [];

  const starts = dividerIndices[0] > 0 ? [0, ...dividerIndices] : dividerIndices;
  return starts.map((startIndex, position) => {
    const endIndex = starts[position + 1] ?? messages.length;
    const slice = messages.slice(startIndex, endIndex);
    const divider = isPersistentRoundDivider(messages[startIndex]) ? messages[startIndex] : null;
    const round = divider
      ? readRound(divider) ?? position + 1
      : Math.max(1, (readRound(messages[dividerIndices[0]]) ?? 2) - 1);
    const backend = divider?.metadata?.backend_type;
    return {
      round,
      startIndex,
      endIndex,
      divider,
      startedAt: messages[startIndex]?.createdAt ?? null,
      backend: typeof backend === 'string' ? backend : null,
      summaryLine: findSummaryLine(slice),
    };
  });
};

interface PersistentRoundHeaderProps {
  group: PersistentRoundGroup;
  collapsed: boolean;
  /** Omitted for the current round, which is always expanded. */
  onToggle?: () => void;
}

export function PersistentRoundHeader({ group, collapsed, onToggle }: PersistentRoundHeaderProps) {
  const details = [
    `Round ${group.round}`,
    group.startedAt ? new Date(group.startedAt).toLocaleDateString() : null,
    group.backend,
  ].filter(Boolean).join(' · ');
  const label = (
    <>
      <span className="shrink-0 font-medium text-ink">{details}</span>
      {collapsed && group.summaryLine ? <span className="truncate">{group.summaryLine}</span> : null}
    </>
  );

  if (!onToggle) {
    return (
      <div data-testid="persistent-round-header" className="flex items-center gap-2 text-xs text-muted">
        <span className="h-px flex-1 bg-border" />
        {label}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="persistent-round-header"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-xl border border-border bg-paper/60 px-3 py-2 text-left text-xs text-muted transition-colors hover:border-[var(--accent)]"
    >
      <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
      {label}
    </button>
  );
}
