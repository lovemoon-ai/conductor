"use client";

import Link from "next/link";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { privacyEnContent } from "@/content/privacy-en";
import { useTranslation } from "@/lib/i18n";

export default function PrivacyPolicy() {
  const { t } = useTranslation();
  const content = privacyEnContent;

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
            <h2 className="text-xl font-semibold mb-3">{content.sections.introduction.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.introduction.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.informationCollection.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.informationCollection.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.howWeUse.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.howWeUse.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.dataSharing.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.dataSharing.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.dataSecurity.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.dataSecurity.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.dataRetention.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.dataRetention.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.yourRights.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.yourRights.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.cookies.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.cookies.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.thirdParty.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.thirdParty.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.children.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.children.content}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold mb-3">{content.sections.international.title}</h2>
            <p className="text-[var(--foreground)] leading-relaxed">{content.sections.international.content}</p>
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
