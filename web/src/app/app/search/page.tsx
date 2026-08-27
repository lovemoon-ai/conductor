'use client';

import { Header } from '@/components/layout/Header';
import { GlobalSearch } from '@/features/search/components/GlobalSearch';

export default function SearchPage() {
  return (
    <>
      <Header title="Search" compact />
      <GlobalSearch />
    </>
  );
}
