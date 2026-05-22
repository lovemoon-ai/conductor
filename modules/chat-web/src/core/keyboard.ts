import type { Page } from "playwright";

/**
 * A single instruction in the typing plan: either type literal text, or
 * press a key sequence. Exposed separately from the executor so we can
 * unit-test the *plan* without a real Playwright Page.
 */
export type TypingAction =
  | { type: "type"; text: string }
  | { type: "press"; key: string };

/**
 * Plan how to type a (potentially multi-line) string into a chat composer.
 *
 * Why this exists:
 *   ChatGPT's ProseMirror and Google AI Studio's Angular textarea both
 *   bind `Enter` to "submit prompt" and `Shift+Enter` to "soft line
 *   break". `page.keyboard.type(text)` literally emits an `Enter` key
 *   event for every `\n` in `text`, which causes a multi-line prompt to
 *   be submitted line-by-line — exactly the bug we saw on the ATLAS
 *   arXiv prompt (task 09b34cf4-…), where one logical message landed on
 *   the assistant as 5 fragments.
 *
 * The fix: split the text on newlines, type each segment as literal
 * characters, and emit `Shift+Enter` between segments. The composer ends
 * up with the same visual content but is never prematurely submitted.
 */
export function planMultilineTyping(text: string): TypingAction[] {
  if (!text) return [];
  // Normalise line endings so \r\n and \r both collapse to \n splitting.
  const normalised = text.replace(/\r\n?/g, "\n");
  const segments = normalised.split("\n");
  const actions: TypingAction[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment) {
      actions.push({ type: "type", text: segment });
    }
    if (i < segments.length - 1) {
      actions.push({ type: "press", key: "Shift+Enter" });
    }
  }
  return actions;
}

/**
 * Execute a typing plan against a Playwright Page.
 *
 * Kept as a thin wrapper over `planMultilineTyping` so the interesting
 * logic stays in the pure function. Adapters call this from
 * `sendMessage`; they MUST NOT fall back to `page.keyboard.type(message)`
 * directly on user-supplied prompts.
 */
export async function typeMultiline(page: Page, text: string): Promise<void> {
  const actions = planMultilineTyping(text);
  for (const action of actions) {
    if (action.type === "type") {
      await page.keyboard.type(action.text);
    } else {
      await page.keyboard.press(action.key);
    }
  }
}
