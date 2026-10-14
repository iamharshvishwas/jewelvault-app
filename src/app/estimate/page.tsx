import React from 'react';
import { Suspense } from 'react';
import AppLayout from '@/components/AppLayout';
import EstimateViewClient from './components/EstimateViewClient';

export default function EstimatePage() {
  return (
    <AppLayout>
      <Suspense fallback={<div className="jewel-card p-6 text-sm text-muted-foreground">Loading saved estimates...</div>}>
        <EstimateViewClient />
      </Suspense>
    </AppLayout>
  );
}
