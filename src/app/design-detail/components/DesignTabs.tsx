'use client';
import React, { useState } from 'react';
import DesignSkuTable from './DesignSkuTable';
import DesignSalesHistory from './DesignSalesHistory';
import DesignAuditLog from './DesignAuditLog';

const TABS = [
  { id: 'tab-skus', label: 'SKUs & Stock' },
  { id: 'tab-sales', label: 'Sales History' },
  { id: 'tab-audit', label: 'Audit Log' },
];

export default function DesignTabs() {
  const [activeTab, setActiveTab] = useState('tab-skus');

  return (
    <div className="jewel-card overflow-hidden">
      {/* Tab Bar */}
      <div className="flex border-b border-border px-4 bg-muted/20">
        {TABS?.map((tab) => (
          <button
            key={tab?.id}
            onClick={() => setActiveTab(tab?.id)}
            className={`px-4 py-3 text-sm transition-colors ${
              activeTab === tab?.id ? 'tab-active' : 'tab-inactive'
            }`}
          >
            {tab?.label}
          </button>
        ))}
      </div>
      {/* Tab Content */}
      <div className="p-4">
        {activeTab === 'tab-skus' && <DesignSkuTable />}
        {activeTab === 'tab-sales' && <DesignSalesHistory />}
        {activeTab === 'tab-audit' && <DesignAuditLog />}
      </div>
    </div>
  );
}