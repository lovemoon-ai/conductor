"use client";

import { useEffect } from "react";
import { setStoredLang } from "@/lib/i18n";

const DOC_LANG_OPTIONS = [
  { value: "en", label: "English" },
] as const;

type DocLang = (typeof DOC_LANG_OPTIONS)[number]["value"];

export function DocsLanguageSwitch({ className }: { className?: string }) {
  void className;

  useEffect(() => {
    setStoredLang("en" as DocLang);
  }, []);

  return null;
}
