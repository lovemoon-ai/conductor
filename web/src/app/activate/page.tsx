"use client";

import type { ReactNode } from "react";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/features/auth";

type SessionStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

interface DeviceSessionPayload {
  status: SessionStatus;
  user_code: string;
  cli_version: string | null;
  hostname: string | null;
  platform: string | null;
  backend_url: string | null;
  expires_at: string;
  approved_at: string | null;
}

function ActivatePageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initFromStorage = useAuthStore((state) => state.initFromStorage);
  const session = useAuthStore((state) => state.session);
  const userCode = useMemo(() => (searchParams.get("user_code") || "").trim().toUpperCase(), [searchParams]);
  const loginHref = useMemo(() => {
    const returnPath = userCode ? `/activate?user_code=${encodeURIComponent(userCode)}` : "/activate";
    return `/login?next=${encodeURIComponent(returnPath)}`;
  }, [userCode]);

  const [isAuthReady, setIsAuthReady] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [deviceSession, setDeviceSession] = useState<DeviceSessionPayload | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isApproving, setIsApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => {
    initFromStorage().finally(() => setIsAuthReady(true));
  }, [initFromStorage]);

  useEffect(() => {
    if (!userCode) {
      setDeviceSession(null);
      setSessionError("Missing device code.");
      return;
    }

    let cancelled = false;
    setIsLoadingSession(true);
    setSessionError(null);

    fetch(`/api/auth/device/session?user_code=${encodeURIComponent(userCode)}`)
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as DeviceSessionPayload | { error?: string } | null;
        if (!response.ok) {
          throw new Error((payload as { error?: string } | null)?.error || "Failed to load device authorization.");
        }
        if (!cancelled) {
          setDeviceSession(payload as DeviceSessionPayload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setDeviceSession(null);
          setSessionError(error instanceof Error ? error.message : "Failed to load device authorization.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSession(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userCode]);

  useEffect(() => {
    if (!isAuthReady || session || isLoadingSession || sessionError || !deviceSession) {
      return;
    }
    if (deviceSession.status !== "pending") {
      return;
    }
    router.replace(loginHref);
  }, [deviceSession, isAuthReady, isLoadingSession, loginHref, router, session, sessionError]);

  const approve = async () => {
    if (!session?.jwtToken || !userCode) {
      return;
    }

    setIsApproving(true);
    setApproveError(null);
    try {
      const response = await fetch("/api/auth/device/approve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.jwtToken}`,
        },
        body: JSON.stringify({ user_code: userCode }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Failed to authorize device.");
      }

      setDeviceSession((current) =>
        current
          ? {
              ...current,
              status: "approved",
              approved_at: new Date().toISOString(),
            }
          : current,
      );
    } catch (error) {
      setApproveError(error instanceof Error ? error.message : "Failed to authorize device.");
    } finally {
      setIsApproving(false);
    }
  };

  const isSuccessState = deviceSession?.status === "approved" || deviceSession?.status === "consumed";

  if (isSuccessState) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-4 py-10">
        <div className="w-full max-w-md text-center">
          <p className="text-sm font-medium uppercase tracking-[0.24em] text-[var(--accent)]">Conductor CLI</p>
          <h1 className="mt-4 text-3xl font-semibold">Device authorized, close current page.</h1>
          <button
            type="button"
            onClick={() => window.close()}
            className="mt-8 inline-flex h-11 items-center justify-center rounded-full border border-[var(--border)] px-5 text-sm font-semibold text-[var(--text)] transition-colors hover:bg-black/5"
          >
            Close page
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[var(--paper)] px-4 py-10">
      <div className="mx-auto w-full max-w-xl">
        <section className="rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-lg">
          <div className="mb-6">
            <p className="text-sm font-medium uppercase tracking-[0.24em] text-[var(--accent)]">Conductor CLI</p>
          </div>

          {isLoadingSession && <p className="text-sm text-[var(--muted)]">Loading device authorization…</p>}
          {!isLoadingSession && sessionError && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-200">
              {sessionError}
            </div>
          )}

          {!isLoadingSession && deviceSession && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-[var(--border)] bg-black/5 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">Device code</div>
                <div className="mt-3 font-mono text-3xl font-semibold tracking-[0.14em]">{deviceSession.user_code}</div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <InfoCard label="Host" value={deviceSession.hostname || "Unknown"} />
                <InfoCard label="Platform" value={deviceSession.platform || "Unknown"} />
              </div>

              {deviceSession.status === "expired" ? (
                <StatusNotice tone="warning" title="Authorization expired">
                  This device code has expired. Re-run <code>conductor config</code> to get a new code.
                </StatusNotice>
              ) : deviceSession.status === "denied" ? (
                <StatusNotice tone="warning" title="Authorization denied">
                  This authorization request was denied. Re-run <code>conductor config</code> to try again.
                </StatusNotice>
              ) : session ? (
                <div className="space-y-3 text-center">
                  {approveError && <p className="text-sm text-red-500">{approveError}</p>}
                  <button
                    type="button"
                    onClick={approve}
                    disabled={isApproving}
                    className="inline-flex h-11 items-center justify-center rounded-full bg-[var(--accent)] px-5 text-sm font-semibold text-white transition-opacity hover:opacity-95 disabled:opacity-50"
                  >
                    {isApproving ? "Authorizing…" : "Authorize this device"}
                  </button>
                </div>
              ) : isAuthReady ? (
                <p className="text-sm text-[var(--muted)]">Redirecting to login…</p>
              ) : (
                <p className="text-sm text-[var(--muted)]">Checking sign-in status…</p>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function ActivatePage() {
  return (
    <Suspense fallback={null}>
      <ActivatePageContent />
    </Suspense>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--paper)] px-4 py-3">
      <div className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">{label}</div>
      <div className="mt-2 break-all text-sm font-medium">{value}</div>
    </div>
  );
}

function StatusNotice({
  title,
  tone,
  children,
}: {
  title: string;
  tone: "neutral" | "warning";
  children: ReactNode;
}) {
  const className =
    tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200"
      : "border-[var(--border)] bg-[var(--paper)] text-[var(--text)]";
  return (
    <div className={`rounded-2xl border px-4 py-4 text-sm ${className}`}>
      <div className="font-semibold">{title}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}
