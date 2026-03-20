import { NextResponse, type NextRequest } from "next/server";

type DocsLang = "zh" | "en";

function pickDocsLang(acceptLanguage: string | null): DocsLang {
  if (!acceptLanguage) return "en";
  const entries = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, qValue] = part.trim().split(";q=");
      const quality = qValue ? Number(qValue) : 1;
      return { tag: tag.toLowerCase(), quality: Number.isNaN(quality) ? 0 : quality };
    })
    .sort((a, b) => b.quality - a.quality);
  for (const entry of entries) {
    if (entry.tag.startsWith("zh")) return "zh";
    if (entry.tag.startsWith("en")) return "en";
  }
  return "en";
}

function buildDocsRedirect(pathname: string, lang: DocsLang) {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "docs") return null;
  const rest = segments.slice(1);
  if (rest[0] === "zh" || rest[0] === "en") return null;
  const tail = rest.length ? `/${rest.join("/")}` : "";
  return `/docs/${lang}${tail}`;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    const lang = pickDocsLang(request.headers.get("accept-language"));
    const redirectPath = buildDocsRedirect(pathname, lang);
    if (redirectPath) {
      return NextResponse.redirect(new URL(redirectPath, request.url));
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/docs", "/docs/:path*"],
};
