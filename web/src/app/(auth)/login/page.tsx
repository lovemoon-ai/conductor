"use client";

import { LoginForm } from "@/features/auth";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function resolveSafeNextPath(value: string | null): string {
  const nextPath = value?.trim() || "/";
  if (!nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return "/";
  }
  return nextPath;
}

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = resolveSafeNextPath(searchParams.get("next"));

  return (
    <div className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-md">
        <LoginForm onSuccess={() => router.replace(nextPath)} />
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}
