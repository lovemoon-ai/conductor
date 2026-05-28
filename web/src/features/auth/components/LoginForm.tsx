"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "@/lib/i18n";
import { useAuthStore } from "@/features/auth";
import Link from "next/link";

// Common country codes with their dial codes
const COUNTRY_CODES_RAW = [
  { code: "+86", country: "CN", name: "China" },
  { code: "+1", country: "US", name: "United States" },
  { code: "+44", country: "GB", name: "United Kingdom" },
  { code: "+81", country: "JP", name: "Japan" },
  { code: "+82", country: "KR", name: "South Korea" },
  { code: "+65", country: "SG", name: "Singapore" },
  { code: "+852", country: "HK", name: "Hong Kong" },
  { code: "+886", country: "TW", name: "Taiwan" },
  { code: "+61", country: "AU", name: "Australia" },
  { code: "+49", country: "DE", name: "Germany" },
  { code: "+33", country: "FR", name: "France" },
  { code: "+39", country: "IT", name: "Italy" },
  { code: "+34", country: "ES", name: "Spain" },
  { code: "+31", country: "NL", name: "Netherlands" },
  { code: "+7", country: "RU", name: "Russia" },
  { code: "+91", country: "IN", name: "India" },
  { code: "+55", country: "BR", name: "Brazil" },
  { code: "+52", country: "MX", name: "Mexico" },
  { code: "+60", country: "MY", name: "Malaysia" },
  { code: "+66", country: "TH", name: "Thailand" },
  { code: "+84", country: "VN", name: "Vietnam" },
  { code: "+62", country: "ID", name: "Indonesia" },
  { code: "+63", country: "PH", name: "Philippines" },
  { code: "+971", country: "AE", name: "UAE" },
  { code: "+966", country: "SA", name: "Saudi Arabia" },
  { code: "+972", country: "IL", name: "Israel" },
  { code: "+27", country: "ZA", name: "South Africa" },
  { code: "+64", country: "NZ", name: "New Zealand" },
  { code: "+41", country: "CH", name: "Switzerland" },
  { code: "+46", country: "SE", name: "Sweden" },
];

function dialCodeToNumber(code: string): number {
  return Number.parseInt(code.replace("+", ""), 10);
}

const COUNTRY_CODES = COUNTRY_CODES_RAW.toSorted((a, b) => {
  const diff = dialCodeToNumber(a.code) - dialCodeToNumber(b.code);
  if (diff !== 0) return diff;
  return a.country.localeCompare(b.country);
});

// Map country code to dial code
const COUNTRY_TO_DIAL: Record<string, string> = {};
COUNTRY_CODES.forEach((c) => {
  COUNTRY_TO_DIAL[c.country] = c.code;
});

function detectInitialCountryCode(): string {
  if (typeof window === 'undefined') {
    return '+86';
  }

  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezoneToCountry: Record<string, string> = {
      'Asia/Shanghai': 'CN',
      'Asia/Hong_Kong': 'HK',
      'Asia/Taipei': 'TW',
      'Asia/Tokyo': 'JP',
      'Asia/Seoul': 'KR',
      'Asia/Singapore': 'SG',
      'America/New_York': 'US',
      'America/Los_Angeles': 'US',
      'America/Chicago': 'US',
      'Europe/London': 'GB',
      'Europe/Paris': 'FR',
      'Europe/Berlin': 'DE',
      'Australia/Sydney': 'AU',
      'Asia/Kolkata': 'IN',
    };

    const timezoneCountry = timezoneToCountry[timezone];
    if (timezoneCountry && COUNTRY_TO_DIAL[timezoneCountry]) {
      return COUNTRY_TO_DIAL[timezoneCountry];
    }

    const locale = navigator.language || 'en-US';
    const localeCountry = locale.split('-')[1]?.toUpperCase();
    if (localeCountry && COUNTRY_TO_DIAL[localeCountry]) {
      return COUNTRY_TO_DIAL[localeCountry];
    }
  } catch {
  }

  return '+86';
}

const subscribeToHydration = () => () => {};

