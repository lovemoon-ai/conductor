'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MermaidDiagram } from './MermaidDiagram';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  // Split content by mermaid code blocks
  const parts = splitMermaidBlocks(content);

  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      {parts.map((part, index) => {
        const partKey = `${part.type}-${index}-${part.content.slice(0, 20)}`;
        if (part.type === 'mermaid') {
          return <MermaidDiagram key={partKey} code={part.content} />;
        }
        return (
          <ReactMarkdown
            key={partKey}
            remarkPlugins={[remarkGfm]}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                const isInline = !match;
                return isInline ? (
                  <code className="px-1 py-0.5 bg-border/50 rounded text-sm" {...props}>
                    {children}
                  </code>
                ) : (
                  <pre className="p-3 bg-panel border border-border rounded-lg overflow-x-auto">
                    <code className={className} {...props}>
                      {children}
                    </code>
                  </pre>
                );
              },
              a({ href, children }) {
                return (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    {children}
                  </a>
                );
              },
            }}
          >
            {part.content}
          </ReactMarkdown>
        );
      })}
    </div>
  );
}

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
