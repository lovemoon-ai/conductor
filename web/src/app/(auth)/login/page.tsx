"use client";

import { LoginForm } from "@/components/auth/LoginForm";
import { useRouter, useSearchParams } from "next/navigation";

function resolveSafeNextPath(value: string | null): string {
  const nextPath = value?.trim() || "/";
  if (!nextPath.startsWith("/") || nextPath.startsWith("//")) {
    return "/";
  }
  return nextPath;
}

export default function LoginPage() {
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
