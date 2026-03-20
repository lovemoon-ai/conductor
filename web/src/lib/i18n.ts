"use client";

import { useState, useEffect, useCallback } from "react";
import { en, type Translations } from "@/locales";

export const SUPPORTED_LANGS = ["en"] as const;

export type Lang = (typeof SUPPORTED_LANGS)[number];

const STORAGE_KEY = "conductor.lang";
const LANG_CHANGE_EVENT = "langchange";

/**
 * Get translations for a specific language
 */
export function getTranslations(lang: Lang): Translations {
  switch (lang) {
    case "en":
    default:
      return en;
  }
}

/**
 * Get the stored language from localStorage
 */
export function getStoredLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isLang(stored)) return stored;

  const detected = detectLangFromNavigator();
  localStorage.setItem(STORAGE_KEY, detected);
  return detected;
}

/**
 * Set the language in localStorage and dispatch change event
 */
export function setStoredLang(lang: Lang): void {
  const next = isLang(lang) ? lang : "en";
  localStorage.setItem(STORAGE_KEY, next);
  window.dispatchEvent(new Event(LANG_CHANGE_EVENT));
}

/**
 * Hook to use translations in components
 */
export function useTranslation() {
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    // Initialize from localStorage
    setLangState(getStoredLang());

    // Listen for language changes
    const handleLangChange = () => {
      setLangState(getStoredLang());
    };

    window.addEventListener("storage", handleLangChange);
    window.addEventListener(LANG_CHANGE_EVENT, handleLangChange);

    return () => {
      window.removeEventListener("storage", handleLangChange);
      window.removeEventListener(LANG_CHANGE_EVENT, handleLangChange);
    };
  }, []);

  const setLang = useCallback((next: Lang) => {
    setStoredLang(next);
    setLangState(next);
  }, []);

  const toggleLang = useCallback(() => {
    const currentIndex = SUPPORTED_LANGS.indexOf(lang);
    const nextIndex = (currentIndex + 1) % SUPPORTED_LANGS.length;
    const next = SUPPORTED_LANGS[nextIndex];
    setLang(next);
  }, [lang, setLang]);

  const t = getTranslations(lang);

  return { lang, setLang, toggleLang, t, languages: LANGUAGE_OPTIONS };
}

/**
 * Helper to interpolate variables in translation strings
 * Usage: interpolate("Hello {name}", { name: "World" }) => "Hello World"
 */
export function interpolate(
  template: string,
  values: Record<string, string | number>
): string {
  return template.replace(/{(\w+)}/g, (_, key) => String(values[key] ?? `{${key}}`));
}

export const LANGUAGE_OPTIONS: Array<{ value: Lang; label: string }> = [
  { value: "en", label: "English" },
];

export const LANG_TO_LOCALE: Record<Lang, string> = {
  en: "en-US",
};

export function toIntlLocale(lang: Lang): string {
  return LANG_TO_LOCALE[lang] ?? "en-US";
}

function isLang(value: unknown): value is Lang {
  return typeof value === "string" && (SUPPORTED_LANGS as readonly string[]).includes(value);
}

/**
 * Detect a supported language from a locale string (e.g., "fr-FR", "zh-Hant-TW").
 * Falls back to English when the locale isn't mapped.
 */
export function detectLangFromLocale(locale: string | null | undefined): Lang {
  void locale;
  return "en";
}

function detectLangFromNavigator(): Lang {
  return "en";
}
