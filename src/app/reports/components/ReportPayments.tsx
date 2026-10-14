'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { computePaymentModeData, computePendingPayments } from '@/lib/appStore';
import { CreditCard, AlertTriangle, CheckCircle, TrendingDown } from 'lucide-react';

const PaymentModePie = dynamic(() => import('./charts/PaymentModePie'), { ssr: false });

export default function ReportPayments() {
  const [paymentModeData, setPaymentModeData] = useState(computePaymentModeData());
  const [pendingPayments, setPendingPayments] = useState(computePendingPayments());

  useEffect(() => {
    const refresh = () => {
      setPaymentModeData(computePaymentModeData());
      setPendingPayments(computePendingPayments());
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  const totalCollected = paymentModeData?.reduce((a, p) => a + p?.amount, 0);
  const totalOutstanding = pendingPayments?.reduce((a, p) => a + p?.amount, 0);
  const upiShare = paymentModeData?.find((p) => p?.mode === 'UPI')?.value ?? 0;

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { id: 'rp-collected', label: 'Total Collected', value: totalCollected >= 100000 ? `₹${(totalCollected / 100000)?.toFixed(2)}L` : `₹${totalCollected?.toLocaleString('en-IN')}`, icon: <CheckCircle size={16} className="text-emerald-600" />, bg: 'bg-emerald-50' },
          { id: 'rp-outstanding', label: 'Total Outstanding', value: `₹${totalOutstanding?.toLocaleString('en-IN')}`, icon: <AlertTriangle size={16} className="text-amber-600" />, bg: 'bg-amber-50' },
          { id: 'rp-customers', label: 'Customers with Dues', value: pendingPayments?.length, icon: <TrendingDown size={16} className="text-red-500" />, bg: 'bg-red-50' },
          { id: 'rp-upi', label: 'UPI Share', value: `${upiShare}%`, icon: <CreditCard size={16} className="text-blue-600" />, bg: 'bg-blue-50' },
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Payment Mode Pie */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Payment Mode Breakdown</h3>
          {paymentModeData?.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">No payment data yet.</div>
          ) : (
            <PaymentModePie data={paymentModeData} />
          )}
        </div>

        {/* Payment Mode Table */}
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Mode-wise Summary</h3>
          {paymentModeData?.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground text-sm">No payments recorded yet.</div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60 border-b border-border">
                    {['Payment Mode', 'Transactions %', 'Amount', '% of Total']?.map((h, i) => (
                      <th key={`rp-th-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paymentModeData?.map((row) => (
                    <tr key={`rp-mode-${row?.mode}`} className="table-row-hover">
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2">
                          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: row?.fill }} />
                          <span className="font-semibold text-foreground">{row?.mode}</span>
                        </div>
                      </td>
                      <td className="px-3 py-3 font-tabular text-muted-foreground">{row?.value}%</td>
                      <td className="px-3 py-3 font-tabular font-semibold text-foreground whitespace-nowrap">
                        ₹{row?.amount?.toLocaleString('en-IN')}
                      </td>
                      <td className="px-3 py-3 font-tabular text-muted-foreground">
                        {totalCollected > 0 ? ((row?.amount / totalCollected) * 100)?.toFixed(1) : '0.0'}%
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
        {pendingPayments?.length === 0 ? (
          <div className="text-center py-6 text-sm text-muted-foreground">No outstanding payments — all clear!</div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Customer', 'Mobile', 'Invoice', 'Amount Due', 'Days Pending']?.map((h, i) => (
                    <th key={`rp-oth-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pendingPayments?.map((p) => (
                  <tr key={`rp-out-${p?.id}`} className="table-row-hover">
                    <td className="px-3 py-3 font-semibold text-foreground">{p?.customerName}</td>
                    <td className="px-3 py-3 font-mono text-muted-foreground">{p?.mobile}</td>
                    <td className="px-3 py-3 font-mono text-primary">{p?.invoiceNumber}</td>
                    <td className="px-3 py-3 font-tabular font-bold text-amber-700 whitespace-nowrap">
                      ₹{p?.amount?.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-3">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                        p?.daysOld > 30 ? 'bg-red-100 text-red-700' :
                        p?.daysOld > 14 ? 'bg-amber-100 text-amber-700' : 'bg-muted text-muted-foreground'
                      }`}>
                        {p?.daysOld} days
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}