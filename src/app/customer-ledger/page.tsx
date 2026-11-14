import React, { Suspense } from 'react';
import AppLayout from '@/components/AppLayout';
import CustomerLedgerClient from './components/CustomerLedgerClient';

export default function CustomerLedgerPage() {
  return (
    <AppLayout>
      {/* FB-D3: the screen reads ?customer=<id> (the dashboard's payment alert opens a customer's ledger), which a static page may do only inside Suspense */}
      <Suspense
        fallback={
          <div className="jewel-card p-6 text-sm text-muted-foreground">Loading the ledger...</div>
        }
      >
        <CustomerLedgerClient />
      </Suspense>
    </AppLayout>
  );
}
