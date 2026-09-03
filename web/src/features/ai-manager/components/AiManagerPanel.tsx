'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { SectionCard } from '@/components/common/SectionCard';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { useAgentsStore } from '@/features/agents';
import { getApiClient } from '@/shared/api/client';
import { useAiManagerStore } from '../store';
import type { ExternalQuota, ExternalQuotaList, StatusResponse, Tool } from '../types';
import { CodexAccountSwitcher } from './CodexAccountSwitcher';
import { CustomCommandsPanel } from './CustomCommandsPanel';
import { DaemonSharingCard } from '@/features/daemon-shares';
import { QuotaBar } from './QuotaBar';
import { ToolStatusRow } from './ToolStatusRow';
import { UpdateDaemonButton } from './UpdateDaemonButton';

interface AiManagerPanelProps {
  /** Daemon to display. Falls back to the first connected daemon when omitted. */
  initialAgentHost?: string;
}

/** Daemons that accept ai_manager_request. Excludes ephemeral fire hosts. */
function isManageableHost(host: string): boolean {
  return !host.startsWith('conductor-fire-');
}

const MANAGED_TOOL_ORDER: Tool[] = ['codex', 'claude', 'kimi', 'copilot', 'dsh'];
const BUILT_IN_NON_QUOTA_BACKENDS = new Set(['chat-web', 'opencode']);
const TOOL_ALIASES: Record<string, Tool> = {
  codex: 'codex',
  code: 'codex',
  claude: 'claude',
  'claude-code': 'claude',
  kimi: 'kimi',
  'kimi-cli': 'kimi',
  'kimi-code': 'kimi',
  copilot: 'copilot',
  dsh: 'dsh',
  'deepseek-harness': 'dsh',
};

function normalizeManagedTool(value: unknown): Tool | null {
  if (typeof value !== 'string') return null;
  return TOOL_ALIASES[value.trim().toLowerCase()] ?? null;
}

function supportedManagedTools(
  supportedBackends: string[],
  runtimeBackendMap?: Record<string, string>,
): Tool[] {
  const seen = new Set<Tool>();

  for (const backend of supportedBackends) {
    const normalizedBackend = backend.trim().toLowerCase();
    const runtimeBackend = runtimeBackendMap?.[backend] ?? runtimeBackendMap?.[normalizedBackend];
    const tool = normalizeManagedTool(runtimeBackend) ?? normalizeManagedTool(backend);
    if (tool) seen.add(tool);
  }

  return MANAGED_TOOL_ORDER.filter((tool) => seen.has(tool));
}

// Until daemon status is loaded we can't say a tool is installed *and*
// reachable, so we must not treat it as available — otherwise the Quota
// section would render advertised backends for a tool that may be uninstalled
// or unreachable once status finally arrives, which contradicts the
// "hide unavailable tools" requirement. Sections that want to show a
// loading state during the initial fetch should branch on
// `state.loading.status && !status` themselves (as both AI tools and Quota
// do below).
function isToolAvailable(tool: Tool, status: StatusResponse | null): boolean {
  if (!status) return false;
  return status.install[tool]?.installed === true && status.network[tool]?.reachable === true;
}

function quotaGridClass(count: number): string {
  if (count <= 1) return 'md:grid-cols-1';
  if (count === 2) return 'md:grid-cols-2';
  if (count === 3) return 'md:grid-cols-3';
  return 'md:grid-cols-4';
}

function externalQuotaBackends(
  backends: string[],
  runtimeBackendMap?: Record<string, string>,
): string[] {
  const out = new Set<string>();

  for (const backend of backends) {
    const normalizedBackend = backend.trim().toLowerCase();
    if (!normalizedBackend) continue;
    const runtimeBackend = runtimeBackendMap?.[backend] ?? runtimeBackendMap?.[normalizedBackend];
    if (normalizeManagedTool(runtimeBackend) || normalizeManagedTool(backend)) continue;
    if (
      BUILT_IN_NON_QUOTA_BACKENDS.has(String(runtimeBackend || '').trim().toLowerCase()) ||
      BUILT_IN_NON_QUOTA_BACKENDS.has(normalizedBackend)
    ) {
      continue;
    }
    out.add(normalizedBackend);
  }

  return [...out];
}

