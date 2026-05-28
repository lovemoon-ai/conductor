import type { Metadata } from 'next';
import { Suspense } from 'react';
import PaymentSuccessClient from './PaymentSuccessClient';

export const metadata: Metadata = {
  title: 'Payment Success | Conductor',
};

export default function PaymentSuccessPage() {
  return (
    <Suspense fallback={null}>
      <PaymentSuccessClient />
    </Suspense>
  );
}
