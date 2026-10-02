'use client';

import { createContext, memo, useContext, useEffect, useMemo, useState, type MouseEvent } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getApiClient } from '@/shared/api/client';
import {
  encodePreviewPath,
  parseLocalFileHref,
  previewMediaKind,
  previewViewUrl,
} from '@/shared/utils/file-preview';
import { MermaidDiagram } from './MermaidDiagram';

interface MarkdownRendererProps {
  content: string;
  /** Chat: links to files on the task's daemon open as temporary previews. */
  taskId?: string;
  /** Preview viewer: the token and path of the document being shown, so its
   *  relative links and images resolve inside the same preview. */
  previewToken?: string;
  previewPath?: string;
}

type LinkContext = Omit<MarkdownRendererProps, 'content'>;
const MarkdownLinkContext = createContext<LinkContext>({});

/** A relative link or image inside a previewed document → where to load it. */
function usePreviewUrl(href: string | undefined): string | null {
  const { previewToken, previewPath } = useContext(MarkdownLinkContext);
  const local = previewToken ? parseLocalFileHref(href) : null;
  if (!previewToken || !local || local.startsWith('/') || local.startsWith('~')) return null;
  // Let the URL parser do the `../` arithmetic against the document's own path.
  const resolved = new URL(encodePreviewPath(local), `http://preview/${encodePreviewPath(previewPath ?? '')}`);
  return previewViewUrl(previewToken, decodeURIComponent(resolved.pathname.slice(1)));
}

/** `url` serves the file itself; `viewUrl` is where to look at it (the Markdown viewer, for Markdown). */
type TaskPreview = { url: string; viewUrl: string };

/**
 * A reply re-renders constantly and may show several pictures, so a preview
 * link is asked for once and shared until shortly before it would idle out
 * (five minutes on the server).
 */
const PREVIEW_REUSE_MS = 4 * 60 * 1000;
const taskPreviews = new Map<string, { at: number; request: Promise<TaskPreview> }>();

