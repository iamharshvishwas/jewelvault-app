import React from 'react';
import AppLayout from '@/components/AppLayout';
import CustomerLedgerClient from './components/CustomerLedgerClient';

export default function CustomerLedgerPage() {
  return (
    <AppLayout>
      <CustomerLedgerClient />
    </AppLayout>
  );
}