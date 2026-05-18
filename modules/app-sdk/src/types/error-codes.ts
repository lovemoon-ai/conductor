/**
 * Map an HTTP status code (+ optional Conductor error body / message) onto a
 * `ConductorErrorCode`. Used by:
 *   - `src/server/fetcher.ts` (direct Conductor REST calls)
 *   - `src/react/adapter/rest-adapter.ts` (BFF pass-through; the BFF echoes
 *     Conductor's `{ error: "..." }` envelopes back to the browser, so the
 *     same string-sniffing logic applies).
 *
 * Centralised so the two layers don't drift. The function is pure
 * string + integer logic — no Node-only or DOM-only imports — so it can be
 * imported from both `/server` and `/react` bundles without violating the
 * bundle-smoke contract.
 */
import type { ConductorErrorCode } from './errors.js';

/**
 * Inspect Conductor's `{ error: "..." }` body shape to pull out a lowercased
 * marker string. We accept either an already-known string or an object that
 * looks like `{ error: string }`.
 */
function extractErrorMarker(details: unknown, message?: string | null): string {
  if (details && typeof details === 'object' && 'error' in details) {
    const raw = (details as { error?: unknown }).error;
    if (typeof raw === 'string') return raw.toLowerCase();
  }
  if (message) return message.toLowerCase();
  return '';
}

export function mapHttpStatusToErrorCode(
  status: number,
  details?: unknown,
  message?: string | null,
): ConductorErrorCode {
  const marker = extractErrorMarker(details, message);

  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) {
    if (marker.includes('project')) return 'project_not_found';
    if (marker.includes('task')) return 'task_not_found';
    if (marker.includes('message')) return 'message_not_found';
    return 'task_not_found';
  }
  if (status === 408) return 'timeout';
  if (status === 409) {
    // Order matters: `task_fire_owner_offline` mentions both "fire owner"
    // and "offline", but the more specific match wins. Same for the
    // task_type / not_running pair.
    if (marker.includes('fire owner')) return 'task_fire_owner_offline';
    if (marker.includes('task_type')) return 'task_type_not_messageable';
    if (marker.includes('not_running') || marker.includes('not running'))
      return 'task_not_running';
    if (marker.includes('daemon') || marker.includes('offline')) return 'daemon_offline';
    if (marker.includes('binding')) return 'binding_validation_failed';
    return 'binding_validation_failed';
  }
  if (status === 422) return 'invalid_input';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'invalid_input';
  return 'server_error';
}
