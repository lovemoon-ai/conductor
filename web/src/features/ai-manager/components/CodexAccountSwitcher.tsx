'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
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
  const [pending, setPending] = useState<CodexAccount | null>(null);

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
                onClick={() => setPending(acct)}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isCurrent ? 'Active' : 'Use'}
              </button>
            </div>
            <QuotaBar label="5h" window={quota?.fiveHour} />
            <QuotaBar label="Weekly" window={quota?.weekly} />
            {quota?.error ? (
              <p className="text-xs text-[var(--error)]">{quota.error}</p>
            ) : null}
          </div>
        );
      })}

      {switchError ? <p className="text-xs text-[var(--error)]">{switchError}</p> : null}

      <ConfirmDialog
        open={pending !== null}
        title={`Switch Codex account to "${pending?.email ?? pending?.name ?? ''}"?`}
        description={
          'This rewrites ~/.codex/auth.json on the daemon machine and backs up the current file to auth.json.bak.\n\n' +
          'Already-running codex processes will keep using the old token; the change only takes effect on the next codex invocation.'
        }
        confirmLabel={switching ? 'Switching…' : 'Switch'}
        cancelLabel="Cancel"
        onCancel={() => setPending(null)}
        onConfirm={async () => {
          if (!pending) return;
          const target = pending;
          setPending(null);
          await switchAccount(agentHost, target.name);
        }}
      />
    </div>
  );
}
