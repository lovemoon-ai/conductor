'use client';

import { useEffect, useState } from 'react';
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

export default function SharedTaskPage() {
  const { token } = useParams<{ token: string }>();
  const [data, setData] = useState<SharedTaskData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

      <main className="flex-1 overflow-y-auto webapp-scrollbar">
        <div className="mx-auto max-w-3xl px-4 py-6 space-y-4">
          {data.messages.map((message) => (
            <MessageBubble key={message.id} message={{ ...message, taskId: '' }} />
          ))}
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
