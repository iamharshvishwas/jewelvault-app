'use client';
import React from 'react';
import dynamic from 'next/dynamic';
import { computeCategoryStockData, computeDailySales } from '@/lib/appStore';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';

const DailySalesChart = dynamic(() => import('./charts/DailySalesChart'), { ssr: false });
const CategoryPieChart = dynamic(() => import('./charts/CategoryPieChart'), { ssr: false });

// The daily sales are V5 day by day (the selectors, spec C14): the last seven business days, today last, a cancelled bill and dues brought forward in none. The chart draws rupees (display
// only); the figures on the cards are exact.
export default function DashboardCharts() {
  const today = useBusinessToday();
  useRowCacheVersion('bill-summary', 'designs', 'skus');
  const days = today ? computeDailySales(7) : [];
  const dailySalesData = days.map((day) => ({
    day: day.label,
    sales: day.salesPaise / 100,
    invoices: day.bills,
    today: day.date === today,
  }));
  const range = days.length > 0 ? `${days[0].label} – ${days[days.length - 1].label}` : '';
  const categoryData = today ? computeCategoryStockData() : [];
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-3 gap-4">
      {/* Daily Sales — 2/3 width */}
      <div className="lg:col-span-2 jewel-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Daily Sales — Last 7 Days</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Invoice value by day</p>
          </div>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">
            {range}
          </span>
        </div>
        <DailySalesChart data={dailySalesData} />
      </div>

      {/* Category Breakdown */}
      <div className="jewel-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Stock by Category</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Design count distribution</p>
          </div>
        </div>
        <CategoryPieChart data={categoryData} />
      </div>
    </div>
  );
}
