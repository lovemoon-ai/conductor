"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { termsEnContent } from "@/content/terms-en";
import { useTranslation } from "@/lib/i18n";

export default function TermsOfService() {
  const { t } = useTranslation();
  const content = termsEnContent;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex justify-between items-center px-8 py-6 border-b border-[var(--border)]">
        <Link href="/" className="font-bold text-lg tracking-wider uppercase hover:opacity-80">
          {t.common.title}
        </Link>
        <ThemeToggle />
      </header>

      <main className="flex-1 px-8 py-12 max-w-4xl mx-auto w-full">
        <div className="mb-6">
          <Link href="/" className="text-sm text-[var(--accent)] hover:underline">
            ← {t.common.backHome}
          </Link>
        </div>

        <h1 className="text-4xl font-bold mb-4">{content.title}</h1>
        <p className="text-sm text-[var(--muted)] mb-8">{content.lastUpdated}</p>

        <div className="space-y-8">
          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.acceptance.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.acceptance.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.description.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.description.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.userAccounts.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.userAccounts.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.userConduct.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.userConduct.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.intellectualProperty.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.intellectualProperty.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.dataUsage.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.dataUsage.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.termination.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.termination.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.disclaimer.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.disclaimer.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.limitation.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.limitation.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.changes.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.changes.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.contact.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.contact.content}</p>
          </section>
        </div>
      </main>
    </div>
  );
}
