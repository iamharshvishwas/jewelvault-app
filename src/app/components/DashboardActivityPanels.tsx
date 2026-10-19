'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  computeRecentActivity,
  computePendingPayments,
  computeOutstanding,
  computeApprovalDue,
  computeAgeingStock,
} from '@/lib/appStore';
import { paiseShown, rupeesShown } from '@/lib/ledgerView';
import {
  ShoppingCart,
  CreditCard,
  Package,
  Clock,
  AlertTriangle,
  ArrowRight,
  Timer,
} from 'lucide-react';

function ActivityIcon({ type }: { type: string }) {
  if (type === 'sale') return <ShoppingCart size={14} className="text-emerald-600" />;
  if (type === 'payment') return <CreditCard size={14} className="text-blue-600" />;
  if (type === 'stock') return <Package size={14} className="text-amber-600" />;
  if (type === 'approval') return <Clock size={14} className="text-purple-600" />;
  return <Package size={14} className="text-muted-foreground" />;
}

export default function DashboardActivityPanels() {
  const [recentActivity, setRecentActivity] = useState(computeRecentActivity());
  const [pendingPayments, setPendingPayments] = useState(computePendingPayments());
  const [owed, setOwed] = useState(computeOutstanding());
  const [approvalDue, setApprovalDue] = useState(computeApprovalDue());
  const [ageingStock, setAgeingStock] = useState(computeAgeingStock());

  useEffect(() => {
    const interval = setInterval(() => {
      setRecentActivity(computeRecentActivity());
      setPendingPayments(computePendingPayments());
      setOwed(computeOutstanding());
      setApprovalDue(computeApprovalDue());
      setAgeingStock(computeAgeingStock());
    }, 1500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-4 gap-4">
      {/* Recent Activity */}
      <div className="jewel-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Recent Activity</h3>
          <Link
            href="/reports"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            All <ArrowRight size={11} />
          </Link>
        </div>
        {recentActivity.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No activity yet</p>
        ) : (
          <div className="space-y-3">
            {recentActivity.map((item) => (
              <div key={item.id} className="flex items-start gap-2.5">
                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center flex-shrink-0 mt-0.5">
                  <ActivityIcon type={item.type} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-foreground leading-tight">{item.description}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{item.time}</p>
                </div>
                {item.amount > 0 && (
                  <span className="text-xs font-semibold text-foreground font-tabular flex-shrink-0">
                    {rupeesShown(item.amount)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Pending Payments */}
      <div className="jewel-card p-4 border-t-2 border-t-amber-400">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Pending Payments</h3>
          <Link
            href="/customer-ledger"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            View All <ArrowRight size={11} />
          </Link>
        </div>
        {pendingPayments.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No pending payments</p>
        ) : (
          <div className="space-y-3">
            {pendingPayments.map((p) => (
              <div
                key={p.id}
                data-testid="pending-row"
                className="flex items-center justify-between p-2.5 bg-amber-50 rounded-lg border border-amber-100"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground truncate">{p.customerName}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.invoiceNumber} · {p.daysOld}d old
                  </p>
                </div>
                <span
                  data-testid="pending-amount"
                  className="text-sm font-bold text-amber-700 font-tabular ml-2"
                >
                  {paiseShown(p.amountPaise)}
                </span>
              </div>
            ))}
            <div className="pt-1 border-t border-border flex justify-between items-center">
              <span className="text-xs text-muted-foreground">Total outstanding</span>
              {/* the customers' outstanding (V2): the same figure as the Outstanding tile, the evening check and the Payments report */}
              <span
                data-testid="pending-total"
                className="text-sm font-bold text-amber-700 font-tabular"
              >
                {paiseShown(owed.outstandingPaise)}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Approval Due */}
      <div className="jewel-card p-4 border-t-2 border-t-purple-400">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Approval Due</h3>
          <span className="text-xs bg-purple-100 text-purple-700 font-semibold px-2 py-0.5 rounded-full">
            {approvalDue.length} item{approvalDue.length !== 1 ? 's' : ''}
          </span>
        </div>
        {approvalDue.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No approvals pending</p>
        ) : (
          <div className="space-y-3">
            {approvalDue.map((a) => (
              <div key={a.id} className="p-2.5 bg-purple-50 rounded-lg border border-purple-100">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold text-foreground font-mono">{a.skuNumber}</span>
                  <span
                    className={`text-xs font-semibold flex items-center gap-1 ${a.overdueDays > 0 ? 'text-red-600' : 'text-purple-600'}`}
                  >
                    <Timer size={11} />
                    {a.overdueDays > 0 ? `${a.overdueDays}d overdue` : `Due ${a.expectedReturn}`}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{a.customerName}</p>
                <p className="text-xs text-muted-foreground">Issued: {a.issuedDate}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Ageing Stock Alerts */}
      <div className="jewel-card p-4 border-t-2 border-t-red-400">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Old Stock Alerts</h3>
          <Link
            href="/reports"
            className="text-xs text-primary hover:underline flex items-center gap-1"
          >
            Report <ArrowRight size={11} />
          </Link>
        </div>
        {ageingStock.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No ageing stock</p>
        ) : (
          <div className="space-y-3">
            {ageingStock.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-2.5 p-2.5 bg-red-50 rounded-lg border border-red-100"
              >
                <div className="w-6 h-6 rounded-full bg-red-100 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={12} className="text-red-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-foreground font-mono">{a.designNumber}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.category} · {a.grossWeight}g
                  </p>
                </div>
                <span className="text-xs font-bold text-red-600 flex-shrink-0">{a.days}d</span>
              </div>
            ))}
            <p className="text-xs text-muted-foreground text-center pt-1">
              {ageingStock.length} items &gt;90 days unsold
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
