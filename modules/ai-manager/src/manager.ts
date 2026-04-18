import { loadAiManagerConfig } from "./config.ts";
import { getCurrentCodexAccount, listCodexAccounts, switchCodexAccount } from "./account.ts";
import { checkInstall, checkInstallAll } from "./install.ts";
import { checkNetwork, checkNetworkAll } from "./network.ts";
import { getCodexQuota, type GetCodexQuotaOptions } from "./quota/codex.ts";
import { getClaudeQuota, type GetClaudeQuotaOptions } from "./quota/claude.ts";
import { DEFAULT_CODEX_AUTH, DEFAULT_CONDUCTOR_CONFIG } from "./paths.ts";
import type {
  AiManagerConfig,
  CodexAccount,
  CodexQuota,
  ClaudeQuota,
  InstallStatus,
  NetworkStatus,
  SwitchResult,
  Tool,
} from "./types.ts";

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
  private configCache?: AiManagerConfig;

  constructor(opts: AiManagerOptions = {}) {
    this.configPath = opts.configPath ?? DEFAULT_CONDUCTOR_CONFIG;
    this.codexAuthPath = opts.codexAuthPath ?? DEFAULT_CODEX_AUTH;
    this.configCache = opts.config;
  }

  async getConfig(): Promise<AiManagerConfig> {
    if (!this.configCache) {
      this.configCache = await loadAiManagerConfig(this.configPath);
    }
    return this.configCache;
  }

  reloadConfig(): Promise<AiManagerConfig> {
    this.configCache = undefined;
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

  getClaudeQuota(opts?: GetClaudeQuotaOptions): Promise<ClaudeQuota> {
    return getClaudeQuota(opts);
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
