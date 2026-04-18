export type Tool = "codex" | "claude" | "kimi";

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
