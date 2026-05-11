/**
 * Shared audit-metadata helpers.
 *
 * Audit fields live exclusively under `metadata.audit.*` (RFC 0025 §5.2 +
 * review M3). Any top-level `actor` / `cliVersion` / `sdkVersion` /
 * `invokedBy` a caller supplies is silently dropped so it can't masquerade
 * as authoritative audit info. The trust boundary is the `audit` object
 * itself.
 *
 * Extracted to a shared module so the constant + function don't drift
 * between `/api/issues` and `/api/tasks/[id]/messages` (review M-NEW-2).
 */

export const AUDIT_RESERVED_TOP_LEVEL_KEYS = [
  "actor",
  "cliVersion",
  "sdkVersion",
  "invokedBy",
] as const;

export const stripTopLevelAuditKeys = (
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null => {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return metadata ?? null;
  }
  const next: Record<string, unknown> = { ...metadata };
  for (const key of AUDIT_RESERVED_TOP_LEVEL_KEYS) {
    if (key in next) delete next[key];
  }
  return next;
};
