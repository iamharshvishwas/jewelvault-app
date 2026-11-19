'use client';
import React, { useState } from 'react';
import { reportsAccess, type ReportsAccess } from '@/lib/reportsAccess';
import { useHolder } from '@/lib/useAccess';
import ReportInventory from './ReportInventory';
import ReportSales from './ReportSales';
import ReportPayments from './ReportPayments';
import ReportJewelleryMetrics from './ReportJewelleryMetrics';

// Each tab is shown for the data it is made from (src/lib/reportsAccess.ts): the owner, who holds every tick, has the four.
const REPORT_TABS: ReadonlyArray<{ id: string; key: keyof ReportsAccess; label: string }> = [
  { id: 'rtab-inventory', key: 'inventory', label: 'Inventory' },
  { id: 'rtab-sales', key: 'sales', label: 'Sales' },
  { id: 'rtab-payments', key: 'payments', label: 'Payments' },
  { id: 'rtab-jewellery', key: 'jewellery', label: 'Jewellery Metrics' },
];

// C15, O32, QA LED-09: the date controls and the Excel, CSV and PDF buttons of this screen were the prototype's, on a fixed made-up range (1 to 22 August) and on sums of floats. They are not
// connected and not reachable in M1. The figures on the four tabs are WEB12's: the shared selectors over the derived reads (the sales and payments of this month so far, the stock as it is
// now). A report with a chosen range, and the exports with it, is a change to ask for later (the cut line of O32), not a half-working control now.
export default function ReportsClient() {
  const [chosenTab, setChosenTab] = useState('rtab-inventory');
  const access = reportsAccess(useHolder());
  const tabs = REPORT_TABS.filter((tab) => access[tab.key]);
  // a tab the person no longer has (their ticks changed while the screen was open) gives way to the first one they have
  const activeTab = tabs.some((tab) => tab.id === chosenTab) ? chosenTab : tabs[0]?.id;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Reports</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Business analytics</p>
        </div>
      </div>
      {/* Tab Bar */}
      <div className="jewel-card overflow-hidden">
        <div className="flex border-b border-border px-4 bg-muted/20 overflow-x-auto scrollbar-thin">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setChosenTab(tab.id)}
              className={`px-4 py-3 text-sm transition-colors whitespace-nowrap ${
                activeTab === tab.id ? 'tab-active' : 'tab-inactive'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-5">
          {activeTab === 'rtab-inventory' && <ReportInventory />}
          {activeTab === 'rtab-sales' && <ReportSales />}
          {activeTab === 'rtab-payments' && <ReportPayments />}
          {activeTab === 'rtab-jewellery' && <ReportJewelleryMetrics />}
        </div>
      </div>
    </div>
  );
}
