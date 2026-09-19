export function normalizeTaskId(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] || null;
  }
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return null;
}

const tokenCountFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

export function formatTokenCount(value?: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? tokenCountFormat.format(value) : 'n/a';
}
