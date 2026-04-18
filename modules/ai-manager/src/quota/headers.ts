/** Convert fetch Headers to a case-insensitive plain map. */
export function headersToMap(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export function num(map: Record<string, string>, key: string): number | undefined {
  const v = map[key.toLowerCase()];
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function str(map: Record<string, string>, key: string): string | undefined {
  const v = map[key.toLowerCase()];
  return v === undefined || v === "" ? undefined : v;
}

export function bool(map: Record<string, string>, key: string): boolean | undefined {
  const v = map[key.toLowerCase()];
  if (v === undefined) return undefined;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  return undefined;
}
