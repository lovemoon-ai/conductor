import { getExternalProviderDescriptor } from "../../external-provider-registry.js";
import type { ExternalQuota, ExternalQuotaList, QuotaWindow } from "../types.js";

export interface GetExternalQuotaOptions {
  /** External ai-sdk provider backend or alias. */
  backend: string;
  model?: string;
  forceRefresh?: boolean;
  ttlSeconds?: number;
  timeoutMs?: number;
  configPath?: string;
}

export interface GetExternalQuotaListOptions {
  /** External ai-sdk provider backend or alias. */
  backend: string;
  forceRefresh?: boolean;
  ttlSeconds?: number;
  timeoutMs?: number;
  configPath?: string;
}

type Source = ExternalQuota["source"];
type ExternalProviderDescriptor = {
  backend: string;
  getQuota?: ((options?: Record<string, unknown>) => Promise<unknown>) | null;
  getQuotaList?: ((options?: Record<string, unknown>) => Promise<unknown>) | null;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeSource(value: unknown): Source {
  return value === "fresh" || value === "cached" || value === "stale" || value === "unknown"
    ? value
    : "unknown";
}

function normalizeWindow(value: unknown): QuotaWindow {
  const record = isRecord(value) ? value : {};
  const usedPercent = normalizeNumber(record.usedPercent) ?? 0;
  const remainingPercent = normalizeNumber(record.remainingPercent) ?? Math.max(0, 100 - usedPercent);
  const window: QuotaWindow = {
    usedPercent,
    remainingPercent,
  };
  const resetAfterSeconds = normalizeNumber(record.resetAfterSeconds);
  if (resetAfterSeconds !== undefined) window.resetAfterSeconds = resetAfterSeconds;
  const resetAt = normalizeNumber(record.resetAt);
  if (resetAt !== undefined) window.resetAt = resetAt;
  const resetOnDate = normalizeString(record.resetOnDate);
  if (resetOnDate) window.resetOnDate = resetOnDate;
  const status = normalizeString(record.status);
  if (status) window.status = status;
  const windowMinutes = normalizeNumber(record.windowMinutes);
  if (windowMinutes !== undefined) window.windowMinutes = windowMinutes;
  const limit = normalizeNumber(record.limit);
  if (limit !== undefined) window.limit = limit;
  const used = normalizeNumber(record.used);
  if (used !== undefined) window.used = used;
  const remaining = normalizeNumber(record.remaining);
  if (remaining !== undefined) window.remaining = remaining;
  return window;
}

export function normalizeExternalQuota(value: unknown, options: {
  backend: string;
  model?: string;
  error?: string;
}): ExternalQuota {
  const record = isRecord(value) ? value : {};
  const model = normalizeString(record.model) ?? normalizeString(options.model) ?? "";
  return {
    backend: options.backend,
    model,
    daily: normalizeWindow(record.daily),
    fetchedAt: normalizeNumber(record.fetchedAt) ?? nowSeconds(),
    source: normalizeSource(record.source),
    username: normalizeString(record.username),
    organization: normalizeString(record.organization),
    label: normalizeString(record.label),
    limitSource: normalizeString(record.limitSource),
    quotaReleaseMode: normalizeString(record.quotaReleaseMode),
    quotaResetTime: normalizeString(record.quotaResetTime),
    error: normalizeString(record.error) ?? options.error,
    raw: isRecord(record.raw) ? record.raw : undefined,
  };
}

export function normalizeExternalQuotaList(value: unknown, options: {
  backend: string;
  error?: string;
}): ExternalQuotaList {
  const record = isRecord(value) ? value : {};
  const quotas = Array.isArray(record.quotas)
    ? record.quotas.map((item) => normalizeExternalQuota(item, { backend: options.backend }))
    : [];
  const quotaByModel: Record<string, ExternalQuota> = {};
  for (const quota of quotas) {
    if (quota.model) {
      quotaByModel[quota.model] = quota;
    }
  }
  return {
    backend: options.backend,
    fetchedAt: normalizeNumber(record.fetchedAt) ?? nowSeconds(),
    source: normalizeSource(record.source),
    username: normalizeString(record.username),
    organization: normalizeString(record.organization),
    label: normalizeString(record.label),
    count: normalizeNumber(record.count) ?? quotas.length,
    quotas,
    quotaByModel,
    error: normalizeString(record.error) ?? options.error,
    raw: isRecord(record.raw) ? record.raw : undefined,
  };
}

function emptyQuota(error: string, options: { backend: string; model?: string }): ExternalQuota {
  return {
    backend: options.backend,
    model: options.model ?? "",
    daily: { usedPercent: 0, remainingPercent: 0 },
    fetchedAt: nowSeconds(),
    source: "unknown",
    error,
  };
}

function emptyQuotaList(error: string, options: { backend: string }): ExternalQuotaList {
  return {
    backend: options.backend,
    fetchedAt: nowSeconds(),
    source: "unknown",
    count: 0,
    quotas: [],
    quotaByModel: {},
    error,
  };
}

async function getExternalDescriptor(
  backend: string,
  configPath?: string,
): Promise<ExternalProviderDescriptor | null> {
  return getExternalProviderDescriptor(
    backend,
    configPath ? { configFile: configPath } : {},
  ) as Promise<ExternalProviderDescriptor | null>;
}

function providerOptions(opts: GetExternalQuotaOptions | GetExternalQuotaListOptions) {
  return {
    backend: opts.backend,
    model: "model" in opts ? opts.model : undefined,
    forceRefresh: opts.forceRefresh,
    ttlSeconds: opts.ttlSeconds,
    timeoutMs: opts.timeoutMs,
    configPath: opts.configPath,
  };
}

export async function getExternalQuota(
  opts: GetExternalQuotaOptions,
): Promise<ExternalQuota> {
  const backend = normalizeString(opts.backend);
  if (!backend) {
    return emptyQuota("external provider backend is required", { backend: "", model: opts.model });
  }
  try {
    const descriptor = await getExternalDescriptor(backend, opts.configPath);
    if (!descriptor?.getQuota) {
      return emptyQuota("external provider quota hook unavailable", { backend, model: opts.model });
    }
    const result = await descriptor.getQuota(providerOptions({ ...opts, backend }));
    return normalizeExternalQuota(result, { backend: descriptor.backend || backend, model: opts.model });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyQuota(message, { backend, model: opts.model });
  }
}

export async function getExternalQuotaList(
  opts: GetExternalQuotaListOptions,
): Promise<ExternalQuotaList> {
  const backend = normalizeString(opts.backend);
  if (!backend) {
    return emptyQuotaList("external provider backend is required", { backend: "" });
  }
  try {
    const descriptor = await getExternalDescriptor(backend, opts.configPath);
    if (!descriptor?.getQuotaList) {
      return emptyQuotaList("external provider quota list hook unavailable", { backend });
    }
    const result = await descriptor.getQuotaList(providerOptions({ ...opts, backend }));
    return normalizeExternalQuotaList(result, { backend: descriptor.backend || backend });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyQuotaList(message, { backend });
  }
}
