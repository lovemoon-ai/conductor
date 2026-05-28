'use client';

/**
 * Demo page.
 *
 * Flow:
 *   1. On mount, POST /api/conductor/bind → BFF binds the Conductor project
 *      and creates a fresh task. Returns `{ taskId }` for the widget to use.
 *   2. Mount <ChatView> pointed at /api/conductor as the BFF base URL.
 *
 * Roughly 50 lines of business code for a real end-to-end chat — that's the
 * whole pitch of @love-moon/app-sdk.
 */

import { useEffect, useState } from 'react';
import { ChatView, createRestAdapter } from '@love-moon/app-sdk/react';
import '@love-moon/app-sdk/react/styles.css';

interface Bootstrap {
  projectId: string;
  taskId: string;
  daemonHost: string | null;
}

const adapter = createRestAdapter({
  baseUrl: '/api/conductor',
  // No authToken — we trust the browser session and let the BFF authenticate
  // upstream via its server-held Conductor token.
  // Opt into restart: the catch-all route forwards POST /tasks/:id/restart to
  // client.tasks.restart(). Omit this to hide all restart UI.
  enableRestart: true,
});

export default function Page() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/conductor/bind', { method: 'POST' });
        if (!res.ok) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error ?? `bind failed (${res.status})`);
        }
        const data = (await res.json()) as Bootstrap;
        if (!cancelled) setBootstrap(data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <Frame>
        <h1>Demo unavailable</h1>
        <p style={{ color: '#b04020' }}>{error}</p>
        <p>Check your <code>.env.local</code> against <code>.env.example</code>.</p>
      </Frame>
    );
  }

  if (!bootstrap) {
    return (
      <Frame>
        <p>Binding project + creating task…</p>
      </Frame>
    );
  }

  return (
    <Frame>
      <header
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid #eee',
          fontSize: 13,
          color: '#666',
        }}
      >
        Task <code>{bootstrap.taskId}</code> on daemon{' '}
        <code>{bootstrap.daemonHost ?? 'unknown'}</code>
      </header>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ChatView
          taskId={bootstrap.taskId}
          adapter={adapter}
          onError={(e) => console.error('[demo] chat error', e)}
        />
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        maxWidth: 800,
        margin: '0 auto',
        background: '#fff',
        borderLeft: '1px solid #eee',
        borderRight: '1px solid #eee',
      }}
    >
      {children}
    </div>
  );
}
