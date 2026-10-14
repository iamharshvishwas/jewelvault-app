import React from 'react';
import AppLayout from '@/components/AppLayout';
import BillingPOSClient from './components/BillingPOSClient';

export default function BillingPOSPage() {
  return (
    <AppLayout>
      <BillingPOSClient />
    </AppLayout>
  );
}