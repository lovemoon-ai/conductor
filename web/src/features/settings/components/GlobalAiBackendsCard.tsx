'use client';

import { useEffect, useMemo } from 'react';
import type { Agent } from '@/shared/types';
import {
  globalAiBackendKey,
  useGlobalAiBackendsStore,
  type GlobalAiBackend,
} from '@/features/user-preferences/global-ai-backends';

type DaemonRow = {
  host: string;
  online: boolean;
  backends: Array<{ backend: string; enabled: boolean; available: boolean }>;
};

/**
 * RFC 0041: pick which daemon × AI backends every project may run tasks on.
 * Only your own daemons are listed (shared ones run on someone else's machine).
 * A daemon that is offline keeps its saved entries, greyed out; they can be
 * removed but not added until it reconnects.
 */
export function GlobalAiBackendsCard({ agents }: { agents: Agent[] }) {
  const { backends, hydrated, saving, error, hydrate, save } = useGlobalAiBackendsStore();

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrate, hydrated]);

  const rows = useMemo<DaemonRow[]>(() => {
    const enabled = new Set(backends.map(globalAiBackendKey));
    const ownDaemons = agents.filter(
      (agent) => !agent.host.startsWith('conductor-fire-') && !agent.shared,
    );
    const hosts = [...new Set([...ownDaemons.map((agent) => agent.host), ...backends.map((entry) => entry.host)])];
    return hosts.map((host) => {
      const agent = ownDaemons.find((candidate) => candidate.host === host) ?? null;
      const supported = agent?.supportedBackends ?? [];
      const saved = backends.filter((entry) => entry.host === host).map((entry) => entry.backend);
      return {
        host,
        online: Boolean(agent),
        backends: [...new Set([...supported, ...saved])].map((backend) => ({
          backend,
          enabled: enabled.has(globalAiBackendKey({ host, backend })),
          available: supported.includes(backend),
        })),
      };
    });
  }, [agents, backends]);

  const toggle = (entry: GlobalAiBackend, checked: boolean) => {
    const key = globalAiBackendKey(entry);
    const next = checked
      ? [...backends, entry]
      : backends.filter((current) => globalAiBackendKey(current) !== key);
    void save(next);
  };

  return (
    <section className="webapp-card p-5" aria-labelledby="global-ai-backends-title">
      <h3 id="global-ai-backends-title" className="font-semibold text-lg">Global AI backends</h3>
      <p className="mt-1 text-sm text-muted">
        Let tasks in any project use these AI backends. The AI runs on the checked device and works on
        the project&apos;s own device through conductor remote.
      </p>
      {error ? <p className="mt-3 text-sm text-error" role="alert">{error}</p> : null}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted">Connect a device to choose its AI backends.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {rows.map((row) => (
            <li key={row.host} className={row.online ? '' : 'opacity-60'}>
              <div className="text-sm font-medium text-ink">
                {row.host}
                {row.online ? null : <span className="ml-2 text-xs font-normal text-muted">offline</span>}
              </div>
              {row.backends.length === 0 ? (
                <p className="mt-1 text-xs text-muted">No AI backends advertised.</p>
              ) : (
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {row.backends.map((item) => {
                    // Removing is always allowed; adding needs the daemon to advertise it now.
                    // Never save before the saved list is known: a PUT replaces it.
                    const disabled = !hydrated || saving || (!item.enabled && !item.available);
                    return (
                      <label
                        key={item.backend}
                        className={`flex items-center gap-2 text-sm ${disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer'}`}
                        title={item.available ? undefined : `${item.backend} is not available on ${row.host} right now`}
                      >
                        <input
                          type="checkbox"
                          aria-label={`${item.backend} @ ${row.host}`}
                          checked={item.enabled}
                          disabled={disabled}
                          onChange={(event) => toggle({ host: row.host, backend: item.backend }, event.target.checked)}
                          className="size-4 rounded border-border text-[var(--accent)] focus:ring-[var(--accent)]"
                        />
                        {item.backend}
                      </label>
                    );
                  })}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
