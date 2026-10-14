import React from 'react';
import AppLayout from '@/components/AppLayout';
import DesignGallery from './components/DesignGallery';
import DesignInfoPanel from './components/DesignInfoPanel';

import DesignTabs from './components/DesignTabs';

export default function DesignDetailPage() {
  return (
    <AppLayout>
      <DesignDetailContent />
    </AppLayout>
  );
}

function DesignDetailContent() {
  return (
    <div className="space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <a href="/inventory-management" className="hover:text-primary transition-colors">Inventory</a>
        <span>/</span>
        <a href="/inventory-management" className="hover:text-primary transition-colors">Necklace Set</a>
        <span>/</span>
        <span className="text-foreground font-semibold font-mono">SET-00572</span>
      </div>

      {/* Top Section */}
      <div className="grid grid-cols-1 lg:grid-cols-5 xl:grid-cols-5 2xl:grid-cols-5 gap-5">
        <div className="lg:col-span-2">
          <DesignGallery />
        </div>
        <div className="lg:col-span-3">
          <DesignInfoPanel />
        </div>
      </div>

      {/* Tabs: SKUs, Sales History, Audit */}
      <DesignTabs />
    </div>
  );
}