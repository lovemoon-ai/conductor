/**
 * Heuristic scoring for "is this DOM node our input box / send button /
 * assistant message?" — implements RFC §8.
 *
 * The scoring functions operate on a plain-object descriptor that the
 * provider adapter assembles from a Playwright Locator. This keeps the
 * scoring logic pure and testable.
 */

export interface ElementDescriptor {
  tag: string;
  role?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  type?: string | null;
  contentEditable?: boolean;
  visible?: boolean;
  editable?: boolean;
  enabled?: boolean;
  text?: string | null;
  /** Normalised viewport y in [0,1] where 1 == bottom. */
  viewportY?: number;
  /** Truthy if the element lives inside a sidebar / settings / search panel. */
  inAuxiliaryRegion?: boolean;
  /** Truthy if the element looks like a navigation/history item. */
  inHistory?: boolean;
  /** Approx distance in px to the message input. */
  distanceToInput?: number;
  /** Truthy if the element exposes a send/arrow-style icon. */
  hasSendIcon?: boolean;
  /** For assistant message scoring. */
  authorRole?: string | null;
  insideMainConversation?: boolean;
  containsProse?: boolean;
  appearedAfterUserMessage?: boolean;
  textGrew?: boolean;
}

const INPUT_HINTS = [
  "message",
  "prompt",
  "ask",
  "ask anything", // ChatGPT 2026-era placeholder
  "chat with chatgpt", // ChatGPT aria-label on the ProseMirror editor
  "输入",
  "提问",
  "发送消息",
  "给 deepseek",
];

const SEND_HINTS = ["send", "发送"];

function containsAny(text: string | null | undefined, needles: string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

export function scoreInputCandidate(el: ElementDescriptor): number {
  let score = 0;

  if (el.role === "textbox") score += 5;
  if (el.tag === "textarea" || el.contentEditable) score += 5;
  if (containsAny(el.placeholder, INPUT_HINTS)) score += 4;
  if (containsAny(el.ariaLabel, INPUT_HINTS)) score += 4;
  if (el.visible) score += 3;
  if (el.editable) score += 3;
  if (typeof el.viewportY === "number" && el.viewportY > 0.5) score += 2;

  if (el.inAuxiliaryRegion) score -= 5;
  if (el.visible === false) score -= 5;
  if (el.enabled === false) score -= 5;

  return score;
}

export function scoreSendButtonCandidate(el: ElementDescriptor): number {
  let score = 0;

  if (containsAny(el.ariaLabel, SEND_HINTS)) score += 5;
  if (el.tag === "button") score += 4;
  if (typeof el.distanceToInput === "number" && el.distanceToInput < 200) score += 3;
  if (el.enabled) score += 3;
  if (el.hasSendIcon) score += 2;

  if (el.visible === false) score -= 5;
  if (el.enabled === false) score -= 5;

  return score;
}

export function scoreAssistantMessageCandidate(el: ElementDescriptor): number {
  let score = 0;

  if (el.authorRole === "assistant") score += 5;
  if (el.insideMainConversation) score += 4;
  if (el.containsProse) score += 3;
  if (el.appearedAfterUserMessage) score += 2;
  if (el.textGrew) score += 2;

  if (el.inAuxiliaryRegion || el.inHistory) score -= 5;

  return score;
}

/** Pick the highest-scoring candidate; ties keep the first listed. */
export function pickBest<T>(items: T[], scorer: (item: T) => number): T | null {
  if (items.length === 0) return null;
  let best = items[0]!;
  let bestScore = scorer(best);
  for (let i = 1; i < items.length; i++) {
    const candidate = items[i]!;
    const s = scorer(candidate);
    if (s > bestScore) {
      best = candidate;
      bestScore = s;
    }
  }
  return best;
}
