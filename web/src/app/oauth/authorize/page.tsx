"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuthStore } from "@/features/auth/store";
import { createApiClientWithToken, ApiRequestError } from "@/shared/api/client";

type Phase =
  | { kind: "init" }
  | { kind: "redirecting-to-login" }
  | { kind: "authorizing" }
  | { kind: "completed" }
  | { kind: "error"; message: string; retryable: boolean };

interface ParsedParams {
  clientId: string;
  redirectUri: string;
  state: string;
  responseType: string;
}

function parseParams(
  searchParams: URLSearchParams,
): { ok: true; data: ParsedParams } | { ok: false; message: string } {
  const clientId = (searchParams.get("client_id") ?? "").trim();
  const redirectUri = (searchParams.get("redirect_uri") ?? "").trim();
  const state = searchParams.get("state") ?? "";
  const responseType = (searchParams.get("response_type") ?? "code").trim();

  if (!clientId) {
    return { ok: false, message: "Missing client_id." };
  }
  if (!redirectUri) {
    return { ok: false, message: "Missing redirect_uri." };
  }
  if (!state) {
    return { ok: false, message: "Missing state." };
  }
  if (responseType !== "code") {
    return { ok: false, message: "Unsupported response_type. Expected 'code'." };
  }

  return {
    ok: true,
    data: { clientId, redirectUri, state, responseType },
  };
}

function AuthorizePageInner() {
  const { replace } = useRouter();
  const searchParams = useSearchParams();
  const session = useAuthStore((state) => state.session);
  const isLoading = useAuthStore((state) => state.isLoading);
  const [phase, setPhase] = useState<Phase>({ kind: "init" });
  const authorizeRunRef = useRef(0);
  const authorizeTimeoutRef = useRef<number | null>(null);

  const queryString = useMemo(() => searchParams.toString(), [searchParams]);
  const jwtToken = session?.jwtToken ?? null;

  const clearAuthorizeTimeout = useCallback(() => {
    if (authorizeTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(authorizeTimeoutRef.current);
    authorizeTimeoutRef.current = null;
  }, []);

  const runAuthorization = useCallback(() => {
    clearAuthorizeTimeout();
    const runId = authorizeRunRef.current + 1;
    authorizeRunRef.current = runId;

    authorizeTimeoutRef.current = window.setTimeout(() => {
      authorizeTimeoutRef.current = null;

      const isActive = () => authorizeRunRef.current === runId;
      const params = new URLSearchParams(queryString);
      const parsed = parseParams(params);
      if (!parsed.ok) {
        if (isActive()) {
          setPhase({ kind: "error", message: parsed.message, retryable: false });
        }
        return;
      }

      const relativePath = queryString ? `/oauth/authorize?${queryString}` : "/oauth/authorize";

      if (!jwtToken) {
        if (isActive()) {
          setPhase({ kind: "redirecting-to-login" });
          replace(`/login?next=${encodeURIComponent(relativePath)}`);
        }
        return;
      }

      const authorize = async () => {
        if (!isActive()) {
          return;
        }

        setPhase({ kind: "authorizing" });

        try {
          const api = createApiClientWithToken(jwtToken);
          const response = await api.post<{ redirect_uri: string }>("/oauth/authorizations", {
            client_id: parsed.data.clientId,
            redirect_uri: parsed.data.redirectUri,
            state: parsed.data.state,
            response_type: parsed.data.responseType,
          });
          if (!isActive()) return;
          if (!response.redirect_uri) {
            setPhase({
              kind: "error",
              message: "Authorization service returned no redirect URI.",
              retryable: true,
            });
            return;
          }
          setPhase({ kind: "completed" });
          window.location.replace(response.redirect_uri);
        } catch (error) {
          if (!isActive()) return;
          if (error instanceof ApiRequestError) {
            if (error.status === 401) {
              setPhase({ kind: "redirecting-to-login" });
              replace(`/login?next=${encodeURIComponent(relativePath)}`);
              return;
            }
            if (error.status === 403) {
              const code = (error.payload as { error?: string })?.error;
              if (code === "unknown_client") {
                setPhase({
                  kind: "error",
                  message: "This app is not allowed to sign in with Conductor.",
                  retryable: false,
                });
                return;
              }
              if (code === "invalid_redirect_uri") {
                setPhase({
                  kind: "error",
                  message: "Invalid redirect URI.",
                  retryable: false,
                });
                return;
              }
            }
            setPhase({
              kind: "error",
              message: error.payload?.message || error.payload?.error || error.message,
              retryable: true,
            });
            return;
          }
          setPhase({
            kind: "error",
            message: error instanceof Error ? error.message : "Failed to create authorization.",
            retryable: true,
          });
        }
      };

      void authorize();
    }, 0);
  }, [clearAuthorizeTimeout, jwtToken, queryString, replace]);

  useEffect(() => {
    setPhase({ kind: "init" });
    runAuthorization();

    return () => {
      authorizeRunRef.current += 1;
      clearAuthorizeTimeout();
    };
  }, [clearAuthorizeTimeout, runAuthorization]);

  const onRetry = () => {
    setPhase({ kind: "init" });
    runAuthorization();
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md text-center space-y-4">
        {phase.kind === "init" && (
          <p className="text-sm text-muted-foreground">Preparing authorization…</p>
        )}
        {phase.kind === "redirecting-to-login" && (
          <p className="text-sm text-muted-foreground">Redirecting to sign in…</p>
        )}
        {phase.kind === "authorizing" && (
          <p className="text-sm text-muted-foreground">
            {isLoading ? "Verifying your session…" : "Creating authorization…"}
          </p>
        )}
        {phase.kind === "completed" && (
          <p className="text-sm text-muted-foreground">Returning to the app…</p>
        )}
        {phase.kind === "error" && (
          <div className="space-y-3">
            <p className="text-sm text-red-600 dark:text-red-400">{phase.message}</p>
            {phase.retryable && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function OAuthAuthorizePage() {
  return (
    <Suspense fallback={null}>
      <AuthorizePageInner />
    </Suspense>
  );
}
