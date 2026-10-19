import React from 'react';
import AppLayout from '@/components/AppLayout';
import CatalogueClient from '../catalogue/components/CatalogueClient';

// C15: the public catalogue is not connected and not reachable in M1. Every page is drawn inside the one gate (AppLayout): a visitor with no session gets the login screen, and a person
// who is signed in gets "Not available for your role" because the route is in nobody's list (canAccessPath, src/lib/authStore.ts). Before WEB12b this page stood outside the gate.
export default function CustomerCataloguePage() {
  return (
    <AppLayout>
      <CatalogueClient customerOnly />
    </AppLayout>
  );
}
