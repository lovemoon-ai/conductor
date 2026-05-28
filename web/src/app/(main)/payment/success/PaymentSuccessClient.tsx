'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslation, interpolate } from '@/lib/i18n';

export default function PaymentSuccessClient() {
  const searchParams = useSearchParams();
  const [countdown, setCountdown] = useState(5);
  const [queryStatus, setQueryStatus] = useState<'pending' | 'success' | 'failed'>('pending');
  const orderId = searchParams.get('order_id');

  const { t } = useTranslation();

  const navigateToHome = () => {
    window.location.href = '/';
  };

  useEffect(() => {
    const queryOrderStatus = async () => {
      if (!orderId) {
        setQueryStatus('failed');
        return;
      }

      try {
        const token = localStorage.getItem('conductor.jwt');
        if (!token) {
          setQueryStatus('failed');
          return;
        }

        const response = await fetch('/api/payment/alipay/query', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ orderId }),
        });

        if (response.ok) {
          const data = await response.json();
          if (data.status === 'COMPLETED' || data.status === 'TRADE_SUCCESS') {
            setQueryStatus('success');
          } else {
            setQueryStatus('failed');
          }
        } else {
          setQueryStatus('failed');
        }
      } catch (error) {
        console.error('Failed to query order status:', error);
        setQueryStatus('failed');
      }
    };

    queryOrderStatus();
  }, [orderId]);

  useEffect(() => {
    if (countdown <= 0) {
      navigateToHome();
      return;
    }

    const timer = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(timer);
  }, [countdown]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900 px-4">
      <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 text-center">
        <div className="mb-6">
          <div className="mx-auto size-16 bg-green-100 dark:bg-green-900 rounded-full flex items-center justify-center">
            <svg
              className="size-10 text-green-600 dark:text-green-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
          {t.paymentSuccess.title}
        </h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {queryStatus === 'pending' && t.paymentSuccess.confirmingStatus}
          {queryStatus === 'success' && t.paymentSuccess.subscriptionActivated}
          {queryStatus === 'failed' && t.paymentSuccess.statusPending}
        </p>

        {orderId && (
          <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
            <p className="text-sm text-gray-600 dark:text-gray-400">{t.paymentSuccess.orderId}</p>
            <p className="text-sm font-mono text-gray-900 dark:text-white break-all">
              {orderId}
            </p>
          </div>
        )}

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {interpolate(t.paymentSuccess.redirectCountdown, { seconds: countdown })}
        </p>

        <button type="button"
          onClick={navigateToHome}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded-lg transition-colors"
        >
          {t.paymentSuccess.returnNow}
        </button>
      </div>
    </div>
  );
}