function countryToFlag(countryCode: string): string {
  const FLAG_OVERRIDES: Record<string, string> = {
    TW: "🇹🇼",
  };
  const upper = countryCode.toUpperCase();
  if (FLAG_OVERRIDES[upper]) {
    return FLAG_OVERRIDES[upper];
  }
  return countryCode
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

interface LoginFormProps {
  onSuccess?: (token: string) => void;
  stayOnSuccess?: boolean;
}

export function LoginForm({ onSuccess, stayOnSuccess = false }: LoginFormProps) {
  const autoCountryCode = useSyncExternalStore(subscribeToHydration, detectInitialCountryCode, () => "+86");
  const [phone, setPhone] = useState("");
  const [countryCodeOverride, setCountryCodeOverride] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [showInviteCode, setShowInviteCode] = useState(false);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  const { t } = useTranslation();
  const establishSession = useAuthStore((state) => state.establishSession);
  const countryCode = countryCodeOverride ?? autoCountryCode;

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown((prev) => prev - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const requestCode = async () => {
    if (!phone) return;
    setLoading(true);
    try {
      const res = await fetch("/api/auth/request-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, countryCode }),
      });
      const data = await res.json();
      if (res.ok) {
        if (typeof data.code === "string" && data.code.trim().length > 0) {
          setCode(data.code.trim());
        }
        setStatus("");
        setCountdown(60);
      } else {
        setStatus(data.error || t.loginForm.sendFailed);
      }
    } catch {
      setStatus(t.loginForm.networkError);
    }
    setLoading(false);
  };

  const login = async () => {
    if (!phone || !code) return;
    setLoading(true);
    try {
      const inviteCodeValue = inviteCode.trim();
      const invitePart = inviteCodeValue ? { inviteCode: inviteCodeValue } : {};
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, countryCode, code, ...invitePart }),
      });
      const data = await res.json();
      if (res.ok) {
        await establishSession(data.token, data.user);
        setStatus(data.registered ? t.loginForm.registered : t.loginForm.loggedIn);
        if (!stayOnSuccess) {
          onSuccess?.(data.token);
        }
      } else {
        setStatus(data.error || t.loginForm.loginFailed);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t.loginForm.networkError);
    }
    setLoading(false);
  };

  return (
    <div className="space-y-5">
      <div className="flex h-14 items-center rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 transition-colors focus-within:border-[var(--accent)]">
        <select
          value={countryCode}
          onChange={(e) => setCountryCodeOverride(e.target.value)}
          aria-label="country code"
          className="h-full min-w-[64px] appearance-none bg-transparent border-0 p-0 text-base text-[var(--ink)] focus:outline-none"
        >
          {COUNTRY_CODES.map((c) => (
            <option key={c.code} value={c.code}>
              {countryToFlag(c.country)} {c.code}
            </option>
          ))}
        </select>
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
          placeholder={t.loginForm.phonePlaceholder}
          aria-label={t.loginForm.phone}
          className="h-full min-w-0 flex-1 bg-transparent border-0 px-1 text-base text-[var(--ink)] focus:outline-none placeholder:text-[var(--muted)]"
        />
        <button
          type="button"
          onClick={() => {
            if (showInviteCode) {
              setInviteCode("");
            }
            setShowInviteCode((prev) => !prev);
          }}
          className="ml-2 shrink-0 border-l border-[var(--border)] pl-3 text-sm text-[var(--accent)] whitespace-nowrap hover:opacity-90 sm:text-base sm:pl-4"
        >
          {t.loginForm.inviteCodeLabel}
        </button>
      </div>
      {showInviteCode && (
        <div className="flex h-14 items-center rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 transition-colors focus-within:border-[var(--accent)]">
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            placeholder={t.loginForm.inviteCodePlaceholder}
            aria-label={t.loginForm.inviteCodeLabel}
            className="h-full w-full bg-transparent border-0 px-1 text-base text-[var(--ink)] focus:outline-none placeholder:text-[var(--muted)]"
          />
        </div>
      )}
      <div className="flex h-14 items-center rounded-full border border-[var(--border)] bg-[var(--panel)] px-4 transition-colors focus-within:border-[var(--accent)]">
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t.loginForm.codePlaceholder}
          aria-label={t.loginForm.code}
          className="h-full min-w-0 flex-1 bg-transparent border-0 px-1 text-base text-[var(--ink)] focus:outline-none placeholder:text-[var(--muted)]"
        />
        <button type="button"
          onClick={requestCode}
          disabled={loading || !phone || countdown > 0}
          className="ml-2 shrink-0 border-l border-[var(--border)] pl-3 text-sm text-[var(--accent)] whitespace-nowrap hover:opacity-90 disabled:opacity-50 sm:text-base sm:pl-4"
        >
          {countdown > 0 ? `${countdown}s` : t.loginForm.sendCode}
        </button>
      </div>
      <p className="text-sm text-[var(--muted)] leading-6">
        {t.loginForm.consentPrefix}
        <Link href="/terms" className="underline underline-offset-2 hover:text-[var(--ink)]">
          {t.common.terms}
        </Link>
        {t.loginForm.consentAnd}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-[var(--ink)]">
          {t.common.privacy}
        </Link>
        {t.loginForm.consentSuffix}
      </p>
      <button type="button"
        onClick={login}
        disabled={loading || !phone || !code}
        className="h-14 w-full rounded-full bg-[var(--accent)] text-lg font-semibold text-white hover:opacity-95 disabled:opacity-50"
      >
        {t.home.login}
      </button>
      {status && <p className="text-sm text-center">{status}</p>}
    </div>
  );
}
