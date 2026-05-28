'use client';

import DOMPurify from 'isomorphic-dompurify';
import { useEffect, useRef, useState } from 'react';

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let mounted = true;

    async function renderDiagram() {
      try {
        // Dynamic import to avoid SSR issues
        const mermaid = (await import('mermaid')).default;

        mermaid.initialize({
          startOnLoad: false,
          theme: 'default',
          securityLevel: 'loose',
        });

        const id = `mermaid-${Math.random().toString(36).slice(2)}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);

        if (mounted) {
          setSvg(renderedSvg);
          setError('');
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to render diagram');
        }
      }
    }

    renderDiagram();

    return () => {
      mounted = false;
    };
  }, [code]);

  if (error) {
    return (
      <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-500">
        <p className="font-medium">Diagram Error</p>
        <pre className="mt-1 text-xs overflow-x-auto">{code}</pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="p-4 bg-panel border border-border rounded-lg animate-pulse">
        <div className="h-32 bg-border/50 rounded" />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="p-4 bg-panel border border-border rounded-lg overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(svg) }}
    />
  );
}
