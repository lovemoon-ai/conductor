'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { MarkdownRenderer } from '@/features/chat';
import { encodePreviewPath } from '@/shared/utils/file-preview';

/**
 * Markdown viewer for a file preview. HTML and images are served straight from
 * `/api/preview`; Markdown needs rendering, and rendering it here is safe
 * because the renderer never emits raw HTML from the document.
 */
export default function PreviewMarkdownPage() {
  const params = useParams<{ token: string; path: string[] }>();
  const token = params.token;
  const path = (params.path ?? []).map(decodeURIComponent).join('/');
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    document.title = path.slice(path.lastIndexOf('/') + 1);
    fetch(`/api/preview/${token}/${encodePreviewPath(path)}`)
      .then(async (response) => {
        const text = await response.text();
        if (cancelled) return;
        if (response.ok) setContent(text);
        else setError(text || `HTTP ${response.status}`);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [token, path]);

  return (
    <main className="min-h-screen bg-[var(--bg)]">
      {/* `compact-chat message-body` reuses the chat's Markdown styles; headings
          get real sizes here because a document, unlike a chat reply, needs them. */}
      <div className="compact-chat message-body mx-auto max-w-3xl px-4 py-6 [&_:is(h1,h2,h3,h4)]:font-semibold [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg">
        <p className="mb-4 break-all text-xs text-muted">{path}</p>
        {error ? (
          <p className="text-sm text-muted">{error}</p>
        ) : content === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : (
          <MarkdownRenderer content={content} previewToken={token} previewPath={path} />
        )}
      </div>
    </main>
  );
}
