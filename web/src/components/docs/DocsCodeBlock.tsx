"use client";

import { isValidElement, useEffect, useMemo, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { useTheme } from "next-themes";

const extractText = (node: ReactNode): string => {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return "";
};

export function DocsCodeBlock({ children, className, ...props }: HTMLAttributes<HTMLPreElement>) {
  const { resolvedTheme } = useTheme();
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  const codeText = useMemo(() => extractText(children).replace(/\n$/, ""), [children]);
  const isDark = resolvedTheme === "dark";

  useEffect(() => {
    return () => {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    if (!codeText) return;
    try {
      let didCopy = false;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(codeText);
        didCopy = true;
      }
      if (!didCopy) {
        const textarea = document.createElement("textarea");
        textarea.value = codeText;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-1000px";
        textarea.style.left = "-1000px";
        document.body.appendChild(textarea);
        textarea.select();
        didCopy = document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      if (didCopy) {
        setCopied(true);
        if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
        timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
      }
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-3 top-3 z-10 rounded-md border border-[var(--border)] bg-[rgba(255,255,255,0.9)] px-2 py-1 text-xs text-[var(--muted)] shadow-sm transition-colors hover:text-[var(--ink)] dark:bg-[rgba(26,29,34,0.92)]"
        aria-label={copied ? "Copied" : "Copy"}
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        {...props}
        className={[
          "docs-code-block overflow-x-auto rounded-[20px] border border-[var(--border)] px-4 py-3 shadow-[0_12px_30px_rgba(15,23,42,0.06)] dark:shadow-none",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        style={{
          background: isDark
            ? "linear-gradient(180deg, #232831 0%, #1b1f26 100%)"
            : "linear-gradient(180deg, #fffdfa 0%, #f8f1e7 100%)",
          color: isDark ? "#f5f3ef" : "#1b2430",
          ...(props.style ?? {}),
        }}
      >
        {children}
      </pre>
    </div>
  );
}
