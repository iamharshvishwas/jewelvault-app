'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  computePaymentsReport,
  paymentsPeriod,
  reloadDailyTotals,
  watchDailyTotals,
} from '@/lib/appStore';
import { paiseShown } from '@/lib/ledgerView';
import { dayLabel } from '@/lib/rateGuard';
import { CreditCard, AlertTriangle, CheckCircle, TrendingDown } from 'lucide-react';

const PaymentModePie = dynamic(() => import('./charts/PaymentModePie'), { ssr: false });

// The Payments report (spec C14, V4, V2): what was collected is the cash book (V4: money in less money out, a refund and a void included, opening advances left out), what is owed is
// the customers' outstanding (V2) and the list is the bills with money pending (V1), all through the selectors (src/lib/selectors.ts, computePaymentsReport), so the figures are the
// evening check's and the customer cards' on the same data. The period is this month so far. A cash book that cannot be read shows a dash and says so, never a zero.

const COLORS: Record<string, string> = {
  Cash: '#22c55e',
  UPI: '#3b82f6',
  Card: '#8b5cf6',
  'Bank Transfer': '#f59e0b',
  Other: '#94a3b8',
};

export default function ReportPayments() {
  const [period, setPeriod] = useState(paymentsPeriod());
  const [report, setReport] = useState(computePaymentsReport(period));

  useEffect(() => {
    const refresh = () => {
      const now = paymentsPeriod();
      setPeriod((before) => (before.from === now.from && before.to === now.to ? before : now));
      setReport(computePaymentsReport(now));
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  // the cash book of the period is read when this report is on the screen, and again when a receipt arrives
  useEffect(() => watchDailyTotals(period.from, period.to), [period.from, period.to]);

  const money = (paise: number) => (report.shown ? paiseShown(paise) : '—');
  const upiShare = report.shown ? report.shares['UPI'] : null;
  const activeModes = report.modes.filter(
    (m) => m.moneyInPaise !== 0 || m.moneyOutPaise !== 0 || m.netPaise !== 0
  );
  const paymentModeData = report.modes
    .filter((m) => m.netPaise > 0)
    .map((m) => ({
      mode: m.mode,
      value: Number(report.shares[m.mode] ?? 0),
      amount: m.netPaise / 100,
      fill: COLORS[m.mode] || '#94a3b8',
    }));

  return (
    <div className="space-y-6">
      <p data-testid="rp-period" className="text-xs text-muted-foreground">
        Collected from {dayLabel(report.from)} to {dayLabel(report.to)} (this month so far).
        Outstanding is as of now.
      </p>
      {report.state === 'failed' && (
        <p
          role="alert"
          data-testid="rp-error"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span>{report.message ?? 'The cash book could not be loaded.'}</span>
          <button
            type="button"
            data-testid="rp-retry"
            className="btn-secondary py-1 text-xs"
            onClick={() => void reloadDailyTotals(report.from, report.to)}
          >
            Try again
          </button>
        </p>
      )}
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            id: 'rp-collected',
            label: 'Total Collected',
            value: money(report.collectedPaise),
            icon: <CheckCircle size={16} className="text-emerald-600" />,
            bg: 'bg-emerald-50',
          },
          {
            id: 'rp-outstanding',
            label: 'Total Outstanding',
            value: paiseShown(report.outstandingPaise),
            icon: <AlertTriangle size={16} className="text-amber-600" />,
            bg: 'bg-amber-50',
          },
          {
            id: 'rp-customers',
            label: 'Customers with Dues',
            value: String(report.customersWithDues),
            icon: <TrendingDown size={16} className="text-red-500" />,
            bg: 'bg-red-50',
          },
          {
            id: 'rp-upi',
            label: 'UPI Share',
            value: upiShare === null ? '—' : `${upiShare}%`,
            icon: <CreditCard size={16} className="text-blue-600" />,
            bg: 'bg-blue-50',
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Payment Mode Pie */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Payment Mode Breakdown</h3>
          {paymentModeData.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              No payment data yet.
            </div>
          ) : (
            <PaymentModePie data={paymentModeData} />
          )}
        </div>

        {/* Payment Mode Table */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Mode-wise Summary</h3>
          {activeModes.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              No payments recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60 border-b border-border">
                    {['Payment Mode', 'Money In', 'Money Out', 'Net', '% of Net'].map((h, i) => (
                      <th
                        key={`rp-th-${i}`}
                        className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {activeModes.map((row) => (
                    <tr
                      key={`rp-mode-${row.mode}`}
                      data-testid="rp-mode-row"
                      className="table-row-hover"
                    >
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                            style={{ background: COLORS[row.mode] || '#94a3b8' }}
                          />
                          <span className="font-semibold text-foreground">{row.mode}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">
                        {paiseShown(row.moneyInPaise)}
                      </td>
                      <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">
                        {paiseShown(row.moneyOutPaise)}
                      </td>
                      <td className="px-3 py-3 font-tabular font-semibold text-foreground whitespace-nowrap">
                        {paiseShown(row.netPaise)}
                      </td>
                      <td className="px-3 py-3 font-tabular text-muted-foreground">
                        {report.shares[row.mode] ?? '0.0'}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      {/* Outstanding List */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Outstanding Payments</h3>
        {report.pending.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            No outstanding payments — all clear!
          </div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Customer', 'Mobile', 'Invoice', 'Amount Due', 'Days Pending'].map((h, i) => (
                    <th
                      key={`rp-oth-${i}`}
                      className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {report.pending.map((p) => (
                  <tr key={`rp-out-${p.id}`} data-testid="rp-out-row" className="table-row-hover">
                    <td className="px-3 py-3 font-semibold text-foreground">{p.customerName}</td>
                    <td className="px-3 py-3 font-mono text-muted-foreground">{p.mobile}</td>
                    <td className="px-3 py-3 font-mono text-primary">{p.invoiceNumber}</td>
                    <td className="px-3 py-3 font-tabular font-bold text-amber-700 whitespace-nowrap">
                      {paiseShown(p.amountPaise)}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          p.daysOld > 30
                            ? 'bg-red-100 text-red-700'
                            : p.daysOld > 14
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-muted text-muted-foreground'
                        }`}
                      >
                        {p.daysOld} days
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40 border-t-2 border-border">
                  <td className="px-3 py-2.5 font-bold text-foreground" colSpan={3}>
                    Total
                  </td>
                  <td
                    data-testid="rp-list-total"
                    className="px-3 py-2.5 font-tabular font-bold text-amber-700 whitespace-nowrap"
                  >
                    {paiseShown(report.pendingTotalPaise)}
                  </td>
                  <td className="px-3 py-2.5" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
