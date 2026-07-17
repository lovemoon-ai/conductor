// Mirror of @love-moon/ai-sdk manager response shapes (loose; daemon may add fields).
// We intentionally avoid importing the SDK directly so frontend bundles stay small.

export type Tool = 'codex' | 'claude' | 'kimi' | 'copilot';
export type QuotaSource = 'fresh' | 'cached' | 'stale' | 'unknown';

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
  /**
   * Last-known quota snapshot surfaced by the daemon from its on-disk cache.
   * Seeded into the store by `fetchAccounts` so inactive-account quotas
   * survive a full page refresh. Missing when the daemon has never fetched a
   * live quota for this account.
   */
  cachedQuota?: CodexQuota;
}

export interface QuotaWindow {
  usedPercent: number;
  remainingPercent: number;
  resetAt?: number;
  resetAfterSeconds?: number;
  resetOnDate?: string;
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
  weekly?: QuotaWindow;
  credits?: { hasCredits: boolean; balance?: string; unlimited: boolean };
  fetchedAt?: number;
  source: QuotaSource;
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
  source: QuotaSource;
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
  source: QuotaSource;
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
  login?: string;
  authType?: string;
  host?: string;
  loginSource?: 'sdk' | 'github_token';
  snapshots: Record<string, CopilotQuotaSnapshot>;
  fetchedAt?: number;
  source: QuotaSource;
  error?: string;
}

export interface ExternalQuota {
  backend?: string;
  model: string;
  daily: QuotaWindow;
  fetchedAt?: number;
  source: QuotaSource;
  username?: string;
  organization?: string;
  label?: string;
  limitSource?: string;
  quotaReleaseMode?: string;
  quotaResetTime?: string;
  error?: string;
}

export interface ExternalQuotaList {
  backend?: string;
  fetchedAt?: number;
  source: QuotaSource;
  username?: string;
  organization?: string;
  label?: string;
  count: number;
  quotas: ExternalQuota[];
  quotaByModel?: Record<string, ExternalQuota>;
  error?: string;
}

export interface QuotaResponse {
  codex?: CodexQuota;
  claude?: ClaudeQuota;
  kimi?: KimiQuota;
  copilot?: CopilotQuota;
  external?: Record<string, ExternalQuotaList>;
}

export interface AccountsResponse {
  accounts: CodexAccount[];
}

export interface SwitchResponse {
  previousName?: string;
  newName: string;
  backupPath: string;
}

export interface CustomCommandInfo {
  key: string;
  running?: boolean;
  runId?: string;
}

export interface CustomCommandsResponse {
  commands: CustomCommandInfo[];
}

export type CustomCommandRunStatusValue = 'running' | 'completed' | 'failed';

export interface CustomCommandRunResponse {
  started: boolean;
  key: string;
  runId: string;
  status: CustomCommandRunStatusValue;
  pid?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

export interface CustomCommandRunStatus {
  runId: string;
  key: string;
  status: CustomCommandRunStatusValue;
  pid?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  stdoutTail?: string;
  stderrTail?: string;
  error?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}
