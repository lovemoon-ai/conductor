import type { Metadata } from 'next';
import HomePageClient from './HomePageClient';

export const metadata: Metadata = {
  title: 'Conductor',
};

export default function HomePage() {
  return <HomePageClient />;
}
