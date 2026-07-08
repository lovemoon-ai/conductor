import type { NextRequest } from "next/server";

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_LOOKUP_URL = "https://ipapi.co/{ip}/json/";
const DEFAULT_LOOKUP_TIMEOUT_MS = 1500;
const DISABLED_VALUES = new Set(["0", "false", "off", "no", "disabled"]);

const TIMEZONE_HEADERS = [
  "x-client-timezone",
  "x-timezone",
  "x-vercel-ip-timezone",
  "cf-timezone",
];

const IP_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "x-client-ip",
  "x-vercel-forwarded-for",
];

const envValue = (name: string): string => process.env[name]?.trim() ?? "";

export const isValidClientTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

const normalizeTimezone = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed && isValidClientTimezone(trimmed) ? trimmed : null;
};

const stripPort = (value: string): string => {
  if (value.startsWith("[") && value.includes("]")) {
    return value.slice(1, value.indexOf("]"));
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
    return value.slice(0, value.lastIndexOf(":"));
  }
  return value;
};

const isPrivateOrLocalIp = (ip: string): boolean => {
  const normalized = ip.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }

  const parts = normalized.split(".").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
};

export const getClientIpFromHeaders = (headers: Headers): string | null => {
  for (const header of IP_HEADERS) {
    const value = headers.get(header);
    if (!value) continue;
    const first = value.split(",")[0]?.trim();
    if (!first || first.toLowerCase() === "unknown") continue;
    const ip = stripPort(first);
    if (!ip || isPrivateOrLocalIp(ip)) continue;
    return ip;
  }
  return null;
};

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const value = Number(envValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const extractTimezoneFromLookupPayload = (payload: unknown): string | null => {
  if (typeof payload === "string") {
    return normalizeTimezone(payload);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  return normalizeTimezone(record.timezone) ??
    normalizeTimezone(record.time_zone) ??
    normalizeTimezone(record.tz);
};

const readLookupPayload = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export async function resolveClientTimezone(request: NextRequest): Promise<string> {
  for (const header of TIMEZONE_HEADERS) {
    const timezone = normalizeTimezone(request.headers.get(header));
    if (timezone) {
      return timezone;
    }
  }

  const ip = getClientIpFromHeaders(request.headers);
  if (!ip) {
    return DEFAULT_TIMEZONE;
  }

  const lookupUrlTemplate = envValue("DAILY_REPORT_TIMEZONE_LOOKUP_URL") || DEFAULT_LOOKUP_URL;
  if (DISABLED_VALUES.has(lookupUrlTemplate.toLowerCase())) {
    return DEFAULT_TIMEZONE;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    readPositiveIntEnv("DAILY_REPORT_TIMEZONE_LOOKUP_TIMEOUT_MS", DEFAULT_LOOKUP_TIMEOUT_MS),
  );

  try {
    const response = await fetch(lookupUrlTemplate.replace("{ip}", encodeURIComponent(ip)), {
      headers: { Accept: "application/json, text/plain;q=0.9" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return DEFAULT_TIMEZONE;
    }
    return extractTimezoneFromLookupPayload(await readLookupPayload(response)) ?? DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  } finally {
    clearTimeout(timeout);
  }
}
