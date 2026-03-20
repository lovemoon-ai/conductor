import { Layout } from "nextra-theme-blog";
import { getPageMap } from "nextra/page-map";
import { DocsBlogBanner } from "@/components/docs/DocsBlogBanner";
import { DocsFooter } from "@/components/docs/DocsFooter";
import "nextra-theme-blog/style.css";

type DocsLayoutProps = {
  children: React.ReactNode;
  params: Promise<{ mdxPath?: string[] }>;
};

function getDocsLang(mdxPath?: string[]): "en" {
  void mdxPath;
  return "en";
}

export default async function DocsLayout({ children, params }: DocsLayoutProps) {
  const { mdxPath } = await params;
  const lang = getDocsLang(mdxPath);
  const pageMap = await getPageMap(`/docs/${lang}`);
  const isIndex = !mdxPath || mdxPath.length <= 1;
  const currentPath =
    mdxPath && mdxPath.length > 1 ? `/docs/${lang}/${mdxPath.slice(1).join("/")}` : `/docs/${lang}`;

  return (
    <>
      <Layout
        banner={<DocsBlogBanner lang={lang} pageMap={pageMap} isIndex={isIndex} currentPath={currentPath} />}
        nextThemes={{ defaultTheme: "system", enableSystem: true }}
      >
        {children}
      </Layout>
      <DocsFooter />
    </>
  );
}
