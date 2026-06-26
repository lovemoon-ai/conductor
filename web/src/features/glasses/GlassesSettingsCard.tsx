'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { glasses, isGlassesShell, registerGlassesEvents } from './native-bridge';

/**
 * Compact Settings entry for Rokid glasses — a row that navigates to the glasses sub-page
 * (connection + display settings). Renders only inside the Rokid Android shell; in a normal
 * browser it returns null, so it never shows for web users.
 */
export function GlassesSettingsCard() {
  const { push } = useRouter();
  const [inShell, setInShell] = useState(false);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!isGlassesShell()) return;
    setInShell(true);
    setConnected(glasses.isConnected());
    return registerGlassesEvents({
      onGlassStatus: (isConnected) => setConnected(isConnected),
    });
  }, []);

  if (!inShell) return null;

  return (
    <section className="webapp-card p-5">
      <button
        onClick={() => push('/app/glasses')}
        className="w-full flex items-center gap-3 text-left"
      >
        <div className="size-10 rounded-lg bg-accent/10 flex items-center justify-center">
          <svg className="size-5 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12h3l2-3 4 6 2-3h7" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-lg">Rokid 眼镜</p>
          <p className="text-xs text-muted">连接、字体大小、亮度</p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${
            connected ? 'bg-success/10 text-success' : 'bg-paper text-muted border border-border'
          }`}
        >
          <span className={`size-2 rounded-full ${connected ? 'bg-success animate-pulse' : 'bg-muted'}`} />
          {connected ? '已连接' : '未连接'}
        </span>
        <svg className="size-4 text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </section>
  );
}
