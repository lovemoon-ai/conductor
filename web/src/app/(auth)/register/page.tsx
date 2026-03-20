"use client";

import { LoginForm } from "@/components/auth/LoginForm";
import { useRouter } from "next/navigation";
import { useTranslation } from "@/lib/i18n";

export default function RegisterPage() {
  const router = useRouter();
  const { t } = useTranslation();

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md p-6 bg-[var(--panel)] rounded-2xl border border-[var(--border)] shadow-lg">
        <h1 className="text-2xl font-bold mb-6 text-center">{t.home.register}</h1>
        <LoginForm stayOnSuccess onSuccess={() => router.push("/")} />
      </div>
    </div>
  );
}
