"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConductorLogo } from "@/components/ui/ConductorLogo";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { useTranslation } from "@/lib/i18n";
import { useAuthStore } from "@/features/auth";
import { useAuthStorageSync } from "@/features/auth";

type OAuthBootstrapState = "idle" | "loading" | "retrying" | "failed";

const OAUTH_BOOTSTRAP_MAX_ATTEMPTS = 3;
const OAUTH_BOOTSTRAP_RETRY_DELAY_MS = 2000;
const GITHUB_REPO_URL = "https://github.com/lovemoon-ai/conductor";

export default function Home() {
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);

  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [oauthBootstrapState, setOauthBootstrapState] = useState<OAuthBootstrapState>("idle");
  const [oauthBootstrapError, setOauthBootstrapError] = useState<string | null>(null);
  const [oauthRetryNonce, setOauthRetryNonce] = useState(0);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  const { t } = useTranslation();
  const session = useAuthStore((state) => state.session);
  const initFromStorage = useAuthStore((state) => state.initFromStorage);
  const establishSession = useAuthStore((state) => state.establishSession);
  const clearAuthSession = useAuthStore((state) => state.logout);
  const isOAuthBootstrapBlocking = oauthBootstrapState !== "idle";
  const token = isAuthReady && !isOAuthBootstrapBlocking ? session?.jwtToken ?? null : null;

  const clearAuthState = useCallback(() => {
    clearAuthSession();
  }, [clearAuthSession]);

  const syncStoredAuth = useCallback(async () => {
    setIsAuthReady(false);
    try {
      await initFromStorage();
    } catch {
      clearAuthState();
    } finally {
      setIsAuthReady(true);
    }
  }, [clearAuthState, initFromStorage]);

  useAuthStorageSync(syncStoredAuth);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get("token");
    let retryTimeoutId: number | null = null;
    let cancelled = false;

    const clearQueryParams = () => {
      params.delete("token");
      const next = params.toString();
      window.history.replaceState({}, "", next ? `/?${next}` : "/");
    };

    const syncAuth = async () => {
      if (urlToken) {
        const attemptOAuthBootstrap = async (attempt: number) => {
          if (cancelled) {
            return;
          }

          setIsAuthReady(false);
          setOauthBootstrapState(attempt === 1 ? "loading" : "retrying");
          setOauthBootstrapError(null);

          try {
            await establishSession(urlToken);
            if (cancelled) {
              return;
            }
            clearQueryParams();
            setOauthBootstrapState("idle");
            setOauthBootstrapError(null);
            setIsAuthReady(true);
          } catch (error) {
            if (cancelled) {
              return;
            }

            if (error instanceof Error && error.message === "Unauthorized") {
              clearQueryParams();
              clearAuthState();
              setOauthBootstrapState("idle");
              setOauthBootstrapError(null);
              setIsAuthReady(true);
              return;
            }

            const message = error instanceof Error ? error.message : t.loginForm.networkError;
            if (attempt < OAUTH_BOOTSTRAP_MAX_ATTEMPTS) {
              setOauthBootstrapState("retrying");
              setOauthBootstrapError(message);
              retryTimeoutId = window.setTimeout(() => {
                void attemptOAuthBootstrap(attempt + 1);
              }, OAUTH_BOOTSTRAP_RETRY_DELAY_MS);
              return;
            }

            setOauthBootstrapState("failed");
            setOauthBootstrapError(message);
            setIsAuthReady(true);
          }
        };

        await attemptOAuthBootstrap(1);
        return;
      }

      setOauthBootstrapState("idle");
      setOauthBootstrapError(null);

      await syncStoredAuth();
    };

    void syncAuth();

    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [clearAuthState, establishSession, oauthRetryNonce, syncStoredAuth, t.loginForm.networkError]);

  useEffect(() => {
    if (!isActionsMenuOpen) {
      return;
    }
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(target)) {
        setIsActionsMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleMouseDown);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown);
    };
  }, [isActionsMenuOpen]);

  const logout = () => {
    clearAuthState();
  };

  const copyCommand = async (command: string) => {
    try {
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(command);
        copied = true;
      }
      if (!copied) {
        const textarea = document.createElement("textarea");
        textarea.value = command;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.top = "-1000px";
        textarea.style.left = "-1000px";
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      if (copied) {
        setCopiedCommand(command);
        window.setTimeout(() => setCopiedCommand(null), 2000);
      }
    } catch {
      // Silent fail
    }
  };

  const topbarCircleButtonClass =
    "w-9 h-9 flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--border)] transition-colors";
  const oauthBootstrapMessage =
    oauthBootstrapState === "failed"
      ? t.home.authRetryFailed
      : oauthBootstrapState === "retrying"
        ? t.home.authRetrying
        : t.home.authCompleting;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex justify-between items-center px-8 py-6">
        <Link href="/" className="shrink-0">
          <ConductorLogo
            title={t.common.title}
            className="gap-2.5"
            iconClassName="h-10 w-10 rounded-lg"
            titleClassName="text-lg font-bold tracking-wider uppercase"
            priority
          />
        </Link>
        <div className="flex items-center gap-3">
          <div className="hidden md:flex items-center gap-3">
            <ThemeToggle />
            <Link href="/docs" className={topbarCircleButtonClass} aria-label={t.common.docs} title={t.common.docs}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7.5 3.75h7.5l3 3v13.5A1.5 1.5 0 0116.5 21h-9A1.5 1.5 0 016 19.5v-14A1.75 1.75 0 017.75 3.75z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 10.5h4M10 14h4M16.5 3.75V7.5h3" />
              </svg>
            </Link>
            <a
              href={GITHUB_REPO_URL}
              target="_blank"
              rel="noreferrer"
              className={topbarCircleButtonClass}
              aria-label="GitHub"
              title="GitHub"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 .5a12 12 0 00-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.38-1.33-1.74-1.33-1.74-1.09-.74.08-.72.08-.72 1.2.09 1.84 1.22 1.84 1.22 1.08 1.82 2.82 1.3 3.5 1 .11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.31-5.47-5.86 0-1.3.47-2.36 1.24-3.2-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.22a11.6 11.6 0 016 0c2.28-1.54 3.29-1.22 3.29-1.22.67 1.64.25 2.86.12 3.16.77.84 1.24 1.9 1.24 3.2 0 4.56-2.81 5.55-5.49 5.85.43.37.81 1.1.81 2.23v3.3c0 .32.21.7.82.58A12 12 0 0012 .5z" />
              </svg>
            </a>
            {token ? (
              <>
                <Link href="/app" className="px-4 py-2 bg-[var(--accent)] text-white rounded-full text-sm">
                  {t.home.enterApp}
                </Link>
                <button type="button" onClick={logout} className={topbarCircleButtonClass} aria-label={t.home.logout} title={t.home.logout}>
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-7.5a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 006 21h7.5a2.25 2.25 0 002.25-2.25V15m3-3h-9m0 0l3-3m-3 3l3 3" />
                  </svg>
                </button>
              </>
            ) : (
              <Link href="/login" className="px-4 py-2 bg-[var(--accent)] text-white rounded-full text-sm">
                {t.home.login}
              </Link>
            )}
          </div>
          <div ref={actionsMenuRef} className="relative md:hidden">
            <button
              type="button"
              onClick={() => {
                setIsActionsMenuOpen((prev) => !prev);
              }}
              className={topbarCircleButtonClass}
              aria-label="Open actions menu"
              title="Actions"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            {isActionsMenuOpen && (
              <div className="absolute right-0 z-20 mt-2 min-w-40 rounded-xl border border-[var(--border)] bg-zinc-200/55 p-1 shadow-xl backdrop-blur-md dark:bg-zinc-800/55">
                <ThemeToggle variant="menu-item" labels={{ dark: t.common.themeDark, light: t.common.themeLight }} />
                <Link
                  href="/docs"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--panel)]"
                  onClick={() => setIsActionsMenuOpen(false)}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7.5 3.75h7.5l3 3v13.5A1.5 1.5 0 0116.5 21h-9A1.5 1.5 0 016 19.5v-14A1.75 1.75 0 017.75 3.75z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 10.5h4M10 14h4M16.5 3.75V7.5h3" />
                  </svg>
                  <span>{t.common.docs}</span>
                </Link>
                <a
                  href={GITHUB_REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--panel)]"
                  onClick={() => setIsActionsMenuOpen(false)}
                >
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M12 .5a12 12 0 00-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.42-4.04-1.42-.55-1.38-1.33-1.74-1.33-1.74-1.09-.74.08-.72.08-.72 1.2.09 1.84 1.22 1.84 1.22 1.08 1.82 2.82 1.3 3.5 1 .11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.31-5.47-5.86 0-1.3.47-2.36 1.24-3.2-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.3 1.22a11.6 11.6 0 016 0c2.28-1.54 3.29-1.22 3.29-1.22.67 1.64.25 2.86.12 3.16.77.84 1.24 1.9 1.24 3.2 0 4.56-2.81 5.55-5.49 5.85.43.37.81 1.1.81 2.23v3.3c0 .32.21.7.82.58A12 12 0 0012 .5z" />
                  </svg>
                  <span>GitHub</span>
                </a>
                {token ? (
                  <>
                    <Link
                      href="/app"
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--panel)]"
                      onClick={() => setIsActionsMenuOpen(false)}
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                      </svg>
                      <span>{t.home.enterApp}</span>
                    </Link>
                    <button
                      type="button"
                      onClick={() => {
                        logout();
                        setIsActionsMenuOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--panel)]"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-7.5a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 006 21h7.5a2.25 2.25 0 002.25-2.25V15m3-3h-9m0 0l3-3m-3 3l3 3" />
                      </svg>
                      <span>{t.home.logout}</span>
                    </button>
                  </>
                ) : (
                  <Link
                    href="/login"
                    className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--panel)]"
                    onClick={() => setIsActionsMenuOpen(false)}
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-7.5a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 006 21h7.5a2.25 2.25 0 002.25-2.25V15m3-3h9m0 0l-3-3m3 3l-3 3" />
                    </svg>
                    <span>{t.home.login}</span>
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-8">
        {oauthBootstrapState !== "idle" && (
          <div
            role="status"
            className="mb-6 w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{oauthBootstrapMessage}</p>
                {oauthBootstrapError && (
                  <p className="mt-1 text-sm text-[var(--muted)]">{oauthBootstrapError}</p>
                )}
              </div>
              {oauthBootstrapState === "failed" && (
                <button
                  type="button"
                  className="shrink-0 rounded-full border border-[var(--border)] px-4 py-2 text-sm hover:bg-black/5 transition-colors"
                  onClick={() => setOauthRetryNonce((value) => value + 1)}
                >
                  {t.home.authRetryAction}
                </button>
              )}
            </div>
          </div>
        )}

        {token && <h1 className="text-5xl font-bold mb-6">{t.common.title}</h1>}
        {!token && (
          <div className="relative mb-10 max-w-3xl text-center">
            <div className="slogan-spotlight" />
            <p className="slogan-text">{t.home.sloganLine1}</p>
            <p className="slogan-text">{t.home.sloganLine2}</p>
          </div>
        )}

        {token && (
          <div className="w-full max-w-2xl p-6 mt-6 bg-[var(--panel)] rounded-2xl border border-[var(--border)] shadow-lg">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-xl font-semibold">{t.home.cliTitle}</h2>
            </div>
            <p className="text-sm text-[var(--muted)] mb-4">{t.home.cliHint}</p>

            {/* CLI Install Command */}
            <div>
                <div className="flex items-center justify-between gap-3 px-4 py-3 bg-black/5 rounded-lg border border-[var(--border)]">
                  <code className="text-sm break-all flex-1">curl -fsSL https://conductor-ai.top/install.sh | bash</code>
                  <button
                    type="button"
                    onClick={() => copyCommand("curl -fsSL https://conductor-ai.top/install.sh | bash")}
                    className="p-2 border border-[var(--border)] rounded-full transition-transform active:scale-90 flex-shrink-0"
                    aria-label={copiedCommand === "curl -fsSL https://conductor-ai.top/install.sh | bash" ? t.home.tokenCopied : t.home.tokenCopy}
                    title={copiedCommand === "curl -fsSL https://conductor-ai.top/install.sh | bash" ? t.home.tokenCopied : t.home.tokenCopy}
                  >
                    {copiedCommand === "curl -fsSL https://conductor-ai.top/install.sh | bash" ? (
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 24 24"
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <rect x="2" y="2" width="13" height="13" rx="2" />
                      </svg>
                    )}
                  </button>
                </div>
            </div>
          </div>
        )}

      </main>

      <footer className="text-center py-8 text-sm text-[var(--muted)]">
        <div className="flex justify-center gap-4">
          <Link href="/terms" className="hover:underline">{t.common.terms}</Link>
          <Link href="/privacy" className="hover:underline">{t.common.privacy}</Link>
        </div>
      </footer>
    </div>
  );
}
