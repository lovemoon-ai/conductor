'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { getApiClient } from '@/shared/api/client';

type SearchHit = {
  taskId: string;
  taskTitle: string;
  messageId: string;
  role: string;
  snippet: string;
  createdAt: string;
};

type SearchResponse = {
  query: string;
  backend: 'fts' | 'like';
  hits: SearchHit[];
};

type TaskGroup = {
  taskId: string;
  taskTitle: string;
  hits: SearchHit[];
};

const DEBOUNCE_MS = 250;
const RESULT_LIMIT = 30;

/** FTS marks matched terms with `[ ... ]`; render those as emphasized spans. */
function renderSnippet(snippet: string) {
  const parts = snippet.split(/(\[[^\]]*\])/g);
  return parts.map((part, index) => {
    if (part.length > 2 && part.startsWith('[') && part.endsWith(']')) {
      return (
        <mark
          key={index}
          className="rounded bg-[var(--accent)]/20 px-0.5 text-ink"
        >
          {part.slice(1, -1)}
        </mark>
      );
    }
    return <Fragment key={index}>{part}</Fragment>;
  });
}

function groupByTask(hits: SearchHit[]): TaskGroup[] {
  const order: string[] = [];
  const byTask = new Map<string, TaskGroup>();
  for (const hit of hits) {
    let group = byTask.get(hit.taskId);
    if (!group) {
      group = { taskId: hit.taskId, taskTitle: hit.taskTitle, hits: [] };
      byTask.set(hit.taskId, group);
      order.push(hit.taskId);
    }
    group.hits.push(hit);
  }
  return order.map((taskId) => byTask.get(taskId)!);
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

/**
 * Whole-history search across every message in the caller's tasks
 * (borrowed from AgentsServer). Debounced type-ahead against GET /api/search.
 */
export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  // Guards against out-of-order responses when the user types quickly.
  const requestRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setStatus('idle');
      return;
    }
    const requestId = ++requestRef.current;
    setStatus('loading');
    const timer = setTimeout(() => {
      getApiClient()
        .get<SearchResponse>(
          `/search?q=${encodeURIComponent(trimmed)}&limit=${RESULT_LIMIT}`,
        )
        .then((result) => {
          if (requestId !== requestRef.current) return;
          setHits(Array.isArray(result?.hits) ? result.hits : []);
          setStatus('done');
        })
        .catch(() => {
          if (requestId !== requestRef.current) return;
          setStatus('error');
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const groups = groupByTask(hits);
  const trimmedQuery = query.trim();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="border-b border-border p-4">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search all conversations…"
          aria-label="Search all conversations"
          autoFocus
          className="w-full rounded-lg border border-border bg-paper px-3 py-2 text-sm text-ink outline-none focus:ring-2 focus:ring-[var(--accent)]/30"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-4 webapp-scrollbar">
        <div className="mx-auto flex max-w-4xl flex-col gap-3">
          {status === 'loading' && groups.length === 0 ? (
            <p className="text-sm text-muted">Searching…</p>
          ) : status === 'error' ? (
            <p className="text-sm text-error">Search failed. Please try again.</p>
          ) : trimmedQuery && status === 'done' && groups.length === 0 ? (
            <p className="text-sm text-muted">No matches for “{trimmedQuery}”.</p>
          ) : !trimmedQuery ? (
            <p className="text-sm text-muted">
              Search across every message in all of your tasks.
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.taskId} className="webapp-card p-4">
                <Link
                  href={`/app/tasks/${group.taskId}`}
                  className="text-sm font-semibold text-ink hover:underline"
                >
                  {group.taskTitle || 'Untitled task'}
                </Link>
                <ul className="mt-2 space-y-2">
                  {group.hits.map((hit) => (
                    <li key={hit.messageId} className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
                      <span className="text-[11px] uppercase tracking-wide text-muted">{hit.role}</span>
                      <span className="min-w-0 flex-1">{renderSnippet(hit.snippet)}</span>
                      <span className="text-[11px] text-muted">{formatTimestamp(hit.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
