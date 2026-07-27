'use client';

import { useEffect, useState } from 'react';
import { getApiClient } from '@/shared/api/client';
import type { Message } from '@/shared/types';

interface ReadOnlyTranscriptProps {
  taskId: string;
}

export function ReadOnlyTranscript({ taskId }: ReadOnlyTranscriptProps) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getApiClient()
      .get<Message[]>(`/tasks/${encodeURIComponent(taskId)}/messages`)
      .then((data) => {
        if (cancelled) return;
        setMessages(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load transcript');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  if (loading) {
    return <div className="py-6 text-center text-sm text-muted">Loading transcript...</div>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
        {error}
      </div>
    );
  }

  if (!messages || messages.length === 0) {
    return <div className="py-6 text-center text-sm text-muted">No messages in this transcript.</div>;
  }

  return (
    <div className="max-h-[24rem] space-y-3 overflow-y-auto webapp-scrollbar pr-1">
      {messages.map((message) => {
        const isUser = message.role === 'user';
        return (
          <div
            key={message.id}
            className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[85%] whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm ${
                isUser
                  ? 'bg-[var(--accent)] text-white'
                  : 'border border-border bg-paper text-ink'
              }`}
            >
              {message.content || <span className="italic opacity-60">(no content)</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
