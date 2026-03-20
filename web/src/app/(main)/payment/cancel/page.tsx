import { Suspense } from 'react';
import PaymentCancelClient from './PaymentCancelClient';

export default function PaymentCancelPage() {
  return (
    <Suspense fallback={null}>
      <PaymentCancelClient />
    </Suspense>
  );
}
