import React from 'react';
import AppLayout from '@/components/AppLayout';
import CatalogueClient from './components/CatalogueClient';

export default function CataloguePage() {
  return (
    <AppLayout>
      <CatalogueClient />
    </AppLayout>
  );
}
