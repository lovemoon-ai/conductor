'use client';

import { Header } from '@/components/layout/Header';
import { useAgentsStore } from '@/features/agents';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { SETTINGS_ROOT_PATH, useSettingsNavStore } from '@/features/settings';

function formatBuildTimeInBeijing(rawBuildTime: string) {
  if (!rawBuildTime || rawBuildTime === 'unknown') {
    return 'unknown';
  }

  const parsedDate = new Date(rawBuildTime);
  if (Number.isNaN(parsedDate.getTime())) {
    return rawBuildTime;
  }

  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  return `${formatter.format(parsedDate)} GMT+8`;
}

export default function SettingsPage() {
  const { agents, fetchAgents, error: agentsError, errorStatus: agentsErrorStatus } = useAgentsStore();
  const router = useRouter();
  const setLastSettingsPath = useSettingsNavStore((state) => state.setLastPath);
  const cliVersion = process.env.NEXT_PUBLIC_CLI_VERSION || 'unknown';
  const gitCommitId = process.env.NEXT_PUBLIC_GIT_COMMIT_ID || 'unknown';
  const buildTime = process.env.NEXT_PUBLIC_BUILD_TIME || 'unknown';
  const buildTimeInBeijing = formatBuildTimeInBeijing(buildTime);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Remember this as the most recent Settings-area path so the sidebar
  // Settings item returns here by default.
  useEffect(() => {
    setLastSettingsPath(SETTINGS_ROOT_PATH);
  }, [setLastSettingsPath]);

  const visibleDaemons = agents.filter((agent) => !agent.host.startsWith('conductor-fire-'));
  const isDaemonAuthError = agentsErrorStatus === 401;

  const exitToHome = () => {
    router.push('/');
  };

  const openAiManager = (host: string) => {
    router.push(`/app/ai-manager?agentHost=${encodeURIComponent(host)}`);
  };

  return (
    <>
      <Header title="Settings" compact />

      <div className="flex-1 overflow-y-auto p-4 space-y-4 webapp-scrollbar">
        {/* Connected Daemons Section */}
        <section className="webapp-card p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-success/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
            </div>
            <h3 className="font-semibold text-lg">Connected Daemons</h3>
          </div>
          {agentsError ? (
            <div className="text-center py-6 text-muted">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {isDaemonAuthError ? (
                <p className="text-sm">Please log in to view connected daemons.</p>
              ) : (
                <>
                  <p className="text-sm">Unable to load connected daemons.</p>
                  <p className="text-xs mt-1">{agentsError}</p>
                </>
              )}
            </div>
          ) : visibleDaemons.length === 0 ? (
            <div className="text-center py-6 text-muted">
              <svg className="w-12 h-12 mx-auto mb-3 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              <p className="text-sm">No daemons connected</p>
            </div>
          ) : (
            <div className="space-y-2">
              {visibleDaemons.map((agent) => {
                return (
                  <div
                    key={agent.id}
                    className="flex items-center gap-2 p-3 bg-paper border border-border rounded-lg transition-colors hover:bg-[var(--accent)]/5 hover:border-[var(--accent)]/40"
                  >
                    <button
                      type="button"
                      onClick={() => openAiManager(agent.host)}
                      aria-label={`Open AI Manager for ${agent.host}`}
                      className="flex flex-1 items-center gap-3 text-left min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 rounded"
                    >
                      <div className="w-2 h-2 bg-success rounded-full animate-pulse shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{agent.host}</p>
                        {agent.supportedBackends && agent.supportedBackends.length > 0 && (
                          <p className="text-xs text-muted mt-0.5 truncate">
                            {agent.supportedBackends.join(', ')}
                          </p>
                        )}
                      </div>
                      <svg className="w-4 h-4 text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Build Info Section */}
        <section className="webapp-card p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V5a4 4 0 118 0v2M6 7h12a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zm4 6h4" />
              </svg>
            </div>
            <h3 className="font-semibold text-lg">Build Info</h3>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between p-3 bg-paper border border-border rounded-lg">
              <span className="text-sm text-muted">CLI Version</span>
              <span className="font-mono text-sm">{cliVersion}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-paper border border-border rounded-lg">
              <span className="text-sm text-muted">Commit ID</span>
              <span className="font-mono text-sm">{gitCommitId}</span>
            </div>
            <div className="flex items-center justify-between p-3 bg-paper border border-border rounded-lg">
              <span className="text-sm text-muted">Build Time</span>
              <span className="font-mono text-sm text-right">{buildTimeInBeijing}</span>
            </div>
          </div>
        </section>

        {/* Logout Section */}
        <section className="webapp-card p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-error/10 flex items-center justify-center">
              <svg className="w-5 h-5 text-error" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </div>
            <h3 className="font-semibold text-lg">Session</h3>
          </div>
          <button
            type="button"
            onClick={exitToHome}
            className="flex items-center gap-2 px-4 py-2 bg-[var(--accent)] text-white rounded-full text-sm hover:opacity-90 transition-opacity"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            Exit
          </button>
        </section>
      </div>
    </>
  );
}
