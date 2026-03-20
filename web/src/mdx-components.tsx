import type { ReactNode } from "react";
import { DocsCodeBlock } from "@/components/docs/DocsCodeBlock";
import { DocsIndexCards } from "@/components/docs/DocsIndexCards";
import { useMDXComponents as getThemeComponents } from "nextra-theme-blog";

const themeComponents = getThemeComponents();

export function useMDXComponents(components = {}) {
  return {
    ...themeComponents,
    wrapper({
      children,
      metadata,
    }: {
      children: ReactNode;
      metadata?: { title?: string; description?: string };
    }) {
      return (
        <>
          {metadata?.title ? <h1>{metadata.title}</h1> : null}
          {metadata?.description ? (
            <p className="not-prose -mt-6 mb-8 max-w-2xl text-base leading-7 text-[var(--muted)] sm:text-lg">
              {metadata.description}
            </p>
          ) : null}
          {children}
        </>
      );
    },
    pre: DocsCodeBlock,
    DocsIndexCards,
    ...components,
  };
}
