import { stat } from "node:fs/promises";
import { loadAiManagerConfig } from "./config.js";
import { getCurrentCodexAccount, listCodexAccounts, switchCodexAccount } from "./account.js";
import { checkInstall, checkInstallAll } from "./install.js";
import { checkNetwork, checkNetworkAll } from "./network.js";
import { getCodexQuota, readCachedCodexQuota, type GetCodexQuotaOptions } from "./quota/codex.js";
import { getClaudeQuota, type GetClaudeQuotaOptions } from "./quota/claude.js";
import { getKimiQuota, type GetKimiQuotaOptions } from "./quota/kimi.js";
import { getCopilotQuota, type GetCopilotQuotaOptions } from "./quota/copilot.js";
import {
  getExternalQuota,
  getExternalQuotaList,
  type GetExternalQuotaListOptions,
  type GetExternalQuotaOptions,
} from "./quota/external.js";
import { DEFAULT_CODEX_AUTH, DEFAULT_CONDUCTOR_CONFIG } from "./paths.js";
import type {
  AiManagerConfig,
  CodexAccount,
  CodexQuota,
  ClaudeQuota,
  ExternalQuota,
  ExternalQuotaList,
  KimiQuota,
  CopilotQuota,
  InstallStatus,
  NetworkStatus,
  SwitchResult,
  Tool,
} from "./types.js";

export interface AiManagerOptions {
  /** Path to conductor config.yaml. Default: ~/.conductor/config.yaml */
  configPath?: string;
  /** Path to the active codex auth.json. Default: ~/.codex/auth.json */
  codexAuthPath?: string;
  /** Pre-loaded config; skips loading from disk if provided. */
  config?: AiManagerConfig;
}

export class AiManager {
  private readonly configPath: string;
  private readonly codexAuthPath: string;
  private readonly configOverride?: AiManagerConfig;
  private cached?: { mtimeMs: number; value: AiManagerConfig };

  constructor(opts: AiManagerOptions = {}) {
    this.configPath = opts.configPath ?? DEFAULT_CONDUCTOR_CONFIG;
    this.codexAuthPath = opts.codexAuthPath ?? DEFAULT_CODEX_AUTH;
    this.configOverride = opts.config;
  }

  /**
   * Read the latest ai_manager config. Cached against the config file's mtime,
   * so edits to ~/.conductor/config.yaml are picked up immediately without
   * restarting the daemon, while a 30s polling cycle does not re-parse YAML
   * on every action. Falls back to always-reload if stat() fails.
   * The `config` constructor option short-circuits disk reads (used by tests).
   */
  async getConfig(): Promise<AiManagerConfig> {
    if (this.configOverride) return this.configOverride;
    try {
      const st = await stat(this.configPath);
      const mtimeMs = st.mtimeMs;
      if (this.cached && this.cached.mtimeMs === mtimeMs) {
        return this.cached.value;
      }
      const value = await loadAiManagerConfig(this.configPath);
      this.cached = { mtimeMs, value };
      return value;
    } catch {
      // ENOENT or stat failure → bypass cache and let loadAiManagerConfig
      // handle missing-file semantics (returns empty config).
      this.cached = undefined;
      return loadAiManagerConfig(this.configPath);
    }
  }

  /** Force the next getConfig() call to re-read the file from disk. */
  reloadConfig(): Promise<AiManagerConfig> {
    this.cached = undefined;
    return this.getConfig();
  }

  checkInstall(tool: Tool): Promise<InstallStatus> {
    return checkInstall(tool);
  }

  checkInstallAll(): Promise<Record<Tool, InstallStatus>> {
    return checkInstallAll();
  }

  checkNetwork(tool: Tool): Promise<NetworkStatus> {
    return checkNetwork(tool);
  }

  checkNetworkAll(): Promise<Record<Tool, NetworkStatus>> {
    return checkNetworkAll();
  }

  getCodexQuota(opts?: GetCodexQuotaOptions): Promise<CodexQuota> {
    return getCodexQuota({ codexAuthPath: this.codexAuthPath, ...opts });
  }

  /**
   * Read the last-cached codex quota for a specific auth file path, without
   * any network call. Enables `list_accounts` to return a "last known"
   * snapshot per account so the web UI can restore inactive-account quotas
   * across page refreshes.
   */
  readCachedCodexQuota(authPath: string): Promise<CodexQuota | null> {
    return readCachedCodexQuota(authPath);
  }

  getClaudeQuota(opts?: GetClaudeQuotaOptions): Promise<ClaudeQuota> {
    return getClaudeQuota(opts);
  }

  getKimiQuota(opts?: GetKimiQuotaOptions): Promise<KimiQuota> {
    return getKimiQuota(opts);
  }

  getCopilotQuota(opts?: GetCopilotQuotaOptions): Promise<CopilotQuota> {
    return getCopilotQuota(opts);
  }

  getExternalQuota(opts: GetExternalQuotaOptions): Promise<ExternalQuota> {
    return getExternalQuota({ configPath: this.configPath, ...opts });
  }

  getExternalQuotaList(opts: GetExternalQuotaListOptions): Promise<ExternalQuotaList> {
    return getExternalQuotaList({ configPath: this.configPath, ...opts });
  }

  async listCodexAccounts(): Promise<CodexAccount[]> {
    const cfg = await this.getConfig();
    return listCodexAccounts(cfg, this.codexAuthPath);
  }

  async getCurrentCodexAccount(): Promise<CodexAccount | null> {
    const cfg = await this.getConfig();
    return getCurrentCodexAccount(cfg, this.codexAuthPath);
  }

  async switchCodexAccount(name: string): Promise<SwitchResult> {
    const cfg = await this.getConfig();
    return switchCodexAccount(cfg, name, this.codexAuthPath);
  }
}