function requestTaskPreview(taskId: string, path: string): Promise<TaskPreview> {
  const key = `${taskId}\n${path}`;
  const cached = taskPreviews.get(key);
  if (cached && Date.now() - cached.at < PREVIEW_REUSE_MS) return cached.request;
  const ask = () =>
    getApiClient().post<TaskPreview>(
      `/tasks/${encodeURIComponent(taskId)}/preview`,
      { path },
      { timeoutMs: 30_000 },
    );
  // 429 means the daemon was busy with other transfers just now, not that the
  // file cannot be shown: one more try a moment later usually succeeds.
  const request = ask().catch((error: unknown) => {
    if ((error as { status?: number })?.status !== 429) throw error;
    return new Promise((resolve) => setTimeout(resolve, 1500)).then(ask);
  });
  taskPreviews.set(key, { at: Date.now(), request });
  // A failure is not worth remembering: the daemon may be back in a moment.
  request.catch(() => {
    if (taskPreviews.get(key)?.request === request) taskPreviews.delete(key);
  });
  return request;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Send a new tab to the file's preview. The tab is opened before the request
 * so it counts as the click's own popup; it also doubles as the place to say
 * what went wrong.
 */
function openTaskFilePreview(event: MouseEvent, taskId: string, path: string) {
  event.preventDefault();
  const tab = window.open('', '_blank');
  if (!tab) return;
  tab.opener = null;
  tab.document.title = path;
  tab.document.body.textContent = `Opening ${path}…`;
  requestTaskPreview(taskId, path)
    .then(({ viewUrl }) => {
      tab.location.replace(viewUrl);
    })
    .catch((error: unknown) => {
      tab.document.body.textContent = `Cannot open ${path}: ${errorMessage(error)}`;
    });
}

/**
 * Chat: where to load a picture or recording that lives on the task's daemon.
 * Pass `null` until it is actually wanted — asking makes the server fetch it.
 */
function useTaskMedia(path: string | null): { url?: string; error?: string } {
  const { taskId } = useContext(MarkdownLinkContext);
  const [loaded, setLoaded] = useState<{ path: string; url?: string; error?: string }>();
  useEffect(() => {
    if (!taskId || !path) return;
    let cancelled = false;
    requestTaskPreview(taskId, path).then(
      ({ url }) => {
        if (!cancelled) setLoaded({ path, url });
      },
      (error: unknown) => {
        if (!cancelled) setLoaded({ path, error: errorMessage(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, path]);
  return loaded?.path === path ? loaded : {};
}

function MarkdownLink({ href, children }: { href?: string; children?: React.ReactNode }) {
  const { taskId } = useContext(MarkdownLinkContext);
  const previewUrl = usePreviewUrl(href);
  const taskFile = taskId ? parseLocalFileHref(href) : null;
  return (
    <a
      href={previewUrl ?? href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent hover:underline"
      onClick={taskId && taskFile ? (event) => openTaskFilePreview(event, taskId, taskFile) : undefined}
    >
      {children}
    </a>
  );
}

/** `![](shot.png)` shows the picture; `![](demo.mp4)` shows a player. */
function MarkdownImage({ src, alt, title }: { src?: string | Blob; alt?: string; title?: string }) {
  const { taskId } = useContext(MarkdownLinkContext);
  const href = typeof src === 'string' ? src : undefined;
  const previewUrl = usePreviewUrl(href);
  const local = parseLocalFileHref(href);
  const kind = local ? previewMediaKind(local) : null;
  // In the chat a local file has no URL until the server has opened a preview.
  const taskPath = taskId && kind ? local : null;
  // A picture loads by itself. A recording waits for a click: fetching one
  // moves the whole file through the server, which nobody asked for by merely
  // scrolling past it.
  const [wanted, setWanted] = useState(false);
  const taskMedia = useTaskMedia(kind === 'image' || wanted ? taskPath : null);
  if (taskPath && kind !== 'image' && !wanted) {
    return (
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-accent hover:underline"
        onClick={() => setWanted(true)}
      >
        ▶ {alt || taskPath}
      </button>
    );
  }
  if (taskPath && !taskMedia.url) {
    return (
      <span className="text-muted" title={taskMedia.error}>
        {taskMedia.error ? `${alt || taskPath} (${taskMedia.error})` : alt || taskPath}
      </span>
    );
  }
  const url = taskPath ? taskMedia.url : previewUrl ?? href;
  // In a previewed document nothing is fetched until play is pressed either.
  if (kind === 'video') return <video src={url} title={title} controls autoPlay={wanted} preload="none" />;
  if (kind === 'audio') return <audio src={url} title={title} controls autoPlay={wanted} preload="none" />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt ?? ''} title={title} />;
}

// Module-level so element types stay stable across renders (inline component
// functions would remount every code/pre/link node on each render).
const REMARK_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS: Components = {
  code({ className, children, ...props }) {
    return <code className={className} {...props}>{children}</code>;
  },
  pre({ children }) {
    return <pre className="overflow-x-auto rounded-lg border border-border bg-panel p-3">{children}</pre>;
  },
  a: MarkdownLink,
  img: MarkdownImage,
};

// The default transform drops `file://` links to an empty href; they are
// exactly the links a preview is for.
const urlTransform = (url: string) => (/^file:\/\//i.test(url) ? url : defaultUrlTransform(url));

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  taskId,
  previewToken,
  previewPath,
}: MarkdownRendererProps) {
  // Split content by mermaid code blocks
  const parts = splitMermaidBlocks(content);
  const linkContext = useMemo(
    () => ({ taskId, previewToken, previewPath }),
    [taskId, previewToken, previewPath],
  );

  return (
    <MarkdownLinkContext.Provider value={linkContext}>
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {parts.map((part, index) => {
        const partKey = `${part.type}-${index}-${part.content.slice(0, 20)}`;
        if (part.type === 'mermaid') {
          return <MermaidDiagram key={partKey} code={part.content} />;
        }
        return (
          <ReactMarkdown
            key={partKey}
            remarkPlugins={REMARK_PLUGINS}
            components={MARKDOWN_COMPONENTS}
            urlTransform={urlTransform}
          >
            {part.content}
          </ReactMarkdown>
        );
      })}
    </div>
    </MarkdownLinkContext.Provider>
  );
});

interface ContentPart {
  type: 'text' | 'mermaid';
  content: string;
}

function splitMermaidBlocks(content: string): ContentPart[] {
  const parts: ContentPart[] = [];
  const mermaidRegex = /```mermaid\n([\s\S]*?)```/g;

  let lastIndex = 0;
  let match;

  while ((match = mermaidRegex.exec(content)) !== null) {
    // Add text before mermaid block
    if (match.index > lastIndex) {
      const text = content.slice(lastIndex, match.index);
      if (text.trim()) {
        parts.push({ type: 'text', content: text });
      }
    }

    // Add mermaid block
    parts.push({ type: 'mermaid', content: match[1].trim() });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    const text = content.slice(lastIndex);
    if (text.trim()) {
      parts.push({ type: 'text', content: text });
    }
  }

  // If no parts, return original content as text
  if (parts.length === 0) {
    parts.push({ type: 'text', content });
  }

  return parts;
}
