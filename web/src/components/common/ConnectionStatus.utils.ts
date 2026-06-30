export function normalizeTaskId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

export function formatPercent(value?: number): string {
  if (!Number.isFinite(value)) {
    return 'n/a';
  }
  const rounded = Math.round((Number(value) + Number.EPSILON) * 10) / 10;
  return `${rounded}%`;
}
