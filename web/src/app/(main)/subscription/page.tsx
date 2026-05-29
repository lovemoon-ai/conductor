'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ThemeToggle } from '@/components/theme/ThemeToggle';
import { SectionCard } from '@/components/common/SectionCard';
import { useToast } from '@/components/common/FeedbackProvider';
import { useTranslation, toIntlLocale } from '@/lib/i18n';

interface SubscriptionStatus {
  status: string;
  tier: string;
  isActive: boolean;
  daysRemaining: number;
  expiresAt: string | null;
  trialEndsAt: string | null;
  subscriptionEndsAt: string | null;
  lastPaymentAt: string | null;
}

export default function SubscriptionPage() {
  const { push } = useRouter();
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [payingProvider, setPayingProvider] = useState<'ALIPAY' | 'STRIPE' | null>(null);

  const { lang, t } = useTranslation();
  const { pushToast } = useToast();
  const storedTokenRef = useRef<string | null | undefined>(undefined);
  const getStoredToken = () => {
    if (storedTokenRef.current === undefined) {
      storedTokenRef.current = localStorage.getItem('conductor.jwt');
    }
    return storedTokenRef.current;
  };
  const isPlusLikeTier = status?.tier === 'PLUS' || status?.tier === 'PLUS_DEV';
  const tierLabel =
    status?.tier === 'FREE'
      ? t.subscription.tierFree
      : status?.tier === 'PLUS'
      ? t.subscription.tierPlus
      : status?.tier === 'PLUS_DEV'
      ? 'Plus Dev'
      : status?.tier ?? '';

  useEffect(() => {
    fetchSubscriptionStatus();
  }, []);

  const fetchSubscriptionStatus = async () => {
    try {
      const token = getStoredToken();
      if (!token) {
        push('/login');
        return;
      }

      const response = await fetch('/api/subscription/status', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (response.ok) {
        const data = await response.json();
        setStatus(data);
      } else if (response.status === 401) {
        push('/login');
      }
    } catch (error) {
      console.error('Failed to fetch subscription status:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubscribe = async (provider: 'ALIPAY' | 'STRIPE') => {
    if (provider === 'STRIPE') {
      pushToast({
        title: t.subscription.stripeUnsupported,
        variant: 'warning',
      });
      return;
    }
    setPayingProvider(provider);
    try {
      const token = getStoredToken();
      if (!token) {
        push('/login');
        return;
      }

      const response = await fetch('/api/subscription/create-payment', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider }),
      });

      if (response.ok) {
        const data = await response.json();
        const paymentUrl = data.paymentUrl as string | undefined;
        if (!paymentUrl) {
          throw new Error('Missing payment URL');
        }
        if (provider === 'ALIPAY' && paymentUrl?.trim().startsWith('<form')) {
          const container = document.createElement('div');
          container.innerHTML = paymentUrl;
          document.body.appendChild(container);
          const form = container.querySelector('form');
          if (form) {
            form.submit();
            return;
          }
        }
        window.location.href = paymentUrl;
      } else {
        pushToast({
          title: t.subscription.createPaymentFailed,
          variant: 'error',
        });
      }
    } catch (error) {
      console.error('Failed to create payment:', error);
      pushToast({
        title: t.subscription.createPaymentFailed,
        variant: 'error',
      });
    } finally {
      setPayingProvider(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-[var(--muted)]">{t.common.loading}</div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-red-600">{t.subscription.loadFailed}</div>
      </div>
    );
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString(toIntlLocale(lang), {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex justify-between items-center px-8 py-6 border-b border-[var(--border)]">
        <Link href="/" className="font-bold text-lg tracking-wider uppercase hover:opacity-80">
          {t.common.title}
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 px-8 py-12">
        <div className="max-w-4xl mx-auto w-full">
          <div className="mb-8">
            <Link href="/" className="text-sm text-[var(--accent)] hover:underline">
              ← {t.common.backHome}
            </Link>
            <h1 className="text-3xl font-bold mt-4">{t.subscription.pageTitle}</h1>
            <p className="text-sm text-[var(--muted)] mt-2">
              {t.subscription.pageDescription}
            </p>
          </div>

          <SectionCard title={t.subscription.currentStatus} className="mb-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-[var(--muted)]">{t.subscription.subscriptionStatus}</p>
                <p className="text-lg font-medium">{t.subscription.statusActive}</p>
              </div>
              <div>
                <p className="text-sm text-[var(--muted)]">{t.subscription.subscriptionTier}</p>
                <p className="text-lg font-medium">{tierLabel}</p>
              </div>
              <div>
                <p className="text-sm text-[var(--muted)]">{t.subscription.daysRemaining}</p>
                <p className="text-lg font-medium">{t.subscription.trialNotice}</p>
              </div>
              <div>
                <p className="text-sm text-[var(--muted)]">{t.subscription.expiresAt}</p>
                <p className="text-lg font-medium">{t.subscription.expiredNotice}</p>
              </div>
            </div>

            {status.lastPaymentAt && (
              <div className="mt-4 pt-4 border-t border-[var(--border)]">
                <p className="text-sm text-[var(--muted)]">
                  {t.subscription.lastPaymentAt} {formatDate(status.lastPaymentAt)}
                </p>
              </div>
            )}
          </SectionCard>

          <SectionCard className="">
            <div className="flex items-start justify-between mb-4 gap-4">
              <div>
                <h2 className="text-2xl font-bold">{t.subscription.plusTitle}</h2>
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-[var(--accent)]">¥{t.subscription.priceRMB}</p>
                <p className="text-sm text-[var(--muted)]">{t.subscription.perMonth}</p>
                <p className="text-sm text-[var(--muted)] mt-1">{t.subscription.perMonthUSD}</p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <button type="button"
                onClick={() => handleSubscribe('ALIPAY')}
                disabled={payingProvider !== null}
                className="w-full bg-[var(--accent)] hover:opacity-90 disabled:opacity-60 text-white font-medium py-3 px-4 rounded-lg transition"
              >
                {payingProvider === 'ALIPAY'
                  ? t.subscription.creatingOrder
                  : isPlusLikeTier
                  ? t.subscription.alipayRenew
                  : t.subscription.alipaySubscribe}
              </button>
              <button type="button"
                onClick={() => handleSubscribe('STRIPE')}
                disabled={payingProvider !== null}
                className="w-full border border-[var(--border)] hover:bg-[var(--panel)] disabled:opacity-60 text-[var(--ink)] font-medium py-3 px-4 rounded-lg transition"
              >
                {payingProvider === 'STRIPE'
                  ? t.subscription.creatingOrder
                  : isPlusLikeTier
                  ? t.subscription.stripeRenew
                  : t.subscription.stripeSubscribe}
              </button>
            </div>

            <p className="text-xs text-[var(--muted)] text-center mt-4">
              {t.subscription.paymentNote}
            </p>
          </SectionCard>
        </div>
      </main>

      <footer className="text-center py-8 text-sm text-[var(--muted)] border-t border-[var(--border)]">
        <div className="flex justify-center gap-4">
          <Link href="/terms" className="hover:underline">
            {t.common.terms}
          </Link>
          <Link href="/privacy" className="hover:underline">
            {t.common.privacy}
          </Link>
        </div>
      </footer>
    </div>
  );
}
