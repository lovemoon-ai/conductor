'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { MessageBubble } from '@/components/conductor/chat/MessageBubble';
import type { MessageRole } from '@/lib/conductor/types';

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
  };
  messages: SharedMessage[];
}

function QuestionNav({
  count,
  activeIndex,
  onJump,
}: {
  count: number;
  activeIndex: number;
  onJump: (index: number) => void;
}) {
  if (count === 0) return null;

  return (
    <nav
      aria-label="Jump to question"
      className="fixed right-4 top-1/2 z-20 -translate-y-1/2 flex flex-col items-center"
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col items-center">
          {i > 0 && <div className="h-3 w-px bg-neutral-400" />}
          <button
            type="button"
            aria-label={`Jump to question ${i + 1}`}
            title={`Question ${i + 1}`}
            onClick={() => onJump(i)}
            className="flex items-center justify-center h-6 w-6"
          >
            <span className={`block rounded-full transition-all ${
              activeIndex === i
                ? 'h-3 w-3 bg-[var(--accent)]'
                : 'h-1.5 w-1.5 bg-neutral-400 group-hover:bg-neutral-600'
            }`} />
          </button>
        </div>
      ))}
    </nav>
  );
}

export default function SharedTaskPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedTaskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeQuestion, setActiveQuestion] = useState(0);

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

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg)]">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
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
            Shared conversation &middot; {new Date(data.task.createdAt).toLocaleDateString()}
          </p>
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
          Powered by <a href="/" className="font-medium text-ink hover:text-[var(--accent)] transition-colors">Conductor</a>
        </p>
      </footer>
    </div>
  );
}
