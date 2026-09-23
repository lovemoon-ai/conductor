/**
 * kimi-cli answers `/clear` itself, without calling the model, with a fixed
 * line (see kimi_cli/soul/slash.py). Both kimi modes verify that line before
 * reporting success: if a kimi version ever stops treating `/clear` as a
 * built-in, the text reaches the model as an ordinary turn — which grows the
 * context instead of clearing it — and we must fail loudly rather than tell the
 * user their context is gone.
 *
 * Kept in one place so the two modes cannot drift apart, in either direction.
 */
const KIMI_CLEAR_ACK = /context has been cleared/i;

function createClearFailedError(message) {
  const error = new Error(message);
  error.reason = "clear_failed";
  return error;
}

export function assertKimiClearReply(reply) {
  const text = String(reply || "");
  if (KIMI_CLEAR_ACK.test(text)) {
    return;
  }
  throw createClearFailedError(`Kimi clear failed${text.trim() ? `: ${text.trim()}` : ""}`);
}
