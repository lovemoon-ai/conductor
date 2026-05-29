import type { PageMapItem } from "nextra";
import Link from "next/link";
import { DocsLanguageSwitch } from "@/components/docs/DocsLanguageSwitch";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { ConductorLogo } from "@/components/ui/ConductorLogo";

type DocsLang = "zh" | "en";

type DocsBlogBannerProps = {
  lang: DocsLang;
  pageMap: PageMapItem[];
  isIndex: boolean;
  currentPath: string;
};

const COPY = {
  en: {
    subtitle: "Remote AI orchestration from anywhere",
    site: "Website",
    menu: "Menu",
  },
  zh: {
    subtitle: "随时随地远程指挥你的 AI worker",
    site: "官网",
    menu: "导航",
  },
} as const;

function humanizeName(name: string) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isMetaRecord(item: PageMapItem): item is Extract<PageMapItem, { data: Record<string, unknown> }> {
  return "data" in item;
}

function isPageLike(item: PageMapItem): item is Extract<PageMapItem, { name: string; route: string }> {
  return "name" in item && "route" in item;
}

function resolveLabel(metaRecord: Record<string, unknown> | undefined, item: Extract<PageMapItem, { name: string; route: string }>) {
  const metaValue = metaRecord?.[item.name];

  if (typeof metaValue === "string") {
    return metaValue;
  }

  if (
    metaValue &&
    typeof metaValue === "object" &&
    "title" in metaValue &&
    typeof (metaValue as { title?: unknown }).title === "string"
  ) {
    return (metaValue as { title: string }).title;
  }

  if ("frontMatter" in item && typeof item.frontMatter?.title === "string") {
    return item.frontMatter.title;
  }

  return humanizeName(item.name);
}

function buildNavLinks(pageMap: PageMapItem[]) {
  const metaRecord = pageMap.find(isMetaRecord)?.data;

  return pageMap.flatMap((item) => (
    isPageLike(item)
      ? [{ href: item.route, label: resolveLabel(metaRecord, item) }]
      : []
  ));
}

export function DocsBlogBanner({ lang, pageMap, isIndex, currentPath }: DocsBlogBannerProps) {
  const copy = COPY[lang];
  const docsHome = `/docs/${lang}`;
  const navLinks = buildNavLinks(pageMap);
  const desktopLinkClass = (isActive: boolean) =>
    [
      "rounded-full px-3 py-1.5 transition-colors",
      isActive ? "bg-[var(--paper)] text-[var(--ink)]" : "hover:bg-[var(--paper)] hover:text-[var(--ink)]",
    ].join(" ");
  const mobileLinkClass = (isActive: boolean) =>
    [
      "rounded-2xl border px-4 py-3 text-sm font-medium transition-colors",
      isActive
        ? "border-[var(--accent)] bg-[rgba(228,87,46,0.10)] text-[var(--ink)] dark:bg-[rgba(240,101,67,0.16)]"
        : "border-[var(--border)] bg-[var(--panel)] text-[var(--ink)] hover:bg-[var(--paper)]",
    ].join(" ");

  return (
    <div className="px-4 pt-6 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <div className="relative overflow-visible rounded-[32px] border border-[var(--border)] bg-[linear-gradient(180deg,rgba(255,255,255,0.96),rgba(245,241,234,0.9))] p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] backdrop-blur sm:p-8 dark:bg-[linear-gradient(180deg,rgba(26,29,34,0.98),rgba(16,18,20,0.94))]">
          <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[32px]">
            <div className="absolute inset-x-[-10%] top-[-24%] h-64 rounded-full bg-[radial-gradient(circle,rgba(228,87,46,0.22),rgba(228,87,46,0))]" />
          </div>

          <div className="relative">
            <div className="border-b border-[var(--border)]/80 pb-6">
              <div className="flex items-start justify-between gap-4 md:hidden">
                <Link href={docsHome} className="min-w-0 flex-1">
                  <ConductorLogo
                    title="Conductor Docs"
                    subtitle={copy.subtitle}
                    className="gap-4"
                    iconClassName="h-12 w-12 rounded-2xl"
                    titleClassName="text-xl font-semibold text-[var(--ink)]"
                    subtitleClassName="text-sm text-[var(--muted)]"
                    priority={isIndex}
                  />
                </Link>

                <details className="group relative shrink-0">
                  <summary className="flex list-none items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)]/92 px-4 py-2 text-sm font-medium text-[var(--ink)] shadow-sm transition-colors hover:bg-[var(--paper)] [&::-webkit-details-marker]:hidden">
                    <span>{copy.menu}</span>
                    <svg
                      className="size-4 transition-transform group-open:rotate-180"
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="m5 7.5 5 5 5-5" />
                    </svg>
                  </summary>

                  <div className="absolute right-0 z-20 mt-3 w-[min(18rem,calc(100vw-3rem))] rounded-[24px] border border-[var(--border)] bg-[var(--panel)]/96 p-3 shadow-[0_18px_48px_rgba(15,23,42,0.14)] backdrop-blur">
                    <div className="grid gap-2">
                      {navLinks.map((link) => {
                        const isActive = link.href === currentPath;

                        return (
                          <Link key={link.href} href={link.href} className={mobileLinkClass(isActive)}>
                            {link.label}
                          </Link>
                        );
                      })}

                      <Link href="/" className={mobileLinkClass(false)}>
                        {copy.site}
                      </Link>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-2 rounded-[18px] border border-[var(--border)] bg-[var(--paper)]/70 px-3 py-2">
                      <DocsLanguageSwitch className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-[var(--ink)] shadow-none" />
                      <ThemeToggle />
                    </div>
                  </div>
                </details>
              </div>

              <div className="hidden items-start justify-between gap-6 md:flex">
                <Link href={docsHome} className="min-w-0">
                  <ConductorLogo
                    title="Conductor Docs"
                    subtitle={copy.subtitle}
                    className="gap-4"
                    iconClassName="h-12 w-12 rounded-2xl"
                    titleClassName="text-xl font-semibold text-[var(--ink)]"
                    subtitleClassName="text-sm text-[var(--muted)]"
                    priority={isIndex}
                  />
                </Link>

                <div className="min-w-0 rounded-full border border-[var(--border)] bg-[var(--panel)]/85 px-3 py-2 text-sm text-[var(--muted)] shadow-sm backdrop-blur">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {navLinks.map((link) => {
                      const isActive = link.href === currentPath;

                      return (
                        <Link key={link.href} href={link.href} className={desktopLinkClass(isActive)}>
                          {link.label}
                        </Link>
                      );
                    })}

                    <Link href="/" className={desktopLinkClass(false)}>
                      {copy.site}
                    </Link>
                    <DocsLanguageSwitch className="h-9 border-0 bg-transparent px-3 py-1.5 text-sm text-[var(--ink)] shadow-none" />
                    <ThemeToggle />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
