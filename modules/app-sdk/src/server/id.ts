/**
 * Environment-agnostic UUID generator. Uses `crypto.randomUUID()` when
 * available (Node 18+, modern browsers, edge runtimes), falling back to a
 * 16-byte hex string otherwise.
 */
export function generateRequestId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Last-resort fallback (should not happen on Node 18+ / browsers).
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
