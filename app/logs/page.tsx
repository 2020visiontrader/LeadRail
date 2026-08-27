'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import LoadingSpinner from '@/components/LoadingSpinner';

// /logs used to be a standalone page with no role guard of its own — reachable
// by any signed-in user, hidden only by a nav link that wasn't there and an
// API that 403'd once the page had already rendered. The logs UI now lives as
// a tab inside /admin (src/components/admin/LogsPanel.tsx), which gates on
// owner before rendering anything. This route just forwards there so an old
// bookmark or link still lands somewhere correct.
export default function LogsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/admin?tab=logs');
  }, [router]);
  return <LoadingSpinner />;
}
