import React from 'react';
import AppLayout from '@/components/AppLayout';
import OrderBookClient from './components/OrderBookClient';

export default function OrderBookPage() {
  return (
    <AppLayout>
      <OrderBookClient />
    </AppLayout>
  );
}
