import type { MdxFile, PageMapItem } from "nextra";
import { getPageMap } from "nextra/page-map";
import { PostCard, type BlogMetadata } from "nextra-theme-blog";

type DocsLang = "zh" | "en";

type DocsPost = {
  route: string;
  frontMatter: BlogMetadata;
};

const COPY = {
  en: {
    eyebrow: "All core docs",
    heading: "Guide index",
    readMore: "Read guide →",
  },
  zh: {
    eyebrow: "核心文档入口",
    heading: "文档目录",
    readMore: "继续阅读 →",
  },
} as const;

function isFolder(item: PageMapItem): item is Extract<PageMapItem, { children: PageMapItem[] }> {
  return "children" in item;
}

function isMdxPage(item: PageMapItem): item is MdxFile<Record<string, unknown>> {
  return "name" in item && "route" in item && !("children" in item);
}

function humanizeName(name: string) {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toBlogMetadata(frontMatter: Record<string, unknown> | undefined, fallbackTitle: string): BlogMetadata {
  return {
    title: typeof frontMatter?.title === "string" ? frontMatter.title : fallbackTitle,
    description: typeof frontMatter?.description === "string" ? frontMatter.description : undefined,
    date: typeof frontMatter?.date === "string" ? frontMatter.date : undefined,
  };
}

function collectPosts(items: PageMapItem[]): DocsPost[] {
  const posts: DocsPost[] = [];

  for (const item of items) {
    if (isFolder(item)) {
      posts.push(...collectPosts(item.children));
      continue;
    }

    if (!isMdxPage(item) || item.name === "index") {
      continue;
    }

    posts.push({
      route: item.route,
      frontMatter: toBlogMetadata(item.frontMatter, humanizeName(item.name)),
    });
  }

  return posts;
}

export async function DocsIndexCards({ lang }: { lang: DocsLang }) {
  const copy = COPY[lang];
  const pageMap = await getPageMap(`/docs/${lang}`);
  const posts = collectPosts(pageMap);

  if (!posts.length) {
    return null;
  }

  return (
    <section className="not-prose mt-12">
      <div className="mb-5 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--accent)]">
            {copy.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--ink)]">
            {copy.heading}
          </h2>
        </div>
        <span className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1 text-sm text-[var(--muted)]">
          {posts.length}
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {posts.map((post) => (
          <article
            key={post.route}
            className="rounded-[24px] border border-[var(--border)] bg-[var(--panel)]/92 p-6 shadow-[0_18px_40px_rgba(15,23,42,0.06)] transition-transform duration-200 hover:-translate-y-0.5"
          >
            <PostCard post={post} readMore={copy.readMore} />
          </article>
        ))}
      </div>
    </section>
  );
}
