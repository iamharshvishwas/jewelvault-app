'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { computeMonthlySalesData, computeCategorySalesData } from '@/lib/appStore';
import { TrendingUp, ShoppingCart } from 'lucide-react';

const MonthlySalesChart = dynamic(() => import('./charts/MonthlySalesChart'), { ssr: false });
const CategorySalesChart = dynamic(() => import('./charts/CategorySalesChart'), { ssr: false });

export default function ReportSales() {
  const [monthlySalesData, setMonthlySalesData] = useState(computeMonthlySalesData());
  const [categorySalesData, setCategorySalesData] = useState(computeCategorySalesData());

  useEffect(() => {
    const refresh = () => {
      setMonthlySalesData(computeMonthlySalesData());
      setCategorySalesData(computeCategorySalesData());
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  const totalSalesValue = categorySalesData?.reduce((a, c) => a + c?.value, 0);
  const totalInvoices = categorySalesData?.reduce((a, c) => a + c?.count, 0);
  const goldSales = monthlySalesData?.reduce((a, m) => a + m?.goldSales, 0);
  const silverSales = monthlySalesData?.reduce((a, m) => a + m?.silverSales, 0);

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { id: 'rs-total', label: 'Total Sales Value', value: totalSalesValue >= 100000 ? `₹${(totalSalesValue / 100000)?.toFixed(2)}L` : `₹${totalSalesValue?.toLocaleString('en-IN')}`, icon: <TrendingUp size={16} className="text-emerald-600" />, bg: 'bg-emerald-50' },
          { id: 'rs-invoices', label: 'Total Invoices', value: totalInvoices, icon: <ShoppingCart size={16} className="text-blue-600" />, bg: 'bg-blue-50' },
          { id: 'rs-gold', label: 'Gold Sales', value: goldSales >= 100000 ? `₹${(goldSales / 100000)?.toFixed(2)}L` : `₹${goldSales?.toLocaleString('en-IN')}`, icon: <span className="text-base">🥇</span>, bg: 'bg-amber-50' },
          { id: 'rs-silver', label: 'Silver Sales', value: silverSales >= 1000 ? `₹${(silverSales / 1000)?.toFixed(0)}K` : `₹${silverSales?.toLocaleString('en-IN')}`, icon: <span className="text-base">🥈</span>, bg: 'bg-slate-50' },
        ]?.map((card) => (
          <div key={card?.id} className={`${card?.bg} rounded-xl p-4 flex items-center gap-3`}>
            {card?.icon}
            <div>
              <p className="text-xs text-muted-foreground">{card?.label}</p>
              <p className="text-xl font-bold text-foreground font-tabular">{card?.value}</p>
            </div>
          </div>
        ))}
      </div>
      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Monthly Sales Trend (Gold vs Silver)</h3>
          <MonthlySalesChart data={monthlySalesData} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Sales by Category</h3>
          <CategorySalesChart data={categorySalesData} />
        </div>
      </div>
      {/* Category Table */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Category-wise Sales Summary</h3>
        {categorySalesData?.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">No sales recorded yet.</div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Category', 'Units Sold', 'Sales Value', '% of Total', 'Avg per Unit']?.map((h, i) => (
                    <th key={`rs-th-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {categorySalesData?.map((row) => (
                  <tr key={`rs-row-${row?.category}`} className="table-row-hover">
                    <td className="px-3 py-3 font-semibold text-foreground">{row?.category}</td>
                    <td className="px-3 py-3 font-tabular text-foreground">{row?.count}</td>
                    <td className="px-3 py-3 font-tabular font-semibold text-foreground whitespace-nowrap">
                      ₹{row?.value?.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground">
                      {totalSalesValue > 0 ? ((row?.value / totalSalesValue) * 100)?.toFixed(1) : '0.0'}%
                      <div className="w-full bg-muted rounded-full h-1 mt-1">
                        <div
                          className="bg-primary h-1 rounded-full"
                          style={{ width: totalSalesValue > 0 ? `${(row?.value / totalSalesValue) * 100}%` : '0%' }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground whitespace-nowrap">
                      ₹{row?.count > 0 ? Math.round(row?.value / row?.count)?.toLocaleString('en-IN') : '0'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40 border-t-2 border-border">
                  <td className="px-3 py-2.5 font-bold text-foreground">Total</td>
                  <td className="px-3 py-2.5 font-tabular font-bold text-foreground">{totalInvoices}</td>
                  <td className="px-3 py-2.5 font-tabular font-bold text-foreground whitespace-nowrap">
                    ₹{totalSalesValue?.toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2.5 font-tabular text-muted-foreground">100%</td>
                  <td className="px-3 py-2.5 font-tabular text-muted-foreground whitespace-nowrap">
                    ₹{totalInvoices > 0 ? Math.round(totalSalesValue / totalInvoices)?.toLocaleString('en-IN') : '0'}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}