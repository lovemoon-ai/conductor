export type Tool = "codex" | "claude" | "kimi" | "copilot";

export interface InstallStatus {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface NetworkStatus {
  reachable: boolean;
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
  endpoint: string;
}

export interface QuotaWindow {
  /** Percentage of the window already used, 0-100. */
  usedPercent: number;
  /** Percentage of the window remaining, 0-100. */
  remainingPercent: number;
  /** Seconds until the window resets. */
  resetAfterSeconds?: number;
  /** Unix timestamp (seconds) at which the window resets. */
  resetAt?: number;
  /** Calendar date when the provider only exposes day-level reset semantics. */
  resetOnDate?: string;
  /** Status label from the provider (allowed/warning/blocked), if any. */
  status?: string;
  /** Window length in minutes, if known (300 = 5h, 10080 = 7d). */
  windowMinutes?: number;
  /** Absolute counts when the provider exposes them (Kimi). */
  limit?: number;
  used?: number;
  remaining?: number;
}

export interface CodexQuota {
  tool: "codex";
  plan?: string;
  activeLimit?: string;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  credits?: {
    hasCredits: boolean;
    balance?: string;
    unlimited: boolean;
  };
  fetchedAt: number;
  source: "fresh" | "cached" | "stale" | "unknown";
  email?: string;
  accountId?: string;
  raw?: Record<string, string>;
  error?: string;
}

export interface ClaudeQuota {
  tool: "claude";
  plan?: string;
  overallStatus?: string;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  weeklySonnet?: QuotaWindow;
  overage?: {
    status?: string;
    disabledReason?: string;
  };
  fetchedAt: number;
  source: "fresh" | "cached" | "stale" | "unknown";
  raw?: Record<string, string>;
  error?: string;
}

export interface KimiQuota {
  tool: "kimi";
  userId?: string;
  region?: string;
  membership?: string;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  parallelLimit?: number;
  fetchedAt: number;
  source: "fresh" | "cached" | "stale" | "unknown";
  raw?: Record<string, unknown>;
  error?: string;
}

export interface CopilotQuotaSnapshot {
  entitlementRequests: number;
  usedRequests: number;
  remainingPercentage: number;
  overage: number;
  overageAllowedWithExhaustedQuota: boolean;
  resetDate?: string;
  isUnlimitedEntitlement?: boolean;
  usageAllowedWithExhaustedQuota?: boolean;
}

export interface CopilotQuota {
  tool: "copilot";
  /** Best single quota window to show when callers do not care about quota type. */
  primary?: QuotaWindow;
  chat?: QuotaWindow;
  completions?: QuotaWindow;
  premiumInteractions?: QuotaWindow;
  login?: string;
  authType?: string;
  host?: string;
  loginSource?: "sdk" | "github_token";
  snapshots: Record<string, CopilotQuotaSnapshot>;
  fetchedAt: number;
  source: "fresh" | "cached" | "stale" | "unknown";
  raw?: Record<string, unknown>;
  error?: string;
}

export interface CodexAccount {
  /** Short label derived from file name (strip `auth_` prefix and `.json` suffix). */
  name: string;
  /** Absolute path to the auth.json file. */
  path: string;
  email?: string;
  accountId?: string;
  planType?: string;
  lastRefresh?: string;
  isCurrent: boolean;
  /**
   * Last-known quota snapshot for this account read from the daemon's on-disk
   * cache. Populated by `list_accounts` so web clients can restore an
   * inactive account's bars across page refreshes without a network call.
   * Absent when the daemon has never successfully fetched quota for this
   * account.
   */
  cachedQuota?: CodexQuota;
}

export interface SwitchResult {
  previousName?: string;
  newName: string;
  backupPath: string;
}

export interface AiManagerConfig {
  codex: {
    authJson: string[];
  };
}
