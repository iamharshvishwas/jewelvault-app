'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { computeDashboardStats } from '@/lib/appStore';
import {
  Gem,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Clock,
  IndianRupee,
  BarChart3,
} from 'lucide-react';
import type { AuthRole } from '@/lib/authStore';
import { billsShown, cancelledShown, paiseShown } from '@/lib/ledgerView';

// The sales, the cancelled line and the outstanding are the selectors' figures over V1 and V2 (spec C14, V5; src/lib/selectors.ts through computeDashboardStats), written in whole paise the
// way the customer card writes them (src/lib/ledgerView.ts): ₹12,900, not ₹12.9K. A cancelled bill is on a line of its own and is not in the sales.

function fmtWt(n: number) {
  return `${n.toFixed(3)} g`;
}

export default function DashboardKpiGrid({ role = 'owner' }: { role?: AuthRole }) {
  const [s, setS] = useState(computeDashboardStats());

  useEffect(() => {
    const interval = setInterval(() => setS(computeDashboardStats()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4 gap-4">
        {/* HERO: Today's Sales */}
        {role === 'owner' && (
          <Link
            href="/reports"
            className="xl:col-span-2 jewel-card kpi-hero p-5 cursor-pointer hover:shadow-jewel-lg transition-shadow fade-in"
          >
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-white/60 mb-1">
                  Today&apos;s Sales
                </p>
                <p
                  data-testid="kpi-today-sales"
                  className="text-4xl font-bold text-white font-tabular"
                >
                  {paiseShown(s.todaySalesPaise)}
                </p>
                <p
                  data-testid="kpi-today-bills"
                  className="text-xs text-white/60 mt-0.5 font-tabular"
                >
                  {billsShown(s.todayBills)}
                </p>
                <p className="text-sm text-white/70 mt-1 font-tabular">
                  <span data-testid="kpi-month-sales">{paiseShown(s.monthSalesPaise)}</span> this
                  month
                </p>
                <p
                  data-testid="kpi-cancelled-today"
                  className="text-xs text-white/60 mt-0.5 font-tabular"
                >
                  {cancelledShown('Cancelled today', s.cancelledToday)}
                </p>
              </div>
              <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center">
                <IndianRupee size={22} className="text-white" />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <TrendingUp size={14} className="text-emerald-400" />
              <span className="text-xs text-emerald-400 font-semibold">Live from invoices</span>
              <span className="text-xs text-white/40 ml-auto">
                {s.todaySalesPaise > 0 ? 'Active today' : 'No sales yet today'}
              </span>
            </div>
          </Link>
        )}

        {/* Total Outstanding */}
        {role === 'owner' && (
          <Link
            href="/customer-ledger"
            className="jewel-card p-4 border-l-4 border-l-amber-500 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
          >
            <div className="flex items-start justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Outstanding
              </p>
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                <AlertTriangle size={15} className="text-amber-600" />
              </div>
            </div>
            <p
              data-testid="kpi-outstanding"
              className="text-2xl font-bold text-amber-700 font-tabular"
            >
              {paiseShown(s.totalOutstandingPaise)}
            </p>
            <p className="text-xs text-muted-foreground mt-1">Across all customers</p>
          </Link>
        )}

        {/* On Approval */}
        {role === 'owner' && (
          <Link
            href="/billing-pos"
            className="jewel-card p-4 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
          >
            <div className="flex items-start justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                On Approval
              </p>
              <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center">
                <Clock size={15} className="text-purple-600" />
              </div>
            </div>
            <p className="text-2xl font-bold text-purple-700 font-tabular">{s.onApproval}</p>
            <p className="text-xs text-muted-foreground mt-1">Items out for approval</p>
          </Link>
        )}

        {/* Total Designs */}
        <Link
          href="/inventory-management"
          className="jewel-card p-4 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
        >
          <div className="flex items-start justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Total Designs
            </p>
            <div className="w-8 h-8 rounded-lg bg-gold-subtle flex items-center justify-center">
              <Gem size={15} className="text-primary" />
            </div>
          </div>
          <p className="text-2xl font-bold text-foreground font-tabular">{s.totalDesigns}</p>
          <p className="text-xs text-muted-foreground mt-1">{s.totalSkus} physical SKUs</p>
        </Link>

        {/* In Stock */}
        <Link
          href="/inventory-management"
          className="jewel-card p-4 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
        >
          <div className="flex items-start justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              In Stock
            </p>
            <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
              <CheckCircle size={15} className="text-emerald-600" />
            </div>
          </div>
          <p className="text-2xl font-bold text-emerald-700 font-tabular">{s.inStock}</p>
          <div className="flex gap-2 mt-1">
            <span className="text-xs text-muted-foreground">{s.reserved} reserved</span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">{s.sold} sold</span>
          </div>
        </Link>

        {/* Gold Stock */}
        <Link
          href="/inventory-management"
          className="jewel-card p-4 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
        >
          <div className="flex items-start justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Gold Stock
            </p>
            <div className="w-8 h-8 rounded-xl bg-amber-50 flex items-center justify-center">
              <span className="text-base">🥇</span>
            </div>
          </div>
          <p className="text-2xl font-bold text-amber-700 font-tabular">
            {fmtWt(s.goldStockWeight)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{s.goldStockCount} pieces in stock</p>
        </Link>

        {/* Silver Stock */}
        <Link
          href="/inventory-management"
          className="jewel-card p-4 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
        >
          <div className="flex items-start justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Silver Stock
            </p>
            <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center">
              <span className="text-base">🥈</span>
            </div>
          </div>
          <p className="text-2xl font-bold text-slate-700 font-tabular">
            {fmtWt(s.silverStockWeight)}
          </p>
          <p className="text-xs text-muted-foreground mt-1">{s.silverStockCount} pieces in stock</p>
        </Link>

        {/* Ageing 90+ days */}
        <Link
          href={role === 'owner' ? '/reports' : '/inventory-management'}
          className="jewel-card p-4 border-l-4 border-l-red-400 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
        >
          <div className="flex items-start justify-between mb-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Ageing 90+ Days
            </p>
            <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center">
              <TrendingDown size={15} className="text-red-500" />
            </div>
          </div>
          <p className="text-2xl font-bold text-red-600 font-tabular">{s.ageingOver90}</p>
          <p className="text-xs text-red-500 font-medium mt-1">Capital locked — review needed</p>
        </Link>

        {/* Month Sales */}
        {role === 'owner' && (
          <Link
            href="/reports"
            className="jewel-card p-4 cursor-pointer hover:shadow-jewel-md transition-shadow fade-in"
          >
            <div className="flex items-start justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Month Sales
              </p>
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                <BarChart3 size={15} className="text-blue-600" />
              </div>
            </div>
            <p
              data-testid="kpi-month-tile"
              className="text-2xl font-bold text-foreground font-tabular"
            >
              {paiseShown(s.monthSalesPaise)}
            </p>
            <div className="flex items-center gap-1 mt-1">
              <TrendingUp size={12} className="text-emerald-500" />
              <span className="text-xs text-emerald-600 font-semibold">Current month total</span>
            </div>
            <p data-testid="kpi-cancelled-month" className="text-xs text-muted-foreground mt-1">
              {cancelledShown('Cancelled this month', s.cancelledMonth)}
            </p>
          </Link>
        )}
      </div>
    </div>
  );
}
