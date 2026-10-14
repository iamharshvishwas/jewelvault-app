import React from 'react';
import AppLayout from '@/components/AppLayout';
import InventoryHeader from './components/InventoryHeader';
import InventoryFilters from './components/InventoryFilters';
import InventoryGrid from './components/InventoryGrid';

export default function InventoryManagementPage() {
  return (
    <AppLayout>
      <div className="space-y-4">
        <InventoryHeader />
        <div className="flex gap-4">
          <InventoryFilters />
          <div className="flex-1 min-w-0">
            <InventoryGrid />
          </div>
        </div>
      </div>
    </AppLayout>
  );
}