"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

interface ThemeToggleProps {
  variant?: "button" | "menu-item";
  labels?: {
    dark: string;
    light: string;
  };
}

export function ThemeToggle({ variant = "button", labels }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const darkLabel = labels?.dark ?? "Dark";
  const lightLabel = labels?.light ?? "Light";

  if (!mounted) {
    if (variant === "menu-item") {
      return (
        <div className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm">
          <div className="w-4 h-4" />
          <span>{darkLabel}</span>
        </div>
      );
    }
    return <button className="w-9 h-9" />;
  }

  const isDark = theme === "dark";
  const label = isDark ? darkLabel : lightLabel;

  const handleClick = () => setTheme(isDark ? "light" : "dark");

  const icon = isDark ? (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
    </svg>
  ) : (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );

  if (variant === "menu-item") {
    return (
      <button
        type="button"
        onClick={handleClick}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--panel)]"
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }

  return (
    <button
      onClick={handleClick}
      className="w-9 h-9 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--border)] transition-colors"
      aria-label="Toggle theme"
    >
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        {isDark ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        ) : (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
        )}
      </svg>
    </button>
  );
}
