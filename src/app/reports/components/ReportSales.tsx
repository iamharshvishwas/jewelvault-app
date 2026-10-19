'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { computeSalesReport } from '@/lib/appStore';
import { billsShown, cancelledShown, paiseShown, perUnitShown } from '@/lib/ledgerView';
import { shareOfTotal } from '@/lib/selectors';
import { TrendingUp, ShoppingCart, Ban } from 'lucide-react';

const MonthlySalesChart = dynamic(() => import('./charts/MonthlySalesChart'), { ssr: false });
const CategorySalesChart = dynamic(() => import('./charts/CategorySalesChart'), { ssr: false });

// The Sales report (spec C14, V5): the figures are the selectors' over V1 and the lines of the bills (src/lib/selectors.ts through computeSalesReport), so the sales of the month are the
// same figure as on the dashboard. Sales are the bills that are active and not opening-balance bills; a cancelled bill is on a line of its own and is not a sale. The metal and category
// split is made from the lines of those bills; what the lines add up to is not the sales figure (the discount, other charges and round-off belong to the bill), so the table shows the
// difference as a row of its own and its total is the sales figure.

const MONTH_LABEL = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

export default function ReportSales() {
  const [report, setReport] = useState(computeSalesReport());

  useEffect(() => {
    const refresh = () => setReport(computeSalesReport());
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  const metal = (name: string) => report.metals.find((m) => m.key === name)?.totalPaise ?? 0;
  const units = report.categories.reduce((sum, row) => sum + row.units, 0);
  const monthlySalesData = report.monthly.map((row) => ({
    month: new Date(`${row.month}-15T12:00:00Z`).toLocaleString('en-IN', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    }),
    // the charts draw rupees (display only); the table below is exact
    goldSales: row.goldPaise / 100,
    silverSales: row.silverPaise / 100,
  }));
  const categorySalesData = report.categories.map((row) => ({
    category: row.key,
    count: row.units,
    value: row.totalPaise / 100,
  }));
  const share = (paise: number) => shareOfTotal(paise, report.sales.totalPaise);

  return (
    <div className="space-y-6">
      <p data-testid="rs-period" className="text-xs text-muted-foreground">
        {MONTH_LABEL(report.month)}, so far. Cancelled bills and dues brought forward are not sales.
      </p>
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          {
            id: 'rs-total',
            label: 'Total Sales Value',
            value: paiseShown(report.sales.totalPaise),
            icon: <TrendingUp size={16} className="text-emerald-600" />,
            bg: 'bg-emerald-50',
          },
          {
            id: 'rs-invoices',
            label: 'Total Invoices',
            value: String(report.sales.count),
            icon: <ShoppingCart size={16} className="text-blue-600" />,
            bg: 'bg-blue-50',
          },
          {
            id: 'rs-cancelled',
            label: 'Cancelled Bills',
            value:
              report.cancelled.count === 0
                ? 'none'
                : `${billsShown(report.cancelled.count)} · ${paiseShown(report.cancelled.totalPaise)}`,
            icon: <Ban size={16} className="text-red-500" />,
            bg: 'bg-red-50',
          },
          {
            id: 'rs-gold',
            label: 'Gold Sales',
            value: paiseShown(metal('Gold')),
            icon: <span className="text-base">🥇</span>,
            bg: 'bg-amber-50',
          },
          {
            id: 'rs-silver',
            label: 'Silver Sales',
            value: paiseShown(metal('Silver')),
            icon: <span className="text-base">🥈</span>,
            bg: 'bg-slate-50',
          },
        ].map((card) => (
          <div key={card.id} className={`${card.bg} rounded-xl p-4 flex items-center gap-3`}>
            {card.icon}
            <div>
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p data-testid={card.id} className="text-xl font-bold text-foreground font-tabular">
                {card.value}
              </p>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground -mt-3">
        Gold and silver are the lines of the bills, before the discount, other charges and round-off
        of each bill. {cancelledShown('Cancelled this month', report.cancelled)}.
      </p>
      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">
            Monthly Sales Trend (Gold vs Silver)
          </h3>
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
        {report.sales.count === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">
            No sales recorded this month yet.
          </div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Category', 'Units Sold', 'Sales Value', '% of Total', 'Avg per Unit'].map(
                    (h, i) => (
                      <th
                        key={`rs-th-${i}`}
                        className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                      >
                        {h}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.categories.map((row) => (
                  <tr
                    key={`rs-row-${row.key}`}
                    data-testid="rs-cat-row"
                    className="table-row-hover"
                  >
                    <td className="px-3 py-3 font-semibold text-foreground">{row.key}</td>
                    <td className="px-3 py-3 font-tabular text-foreground">{row.units}</td>
                    <td className="px-3 py-3 font-tabular font-semibold text-foreground whitespace-nowrap">
                      {paiseShown(row.totalPaise)}
                    </td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground">
                      {share(row.totalPaise) ?? '0.0'}%
                      <div className="w-full bg-muted rounded-full h-1 mt-1">
                        <div
                          className="bg-primary h-1 rounded-full"
                          style={{ width: `${Math.max(0, Number(share(row.totalPaise) ?? 0))}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground whitespace-nowrap">
                      {perUnitShown(row.totalPaise, row.units)}
                    </td>
                  </tr>
                ))}
                <tr data-testid="rs-adjustment-row" className="table-row-hover">
                  <td className="px-3 py-3 text-muted-foreground">
                    Discount, other charges and round-off of the bills
                  </td>
                  <td className="px-3 py-3 font-tabular text-muted-foreground">-</td>
                  <td className="px-3 py-3 font-tabular font-semibold text-foreground whitespace-nowrap">
                    {paiseShown(report.adjustmentPaise)}
                  </td>
                  <td className="px-3 py-3 font-tabular text-muted-foreground">
                    {share(report.adjustmentPaise) ?? '0.0'}%
                  </td>
                  <td className="px-3 py-3 font-tabular text-muted-foreground">-</td>
                </tr>
              </tbody>
              <tfoot>
                <tr data-testid="rs-total-row" className="bg-muted/40 border-t-2 border-border">
                  <td className="px-3 py-2.5 font-bold text-foreground">Total</td>
                  <td className="px-3 py-2.5 font-tabular font-bold text-foreground">{units}</td>
                  <td className="px-3 py-2.5 font-tabular font-bold text-foreground whitespace-nowrap">
                    {paiseShown(report.sales.totalPaise)}
                  </td>
                  <td className="px-3 py-2.5 font-tabular text-muted-foreground">100%</td>
                  <td className="px-3 py-2.5 font-tabular text-muted-foreground">-</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
