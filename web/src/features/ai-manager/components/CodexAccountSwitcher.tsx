'use client';

import { useEffect, useRef, useState } from 'react';
import { useAiManagerStore } from '../store';
import type { CodexAccount, CodexQuota } from '../types';
import { QuotaBar } from './QuotaBar';

interface Props {
  agentHost: string;
  accounts: CodexAccount[];
  /**
   * Map from account name → last-known quota snapshot. The active account's
   * entry is kept live by polling; inactive accounts show the most recent
   * value captured while they were active.
   */
  codexQuotaByAccount: Record<string, CodexQuota>;
  loading: boolean;
  errorMessage?: string;
}

export function CodexAccountSwitcher({
  agentHost,
  accounts,
  codexQuotaByAccount,
  loading,
  errorMessage,
}: Props) {
  const switchAccount = useAiManagerStore((s) => s.switchAccount);
  const switching = useAiManagerStore((s) => s.byHost[agentHost]?.loading?.switching ?? false);
  const switchError = useAiManagerStore((s) => s.byHost[agentHost]?.error?.switching);
  // Name of the account whose Use button is in the "Use?" confirmation state.
  // Inline confirmation replaces the previous modal popup: first click arms,
  // second click commits. Clicking another account re-arms onto that one.
  const [pendingName, setPendingName] = useState<string | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-cancel the armed "Use?" state if the user walks away for a few seconds
  // so a stale confirmation doesn't sit there indefinitely.
  useEffect(() => {
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    if (pendingName) {
      pendingTimerRef.current = setTimeout(() => setPendingName(null), 4000);
    }
    return () => {
      if (pendingTimerRef.current) {
        clearTimeout(pendingTimerRef.current);
        pendingTimerRef.current = null;
      }
    };
  }, [pendingName]);

  if (loading && accounts.length === 0) {
    return <div className="text-sm text-muted">Loading accounts…</div>;
  }
  if (errorMessage) {
    return <div className="text-sm text-[var(--error)]">{errorMessage}</div>;
  }
  if (accounts.length === 0) {
    return (
      <div className="text-sm text-muted">
        No codex accounts configured. Add paths under <code>ai_manager.codex.auth_json</code> in
        <code className="mx-1">~/.conductor/config.yaml</code>.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {accounts.map((acct) => {
        const isCurrent = acct.isCurrent;
        const primary = acct.email ?? '(no email)';
        const quota = codexQuotaByAccount[acct.name];
        const plan = quota?.plan ?? acct.planType;
        const hasSnapshot = Boolean(quota);
        return (
          <div
            key={acct.path}
            className={`flex flex-col gap-2 rounded-xl border px-3 py-2 ${
              isCurrent ? 'border-[var(--accent)] bg-[var(--accent)]/5' : 'border-border'
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2 text-sm font-medium text-ink">
                  {/* `min-w-0` is required on flex children for `truncate` to
                      actually shrink; without it the default `min-width: auto`
                      forces the row to expand to the email's full width,
                      overflowing the card border on narrow viewports. */}
                  <span className="min-w-0 truncate">{primary}</span>
                  {plan ? (
                    <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted">
                      {plan}
                    </span>
                  ) : null}
                </div>
                {isCurrent ? (
                  <span className="mt-0.5 inline-block rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--accent)]">
                    current
                  </span>
                ) : !hasSnapshot ? (
                  <span className="mt-0.5 inline-block text-[10px] text-muted">
                    no quota snapshot yet
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                disabled={isCurrent || switching}
                onClick={async () => {
                  if (isCurrent || switching) return;
                  if (pendingName === acct.name) {
                    setPendingName(null);
                    await switchAccount(agentHost, acct.name);
                  } else {
                    setPendingName(acct.name);
                  }
                }}
                className={`shrink-0 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  pendingName === acct.name && !isCurrent
                    ? 'border-[var(--accent)] bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90'
                    : 'border-border text-ink hover:bg-paper'
                }`}
              >
                {isCurrent
                  ? 'Active'
                  : switching && pendingName === null
                  ? 'Switching…'
                  : pendingName === acct.name
                  ? 'Use?'
                  : 'Use'}
              </button>
            </div>
            <QuotaBar label="Weekly" window={quota?.weekly} />
            {quota?.error ? (
              <p className="text-xs text-[var(--error)]">{quota.error}</p>
            ) : null}
          </div>
        );
      })}

      {switchError ? <p className="text-xs text-[var(--error)]">{switchError}</p> : null}
    </div>
  );
}
