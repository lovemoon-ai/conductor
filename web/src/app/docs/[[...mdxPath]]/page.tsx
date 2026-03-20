import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { generateStaticParamsFor, importPage } from "nextra/pages";
import type { ComponentType, ReactNode } from "react";
import { useMDXComponents as getMDXComponents } from "@/mdx-components";

interface DocsPageProps {
  params: Promise<{ mdxPath?: string[] }>;
}

type DocsLang = "en";

function pickDocsLang(acceptLanguage: string | null): DocsLang {
  void acceptLanguage;
  return "en";
}

function resolveDocsLang(mdxPath?: string[], acceptLanguage?: string | null): DocsLang {
  if (mdxPath?.[0] === "en") return "en";
  return pickDocsLang(acceptLanguage ?? null);
}

function resolveMdxPath(mdxPath?: string[], acceptLanguage?: string | null) {
  if (!mdxPath || mdxPath.length === 0) {
    return [pickDocsLang(acceptLanguage ?? null)];
  }
  if (mdxPath[0] === "en") return mdxPath;
  if (mdxPath[0] === "zh") return ["en", ...mdxPath.slice(1)];
  return [pickDocsLang(acceptLanguage ?? null), ...mdxPath];
}

function getRedirectTarget(mdxPath?: string[], acceptLanguage?: string | null) {
  if (!mdxPath || mdxPath.length === 0) {
    return `/docs/${pickDocsLang(acceptLanguage ?? null)}`;
  }
  if (mdxPath[0] === "zh") {
    const tail = mdxPath.slice(1).join("/");
    return tail ? `/docs/en/${tail}` : "/docs/en";
  }
  if (mdxPath[0] === "en") return null;
  return `/docs/${pickDocsLang(acceptLanguage ?? null)}/${mdxPath.join("/")}`;
}

export const generateStaticParams = generateStaticParamsFor("mdxPath");

export async function generateMetadata(props: DocsPageProps) {
  const params = await props.params;
  const acceptLanguage = (await headers()).get("accept-language");
  const lang = resolveDocsLang(params.mdxPath, acceptLanguage);
  const resolvedPath = resolveMdxPath(params.mdxPath, acceptLanguage);
  const { metadata } = await importPage(resolvedPath);
  return { ...metadata, locale: lang };
}

const Wrapper = (getMDXComponents() as unknown as {
  wrapper: ComponentType<{
    children: ReactNode;
    metadata: Awaited<ReturnType<typeof importPage>>["metadata"];
    sourceCode: string;
    toc: Awaited<ReturnType<typeof importPage>>["toc"];
  }>;
}).wrapper;

export default async function DocsPage(props: DocsPageProps) {
  const params = await props.params;
  const acceptLanguage = (await headers()).get("accept-language");
  const redirectTarget = getRedirectTarget(params.mdxPath, acceptLanguage);
  if (redirectTarget) {
    redirect(redirectTarget);
  }
  const resolvedPath = resolveMdxPath(params.mdxPath, acceptLanguage);
  const {
    default: MDXContent,
    toc,
    metadata,
    sourceCode,
  } = await importPage(resolvedPath);

  return (
    <Wrapper toc={toc} metadata={metadata} sourceCode={sourceCode}>
      <MDXContent {...props} params={params} />
    </Wrapper>
  );
}
