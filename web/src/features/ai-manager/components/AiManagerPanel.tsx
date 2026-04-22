'use client';

import { useEffect, useRef, useState } from 'react';
import { SectionCard } from '@/components/common/SectionCard';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { useAgentsStore } from '@/features/agents';
import { getApiClient } from '@/shared/api/client';
import { useAiManagerStore } from '../store';
import { CodexAccountSwitcher } from './CodexAccountSwitcher';
import { QuotaBar } from './QuotaBar';
import { ToolStatusRow } from './ToolStatusRow';

interface AiManagerPanelProps {
  /** Daemon to display. Falls back to the first connected daemon when omitted. */
  initialAgentHost?: string;
}

/** Daemons that accept ai_manager_request. Excludes ephemeral fire hosts. */
function isManageableHost(host: string): boolean {
  return !host.startsWith('conductor-fire-');
}

export function AiManagerPanel({ initialAgentHost }: AiManagerPanelProps = {}) {
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const visibleDaemons = agents.filter((a) => isManageableHost(a.host));
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [restartingHost, setRestartingHost] = useState<string | null>(null);
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const selectedHost = useAiManagerStore((s) => s.selectedHost);
  const setSelectedHost = useAiManagerStore((s) => s.setSelectedHost);
  const byHost = useAiManagerStore((s) => s.byHost);
  const fetchAll = useAiManagerStore((s) => s.fetchAll);
  const startPolling = useAiManagerStore((s) => s.startPolling);
  const stopPolling = useAiManagerStore((s) => s.stopPolling);

  useEffect(() => {
    void fetchAgents();
    return () => {
      if (restartTimerRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = null;
      }
    };
  }, [fetchAgents]);

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

  // Fetch + poll whenever the selection changes.
  useEffect(() => {
    if (!selectedHost) return;
    void fetchAll(selectedHost);
    startPolling(selectedHost);
    return () => stopPolling();
  }, [selectedHost, fetchAll, startPolling, stopPolling]);

  if (visibleDaemons.length === 0 && !selectedHost) {
    return (
      <SectionCard title="No daemon">
        <p className="text-sm text-muted">
          No daemons connected. Run <code>conductor daemon</code> on a machine to get started.
        </p>
      </SectionCard>
    );
  }

  const host = selectedHost ?? visibleDaemons[0]?.host ?? '';
  const selectedDaemon = visibleDaemons.find((daemon) => daemon.host === host) ?? null;
  const supportsRestart = selectedDaemon?.capabilities?.includes('restart_daemon') ?? false;
  const isRestarting = restartingHost === host;
  const state = byHost[host];
  const status = state?.status ?? null;
  const quota = state?.quota ?? null;
  const accounts = state?.accounts?.accounts ?? [];

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

    if (restartTimerRef.current) {
      clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
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
        <div className="flex flex-col divide-y divide-border">
          <ToolStatusRow tool="codex" install={status?.install.codex} network={status?.network.codex} />
          <ToolStatusRow tool="claude" install={status?.install.claude} network={status?.network.claude} />
          <ToolStatusRow tool="kimi" install={status?.install.kimi} network={status?.network.kimi} />
          <ToolStatusRow tool="copilot" install={status?.install.copilot} network={status?.network.copilot} />
        </div>
        {state?.error?.status ? (
          <p className="mt-2 text-xs text-[var(--error)]">{state.error.status}</p>
        ) : null}
      </SectionCard>

      <SectionCard title="Quota">
        <div className="grid gap-5 md:grid-cols-4">
          <div className="flex flex-col gap-3">
            <div className="text-sm font-semibold text-ink">
              Codex
              {quota?.codex?.plan ? (
                <span className="ml-2 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                  {quota.codex.plan}
                </span>
              ) : null}
            </div>
            <QuotaBar label="5h" window={quota?.codex?.fiveHour} />
            <QuotaBar label="Weekly" window={quota?.codex?.weekly} />
            {quota?.codex?.error ? (
              <p className="text-xs text-[var(--error)]">{quota.codex.error}</p>
            ) : null}
          </div>
          <div className="flex flex-col gap-3">
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
          <div className="flex flex-col gap-3">
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
          <div className="flex flex-col gap-3">
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
        </div>
        {state?.error?.quota ? (
          <p className="mt-2 text-xs text-[var(--error)]">{state.error.quota}</p>
        ) : null}
      </SectionCard>

      <SectionCard title="Codex accounts">
        <CodexAccountSwitcher
          agentHost={host}
          accounts={accounts}
          loading={state?.loading?.accounts ?? false}
          errorMessage={state?.error?.accounts}
        />
      </SectionCard>

      <SectionCard title="Danger zone">
        <div className="flex justify-end">
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