function formatPercent(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value)) return null;
  const normalized = Math.max(0, Math.min(100, value));
  return `${normalized.toFixed(0)}%`;
}

function formatExternalModelMeta(quota: ExternalQuota): string {
  const used = formatPercent(quota.daily.usedPercent);
  const remaining = formatPercent(quota.daily.remainingPercent);
  return [
    used ? `已用 ${used}` : null,
    remaining ? `剩余 ${remaining}` : null,
  ].filter(Boolean).join(' · ');
}

type ExternalQuotaListWithData = ExternalQuotaList & {
  quotas: [ExternalQuota, ...ExternalQuota[]];
};

function hasExternalQuotaData(
  providerQuota: ExternalQuotaList | undefined,
): providerQuota is ExternalQuotaListWithData {
  return Array.isArray(providerQuota?.quotas) && providerQuota.quotas.length > 0;
}

export function AiManagerPanel({ initialAgentHost }: AiManagerPanelProps = {}) {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const visibleDaemons = agents.filter((a) => isManageableHost(a.host));
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [restartingHost, setRestartingHost] = useState<string | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  const selectedHost = useAiManagerStore((s) => s.selectedHost);
  const setSelectedHost = useAiManagerStore((s) => s.setSelectedHost);
  const byHost = useAiManagerStore((s) => s.byHost);
  const fetchAll = useAiManagerStore((s) => s.fetchAll);
  const startPolling = useAiManagerStore((s) => s.startPolling);
  const stopPolling = useAiManagerStore((s) => s.stopPolling);

  useEffect(() => {
    void fetchAgents();
    return clearRestartTimer;
  }, [clearRestartTimer, fetchAgents]);

  // Honor the explicit prop on first mount (and whenever it changes), regardless of
  // any prior store selection. Falls back to the first connected manageable daemon
  // (skipping ephemeral conductor-fire-* hosts that don't expose ai_manager).
  useEffect(() => {
    if (initialAgentHost && initialAgentHost !== selectedHost) {
      setSelectedHost(initialAgentHost);
      return;
    }
    if (!selectedHost && visibleDaemons.length > 0) {
      setSelectedHost(visibleDaemons[0].host);
    }
  }, [initialAgentHost, visibleDaemons, selectedHost, setSelectedHost]);

  const host = selectedHost ?? visibleDaemons[0]?.host ?? '';
  const selectedDaemon = visibleDaemons.find((daemon) => daemon.host === host) ?? null;
  const supportsRestart = selectedDaemon?.capabilities?.includes('restart_daemon') ?? false;
  const supportsCustomCommands = selectedDaemon?.capabilities?.includes('custom_commands') ?? false;
  const supportsUpdate = selectedDaemon?.capabilities?.includes('update_daemon') ?? false;
  const supportedBackends = selectedDaemon?.supportedBackends ?? [];
  const managedTools = supportedManagedTools(supportedBackends, selectedDaemon?.runtimeBackendMap);
  const externalBackends = externalQuotaBackends(supportedBackends, selectedDaemon?.runtimeBackendMap);
  const externalBackendKey = externalBackends.join(',');
  const daemonVersion = selectedDaemon?.version ?? null;
  const isRestarting = restartingHost === host;

  // Fetch + poll whenever the selection changes.
  useEffect(() => {
    if (!selectedHost) return;
    const externalQuotaBackends = externalBackendKey ? externalBackendKey.split(',') : [];
    void fetchAll(selectedHost, { externalQuotaBackends });
    startPolling(selectedHost, { externalQuotaBackends });
    return () => stopPolling();
  }, [selectedHost, externalBackendKey, fetchAll, startPolling, stopPolling]);

  if (visibleDaemons.length === 0 && !selectedHost) {
    return (
      <SectionCard title="No daemon">
        <p className="text-sm text-muted">
          No daemons connected. Run <code>conductor daemon</code> on a machine to get started.
        </p>
      </SectionCard>
    );
  }

  const state = byHost[host];
  const status = state?.status ?? null;
  const availableTools = managedTools.filter((tool) => isToolAvailable(tool, status));
  const quota = state?.quota ?? null;
  const visibleExternalQuotaEntries = externalBackends.flatMap((backend) => {
    const providerQuota = quota?.external?.[backend];
    return hasExternalQuotaData(providerQuota) ? [{ backend, providerQuota }] : [];
  });
  const accounts = state?.accounts?.accounts ?? [];
  const codexQuotaByAccount = state?.codexQuotaByAccount ?? {};

  // Surface codex errors that couldn't be pinned to an individual account card.
  // `resolveCodexAccountName` returns undefined (store.ts) when the daemon
  // returns an error payload without identity fields and we also can't fall
  // back to status.currentCodexAccount; in that case no per-account card
  // renders the error, so we need a column-level fallback. We also check
  // whether the last fetch's error is already being shown on some card; if so,
  // we skip the fallback to avoid duplicating it.
  const codexLastError = quota?.codex?.error;
  const codexErrorAlreadyOnCard =
    Boolean(codexLastError) &&
    Object.values(codexQuotaByAccount).some((q) => q?.error === codexLastError);
  const unattributedCodexError = codexLastError && !codexErrorAlreadyOnCard ? codexLastError : null;

  const handleRestartDaemon = async () => {
    if (!host || !supportsRestart || isRestarting) {
      return;
    }

    const accepted = await confirm({
      title: `Restart daemon on ${host}?`,
      description:
        'This upgrades the conductor CLI to the latest version and restarts the daemon. Running tasks on this daemon will be interrupted.',
      confirmLabel: 'Restart',
      tone: 'danger',
    });
    if (!accepted) return;

    clearRestartTimer();
    setRestartingHost(host);
    try {
      const api = getApiClient();
      await api.post(`/agents/${encodeURIComponent(host)}/restart`, { targetVersion: 'latest' });
      pushToast({
        title: 'Restart requested',
        description: `${host} will reconnect after upgrade.`,
        variant: 'success',
      });
      restartTimerRef.current = setTimeout(() => {
        void fetchAgents();
        setRestartingHost(null);
        restartTimerRef.current = null;
      }, 10_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restart daemon';
      pushToast({
        title: 'Failed to restart daemon',
        description: message,
        variant: 'error',
      });
      setRestartingHost(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title={host}>
        <dl className="flex flex-col gap-3 text-sm">
          <div className="flex items-start justify-between gap-4">
            <dt className="text-muted">Supported backends</dt>
            <dd className="text-right font-mono text-ink">
              {supportedBackends.length > 0 ? supportedBackends.join(', ') : '—'}
            </dd>
          </div>
          <div className="flex items-start justify-between gap-4">
            <dt className="text-muted">Daemon CLI version</dt>
            <dd className="text-right font-mono text-ink">{daemonVersion ?? 'unknown'}</dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="AI tools">
        {state?.loading?.status && !status ? (
          <p className="text-sm text-muted">Loading AI tools…</p>
        ) : status && availableTools.length > 0 ? (
          <div className="flex flex-col divide-y divide-border">
            {availableTools.map((tool) => (
              <ToolStatusRow
                key={tool}
                tool={tool}
                install={status.install[tool]}
                network={status.network[tool]}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">No available AI tools on this daemon.</p>
        )}
        {state?.error?.status ? (
          <p className="mt-2 text-xs text-[var(--error)]">{state.error.status}</p>
        ) : null}
      </SectionCard>

      <SectionCard title="Quota">
        {/* `min-w-0` on every grid item keeps the cell from adopting its
            content's intrinsic width on narrow viewports (grid items default
            to min-width: auto, same trap as flex items). Without it, a long
            Codex email, long Copilot login, or long reset-time label can push
            the column past the viewport on mobile and bleed through the
            SectionCard border. */}
        {state?.loading?.status && !status ? (
          <p className="text-sm text-muted">Loading quota…</p>
        ) : availableTools.length > 0 ? (
          <div className={`grid gap-5 ${quotaGridClass(availableTools.length)}`}>
            {availableTools.map((tool) => {
              if (tool === 'codex') {
                // The multi-account switcher only appears when the user
                // explicitly configured accounts under ai_manager.codex.auth_json
                // and there is actually something to switch: either several
                // accounts, or a single configured account that is not the
                // active identity (the configuration wins over the default
                // auth.json, so the user must keep a path to activate it).
                // Otherwise Codex renders like every other provider, fed by
                // the daemon's default auth.json quota.
                const showSwitcher =
                  accounts.length > 1 || (accounts.length === 1 && !accounts[0].isCurrent);
                return (
                  <div key={tool} className="flex min-w-0 flex-col gap-3">
                    <div className="text-sm font-semibold text-ink">
                      Codex
                      {!showSwitcher && quota?.codex?.plan ? (
                        <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                          {quota.codex.plan}
                        </span>
                      ) : null}
                    </div>
                    {showSwitcher ? (
                      <>
                        <CodexAccountSwitcher
                          agentHost={host}
                          accounts={accounts}
                          codexQuotaByAccount={codexQuotaByAccount}
                          errorMessage={state?.error?.accounts}
                        />
                        {unattributedCodexError ? (
                          <p className="text-xs text-[var(--error)]">{unattributedCodexError}</p>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <QuotaBar label="Weekly" window={quota?.codex?.weekly} />
                        {quota?.codex?.error ? (
                          <p className="text-xs text-[var(--error)]">{quota.codex.error}</p>
                        ) : null}
                        {/* An accounts-fetch failure would otherwise be
                            invisible here (the switcher normally surfaces it),
                            silently hiding a configured multi-account list. */}
                        {state?.error?.accounts ? (
                          <p className="text-xs text-[var(--error)]">{state.error.accounts}</p>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              }

              if (tool === 'claude') {
                return (
                  <div key={tool} className="flex min-w-0 flex-col gap-3">
                    <div className="text-sm font-semibold text-ink">
                      Claude
                      {quota?.claude?.overallStatus ? (
                        <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                          {quota.claude.overallStatus}
                        </span>
                      ) : null}
                    </div>
                    <QuotaBar label="5h" window={quota?.claude?.fiveHour} />
                    <QuotaBar label="Weekly" window={quota?.claude?.weekly} />
                    {quota?.claude?.weeklySonnet ? (
                      <QuotaBar label="Weekly · Sonnet" window={quota.claude.weeklySonnet} />
                    ) : null}
                    {quota?.claude?.error ? (
                      <p className="text-xs text-[var(--error)]">{quota.claude.error}</p>
                    ) : null}
                  </div>
                );
              }

              if (tool === 'kimi') {
                return (
                  <div key={tool} className="flex min-w-0 flex-col gap-3">
                    <div className="text-sm font-semibold text-ink">
                      Kimi
                      {quota?.kimi?.membership ? (
                        <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                          {quota.kimi.membership.replace(/^LEVEL_/, '').toLowerCase()}
                        </span>
                      ) : null}
                    </div>
                    <QuotaBar label="5h" window={quota?.kimi?.fiveHour} />
                    <QuotaBar label="Weekly" window={quota?.kimi?.weekly} />
                    {quota?.kimi?.error ? (
                      <p className="text-xs text-[var(--error)]">{quota.kimi.error}</p>
                    ) : null}
                  </div>
                );
              }

              if (tool === 'dsh') {
                // DeepSeek bills per token with no rolling window, so this
                // shows prepaid balance rather than a QuotaBar percentage.
                return (
                  <div key={tool} className="flex min-w-0 flex-col gap-3">
                    <div className="text-sm font-semibold text-ink">
                      DeepSeek Harness
                      {quota?.dsh && !quota.dsh.error ? (
                        <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                          {quota.dsh.isAvailable ? 'available' : 'unavailable'}
                        </span>
                      ) : null}
                    </div>
                    {quota?.dsh?.primaryBalance ? (
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex items-baseline gap-2">
                          <span className="text-lg font-semibold text-ink">
                            {quota.dsh.primaryBalance.totalBalance.toFixed(2)}
                          </span>
                          <span className="text-xs text-muted">
                            {quota.dsh.primaryBalance.currency} balance
                          </span>
                        </div>
                        {quota.dsh.primaryBalance.grantedBalance > 0 ? (
                          <p className="text-xs text-muted">
                            granted {quota.dsh.primaryBalance.grantedBalance.toFixed(2)} · topped up{' '}
                            {quota.dsh.primaryBalance.toppedUpBalance.toFixed(2)}
                          </p>
                        ) : null}
                      </div>
                    ) : !quota?.dsh?.error ? (
                      <p className="text-sm text-muted">Loading balance…</p>
                    ) : null}
                    {quota?.dsh?.error ? (
                      <p className="text-xs text-[var(--error)]">{quota.dsh.error}</p>
                    ) : null}
                  </div>
                );
              }

              return (
                <div key={tool} className="flex min-w-0 flex-col gap-3">
                  <div className="text-sm font-semibold text-ink">
                    Copilot
                    {quota?.copilot?.primary?.status ? (
                      <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                        {quota.copilot.primary.status.replaceAll('_', ' ')}
                      </span>
                    ) : null}
                    {quota?.copilot?.login ? (
                      <span className="ml-2 text-xs font-normal text-muted">
                        ({quota.copilot.login}
                        {quota.copilot.loginSource === 'github_token' ? ' via GITHUB_TOKEN' : ''})
                      </span>
                    ) : null}
                  </div>
                  {quota?.copilot?.premiumInteractions || !quota?.copilot ? (
                    <QuotaBar label="Premium" window={quota?.copilot?.premiumInteractions} />
                  ) : null}
                  {!quota?.copilot?.premiumInteractions &&
                  quota?.copilot?.primary &&
                  !quota.copilot.chat &&
                  !quota.copilot.completions ? (
                    <QuotaBar label="Primary" window={quota.copilot.primary} />
                  ) : null}
                  {quota?.copilot?.chat ? (
                    <QuotaBar label="Chat" window={quota.copilot.chat} />
                  ) : null}
                  {quota?.copilot?.completions ? (
                    <QuotaBar label="Completions" window={quota.copilot.completions} />
                  ) : null}
                  {quota?.copilot?.error ? (
                    <p className="text-xs text-[var(--error)]">{quota.copilot.error}</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : visibleExternalQuotaEntries.length === 0 ? (
          <p className="text-sm text-muted">No quota-capable AI tools available on this daemon.</p>
        ) : null}
        {visibleExternalQuotaEntries.length > 0 ? (
          <div className={availableTools.length > 0 ? 'mt-5 border-t border-border pt-5' : ''}>
            <div className="mb-3 text-sm font-semibold text-ink">
              External providers
            </div>
            <div className="flex flex-col gap-4">
              {visibleExternalQuotaEntries.map(({ backend, providerQuota }) => {
                const providerLabel = providerQuota?.label ?? backend;
                return (
                  <div key={backend} className="min-w-0">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-ink">
                        {providerLabel}
                        {providerQuota?.source ? (
                          <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                            {providerQuota.source}
                          </span>
                        ) : null}
                      </div>
                      {providerQuota?.username || providerQuota?.organization ? (
                        <div className="min-w-0 truncate text-right text-xs text-muted">
                          {[providerQuota.username, providerQuota.organization].filter(Boolean).join(' · ')}
                        </div>
                      ) : null}
                    </div>
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {providerQuota.quotas.map((modelQuota) => {
                        const meta = formatExternalModelMeta(modelQuota);
                        return (
                          <div
                            key={`${backend}:${modelQuota.model}`}
                            className="min-w-0 rounded-lg border border-border bg-paper/50 p-3"
                          >
                            <QuotaBar label={modelQuota.model} window={modelQuota.daily} />
                            {meta ? (
                              <p className="mt-1 truncate text-xs text-muted">{meta}</p>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {providerQuota?.error ? (
                      <p className="mt-2 text-xs text-[var(--error)]">{providerQuota.error}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {state?.error?.quota ? (
          <p className="mt-2 text-xs text-[var(--error)]">{state.error.quota}</p>
        ) : null}
      </SectionCard>

      <CustomCommandsPanel agentHost={host} supported={supportsCustomCommands} />

      <DaemonSharingCard
        agentHost={host}
        shared={selectedDaemon?.shared}
        ownerLabel={selectedDaemon?.ownerLabel}
      />

      <SectionCard title="Danger zone">
        <div className="flex flex-wrap items-start justify-end gap-3">
          <UpdateDaemonButton
            agentHost={host}
            supported={supportsUpdate}
            onFinished={fetchAgents}
          />
          <button
            type="button"
            onClick={() => void handleRestartDaemon()}
            disabled={!supportsRestart || isRestarting}
            aria-label={`Restart daemon on ${host}`}
            className="webapp-btn-primary inline-flex items-center justify-center px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRestarting ? 'Restarting...' : 'Restart daemon'}
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
