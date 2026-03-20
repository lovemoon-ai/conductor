"use client";

import Link from "next/link";
import { useTranslation } from "@/lib/i18n";

export function DocsFooter() {
  const { t } = useTranslation();

  return (
    <footer className="px-4 pb-10 pt-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl border-t border-[var(--border)] pt-6 text-center text-sm text-[var(--muted)]">
        <div className="flex justify-center gap-4">
          <Link href="/terms" className="hover:underline">
            {t.common.terms}
          </Link>
          <Link href="/privacy" className="hover:underline">
            {t.common.privacy}
          </Link>
        </div>
      </div>
    </footer>
  );
}
