'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { getInvoices, computeMonthlySalesData } from '@/lib/appStore';
import type { Invoice } from '@/lib/mockData';

const GoldSilverAreaChart = dynamic(() => import('./charts/GoldSilverAreaChart'), { ssr: false });

export default function ReportJewelleryMetrics() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [monthlySalesData, setMonthlySalesData] = useState(computeMonthlySalesData());

  useEffect(() => {
    const refresh = () => {
      setInvoices(getInvoices());
      setMonthlySalesData(computeMonthlySalesData());
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  const soldItems = invoices.flatMap((inv) => inv.items);
  const goldItems = soldItems.filter((i) => i.material === 'Gold');
  const silverItems = soldItems.filter((i) => i.material === 'Silver');

  const goldWeightSold = goldItems.reduce((a, i) => a + i.customerNetWeight, 0);
  const silverWeightSold = silverItems.reduce((a, i) => a + i.customerNetWeight, 0);
  const goldGrossSold = goldItems.reduce((a, i) => a + i.grossWeight, 0);
  const labourCollected = soldItems.reduce((a, i) => a + i.labour, 0);
  const piroiCollected = soldItems.reduce((a, i) => a + (i.piroi ?? 0), 0);
  const totalMetalValue = soldItems.reduce((a, i) => a + i.metalAmount, 0);

  const METRICS = [
    { id: 'jm-goldnw', label: 'Gold Net Wt. Sold', value: `${goldWeightSold.toFixed(3)} g`, sub: `${goldItems.length} pieces`, color: 'bg-amber-50 text-amber-800' },
    { id: 'jm-goldgw', label: 'Gold Gross Wt. Sold', value: `${goldGrossSold.toFixed(3)} g`, sub: 'Gross weight billed', color: 'bg-amber-50 text-amber-800' },
    { id: 'jm-silvernw', label: 'Silver Net Wt. Sold', value: `${silverWeightSold.toFixed(3)} g`, sub: `${silverItems.length} pieces`, color: 'bg-slate-100 text-slate-700' },
    { id: 'jm-labour', label: 'Labour Collected', value: `₹${labourCollected.toLocaleString('en-IN')}`, sub: 'Total making charges', color: 'bg-blue-50 text-blue-800' },
    { id: 'jm-piroi', label: 'Piroi Collected', value: `₹${piroiCollected.toLocaleString('en-IN')}`, sub: 'Wastage amount', color: 'bg-purple-50 text-purple-800' },
    { id: 'jm-metalval', label: 'Total Metal Value', value: `₹${totalMetalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, sub: 'NW × Rate billed', color: 'bg-emerald-50 text-emerald-800' },
  ];

  return (
    <div className="space-y-6">
      {/* Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 xl:grid-cols-6 2xl:grid-cols-6 gap-3">
        {METRICS.map((m) => (
          <div key={m.id} className={`${m.color} rounded-xl p-4`}>
            <p className="text-xs font-semibold opacity-70 mb-1">{m.label}</p>
            <p className="text-lg font-bold font-tabular">{m.value}</p>
            <p className="text-xs opacity-60 mt-0.5">{m.sub}</p>
          </div>
        ))}
      </div>
      {/* Area Chart */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Monthly Gold vs Silver Sales Value</h3>
        {monthlySalesData.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">No sales data yet.</div>
        ) : (
          <GoldSilverAreaChart data={monthlySalesData} />
        )}
      </div>
      {/* Per-Item Detail Table */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Invoice Item Details</h3>
        {soldItems.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">No invoice items yet.</div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Invoice', 'SKU', 'Material', 'Purity', 'NW (g)', 'Rate (₹)', 'Metal Amt', 'Labour', 'Piroi (₹)', 'Item Total'].map((h, i) => (
                    <th key={`jm-th-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.flatMap((inv) =>
                  inv.items.map((item) => (
                    <tr key={`jm-item-${inv.id}-${item.id}`} className="table-row-hover">
                      <td className="px-3 py-3 font-mono text-primary font-bold">{inv.invoiceNumber}</td>
                      <td className="px-3 py-3 font-mono text-foreground">{item.skuNumber}</td>
                      <td className="px-3 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${item.material === 'Gold' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700'}`}>
                          {item.material}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{item.purity}</td>
                      <td className="px-3 py-3 font-tabular text-foreground">{item.customerNetWeight.toFixed(3)}</td>
                      <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">₹{item.metalRate.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">₹{item.metalAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">₹{item.labour.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3 font-tabular text-muted-foreground">₹{item.piroi > 0 ? item.piroi.toLocaleString('en-IN') : '—'}</td>
                      <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">₹{item.itemTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}