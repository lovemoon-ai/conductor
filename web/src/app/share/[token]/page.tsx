'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { MessageBubble } from '@/features/chat';
import { QuestionNav } from '@/components/common/QuestionNav';
import type { MessageRole } from '@/shared/types';

interface SharedMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

interface SharedTaskData {
  task: {
    title: string;
    status: string;
    taskType: string;
    createdAt: string;
    expiresAt: string | null;
  };
  messages: SharedMessage[];
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

export default function SharedTaskPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedTaskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  const mainRef = useRef<HTMLElement | null>(null);
  const questionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isJumping = useRef(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch(`/api/shared/${token}`);
        if (!res.ok) {
          if (res.status === 404) {
            setError('This shared link is not available.');
          } else if (res.status === 410) {
            setError('This shared link has expired.');
          } else {
            setError('Failed to load shared task.');
          }
          return;
        }
        const json = await res.json();
        setData(json);
      } catch {
        setError('Failed to load shared task.');
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [token]);

  const userMessageIndices = useMemo(() => {
    if (!data) return [];
    const indices: number[] = [];
    data.messages.forEach((msg, i) => {
      if (msg.role === 'user') indices.push(i);
    });
    return indices;
  }, [data]);

  const questionIndexByMsgIndex = useMemo(() => {
    if (!data) return new Map<number, number>();
    const map = new Map<number, number>();
    let q = 0;
    data.messages.forEach((msg, i) => {
      if (msg.role === 'user') map.set(i, q++);
    });
    return map;
  }, [data]);

  const handleJump = useCallback((questionIndex: number) => {
    const el = questionRefs.current.get(questionIndex);
    if (el) {
      isJumping.current = true;
      el.scrollIntoView({ behavior: 'instant', block: 'start' });
      setActiveQuestion(questionIndex);
      setTimeout(() => { isJumping.current = false; }, 100);
    }
  }, []);

  useEffect(() => {
    const container = mainRef.current;
    if (!container || userMessageIndices.length === 0) return;

    const handleScroll = () => {
      if (isJumping.current) return;
      const containerTop = container.getBoundingClientRect().top;
      let closest = 0;
      let closestDist = Infinity;

      questionRefs.current.forEach((el, idx) => {
        const dist = Math.abs(el.getBoundingClientRect().top - containerTop - 80);
        if (dist < closestDist) {
          closestDist = dist;
          closest = idx;
        }
      });

      setActiveQuestion(closest);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [userMessageIndices]);

  const handleShareForAi = useCallback(async () => {
    const aiUrl = `${window.location.origin}/share/${token}/plain`;

    try {
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(aiUrl);
        copied = true;
      }

      if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = aiUrl;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.left = '-1000px';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      setCopyState(copied ? 'copied' : 'error');
    } catch {
      setCopyState('error');
    }

    window.setTimeout(() => {
      setCopyState('idle');
    }, 2000);
  }, [token]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)]">
        <div className="size-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)]">
        <p className="text-muted">{error || 'Not found'}</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--bg)]">
      <header className="sticky top-0 z-10 border-b border-border bg-[var(--bg)] px-4 py-3">
        <div className="mx-auto max-w-3xl">
          <h1 className="text-lg font-semibold text-ink">{data.task.title}</h1>
          <p className="mt-0.5 text-xs text-muted">
            Shared conversation &middot; {formatShortDate(data.task.createdAt)}
            {data.task.expiresAt ? ` · Expires ${formatShortDate(data.task.expiresAt)}` : ''}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleShareForAi}
              className="inline-flex items-center justify-center rounded-xl border border-border bg-paper/80 px-3 py-2 text-sm font-medium text-ink shadow-sm transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
            >
              {copyState === 'copied' ? 'AI link copied' : copyState === 'error' ? 'Copy failed' : 'Share for AI'}
            </button>
          </div>
        </div>
      </header>

      <QuestionNav
        count={userMessageIndices.length}
        activeIndex={activeQuestion}
        onJump={handleJump}
      />

      <main ref={mainRef} className="flex-1 overflow-y-auto webapp-scrollbar">
        <div className="mx-auto max-w-3xl px-4 py-6 space-y-4">
          {data.messages.map((message, msgIndex) => {
            const qIdx = questionIndexByMsgIndex.get(msgIndex);

            return (
              <div
                key={message.id}
                ref={qIdx != null ? (el) => { if (el) questionRefs.current.set(qIdx, el); } : undefined}
              >
                <MessageBubble message={{ ...message, taskId: '' }} />
              </div>
            );
          })}
          {data.messages.length === 0 && (
            <p className="text-center text-muted">No messages in this conversation.</p>
          )}
        </div>
      </main>

      <footer className="border-t border-border px-4 py-3 text-center">
        <p className="text-xs text-muted">
          Powered by <Link href="/" className="font-medium text-ink transition-colors hover:text-[var(--accent)]">Conductor</Link>
        </p>
      </footer>
    </div>
  );
}
