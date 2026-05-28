import type { Metadata } from 'next';
import { Suspense } from 'react';
import PaymentCancelClient from './PaymentCancelClient';

export const metadata: Metadata = {
  title: 'Payment Canceled | Conductor',
};

export default function PaymentCancelPage() {
  return (
    <Suspense fallback={null}>
      <PaymentCancelClient />
    </Suspense>
  );
}
