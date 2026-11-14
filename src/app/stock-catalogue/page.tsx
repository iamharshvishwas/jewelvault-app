import React from 'react';
import AppLayout from '@/components/AppLayout';
import StockCatalogueClient from './components/StockCatalogueClient';

export default function StockCataloguePage() {
  return (
    <AppLayout>
      <StockCatalogueClient />
    </AppLayout>
  );
}
