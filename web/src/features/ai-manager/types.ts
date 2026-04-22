// Mirror of @love-moon/ai-manager response shapes (loose; daemon may add fields).
// We intentionally avoid importing the SDK directly so frontend bundles stay small.

export type Tool = 'codex' | 'claude' | 'kimi' | 'copilot';

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

export interface CodexAccount {
  name: string;
  path: string;
  email?: string;
  accountId?: string;
  planType?: string;
  lastRefresh?: string;
  isCurrent: boolean;
}

export interface QuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  resetAt?: number;
  resetAfterSeconds?: number;
  status?: string;
  windowMinutes?: number;
  limit?: number;
  used?: number;
  remaining?: number;
}

export interface CodexQuota {
  tool: 'codex';
  plan?: string;
  activeLimit?: string;
  email?: string;
  accountId?: string;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  credits?: { hasCredits: boolean; balance?: string; unlimited: boolean };
  fetchedAt?: number;
  source: 'fresh' | 'cached' | 'stale' | 'unknown';
  error?: string;
}

export interface ClaudeQuota {
  tool: 'claude';
  overallStatus?: string;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  weeklySonnet?: QuotaWindow;
  overage?: { status?: string; disabledReason?: string };
  fetchedAt?: number;
  source: 'fresh' | 'cached' | 'stale' | 'unknown';
  error?: string;
}

export interface StatusResponse {
  install: Record<Tool, InstallStatus>;
  network: Record<Tool, NetworkStatus>;
  currentCodexAccount: CodexAccount | null;
}

export interface KimiQuota {
  tool: 'kimi';
  userId?: string;
  region?: string;
  membership?: string;
  fiveHour: QuotaWindow;
  weekly: QuotaWindow;
  parallelLimit?: number;
  fetchedAt?: number;
  source: 'fresh' | 'cached' | 'stale' | 'unknown';
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
  tool: 'copilot';
  primary?: QuotaWindow;
  chat?: QuotaWindow;
  completions?: QuotaWindow;
  premiumInteractions?: QuotaWindow;
  snapshots: Record<string, CopilotQuotaSnapshot>;
  fetchedAt?: number;
  source: 'fresh' | 'cached' | 'stale' | 'unknown';
  error?: string;
}

export interface QuotaResponse {
  codex?: CodexQuota;
  claude?: ClaudeQuota;
  kimi?: KimiQuota;
  copilot?: CopilotQuota;
}

export interface AccountsResponse {
  accounts: CodexAccount[];
}

export interface SwitchResponse {
  previousName?: string;
  newName: string;
  backupPath: string;
}
