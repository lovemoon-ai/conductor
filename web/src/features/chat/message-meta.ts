import { create } from 'zustand';
import { formatTokenCount } from '@/components/common/ConnectionStatus.utils';

/** Which side of its bubble a message's meta line (time, token usage) sits on. */
export type MetaSide = 'top' | 'bottom';

/** `floating`: the slot is off screen, so the line sticks to the view's edge over the bubble's text. */
export interface MetaPlacement {
  side: MetaSide;
  floating: boolean;
}

const SIDES: MetaSide[] = ['top', 'bottom'];
// The line sits in the gap between bubbles (`space-y-2`).
const SLOT_PX = 8;

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The server records a reply's `turn_usage`: the turn's tokens, the task total
 * after it, and how much of the turn's input the prompt cache served.
 */
export function formatTurnUsage(metadata?: Record<string, unknown> | null): string[] {
  const usage = metadata?.turn_usage;
  if (!usage || typeof usage !== 'object') {
    return [];
  }
  const { tokens, task_tokens: taskTokens, input_tokens: input, cached_input_tokens: cached } = usage as Record<string, unknown>;
  const parts: string[] = [];
  if (isCount(tokens)) parts.push(`Turn ${formatTokenCount(tokens)}`);
  if (isCount(taskTokens)) parts.push(`Task ${formatTokenCount(taskTokens)}`);
  if (isCount(input) && isCount(cached) && input > 0) {
    parts.push(`Cache ${Math.min(100, Math.floor((cached / input) * 100))}%`);
  }
  return parts;
}

/**
 * Where a message's meta line goes:
 * 1. a side whose slot is on screen;
 * 2. of those, one no other shown line takes, so neighbours never share the gap between them;
 * 3. failing that, the first on-screen side, hiding the lines it would cover.
 * With neither slot on screen (a bubble taller than the view) the line floats
 * at the view's edge, so both sides stay candidates.
 */
export function chooseMetaSide(
  fits: Record<MetaSide, boolean>,
  takenBy: Record<MetaSide, string[]>,
): MetaPlacement & { evict: string[] } {
  const onScreen = SIDES.filter((side) => fits[side]);
  const candidates = onScreen.length > 0 ? onScreen : SIDES;
  const side = candidates.find((candidate) => takenBy[candidate].length === 0) ?? candidates[0];
  return { side, floating: !fits[side], evict: takenBy[side] };
}

function visibleBounds(element: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const rect = node.getBoundingClientRect();
      top = Math.max(top, rect.top);
      bottom = Math.min(bottom, rect.bottom);
      break;
    }
  }
  return { top, bottom };
}

/** Measures `bubble`'s slots against the view and the meta lines already shown. */
export function placeMessageMeta(bubble: HTMLElement, messageId: string, shown: Record<string, MetaPlacement>) {
  const rect = bubble.getBoundingClientRect();
  const view = visibleBounds(bubble);
  const slots: Record<MetaSide, [number, number]> = {
    top: [rect.top - SLOT_PX, rect.top],
    bottom: [rect.bottom, rect.bottom + SLOT_PX],
  };
  const takenBy: Record<MetaSide, string[]> = { top: [], bottom: [] };
  bubble.ownerDocument.querySelectorAll<HTMLElement>('[data-message-meta]').forEach((line) => {
    const owner = line.dataset.messageMeta;
    if (!owner || owner === messageId || !shown[owner]) return;
    const box = line.getBoundingClientRect();
    SIDES.forEach((side) => {
      if (box.top < slots[side][1] && slots[side][0] < box.bottom) takenBy[side].push(owner);
    });
  });
  return chooseMetaSide({ top: slots.top[0] >= view.top, bottom: slots.bottom[1] <= view.bottom }, takenBy);
}

interface MessageMetaState {
  /** Meta lines shown by a tap, by message id. */
  shown: Record<string, MetaPlacement>;
  show: (messageId: string, placement: MetaPlacement, evict: string[]) => void;
  hide: (messageId: string) => void;
}

export const useMessageMetaStore = create<MessageMetaState>((set) => ({
  shown: {},
  show: (messageId, placement, evict) =>
    set((state) => {
      const shown = { ...state.shown, [messageId]: placement };
      evict.forEach((id) => delete shown[id]);
      return { shown };
    }),
  hide: (messageId) =>
    set((state) => {
      if (!(messageId in state.shown)) return state;
      const shown = { ...state.shown };
      delete shown[messageId];
      return { shown };
    }),
}));
