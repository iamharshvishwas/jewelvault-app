'use client';
import React from 'react';
import dynamic from 'next/dynamic';
import { DAILY_SALES_DATA, CATEGORY_DATA } from '@/lib/mockData';

const DailySalesChart = dynamic(() => import('./charts/DailySalesChart'), { ssr: false });
const CategoryPieChart = dynamic(() => import('./charts/CategoryPieChart'), { ssr: false });

export default function DashboardCharts() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-3 gap-4">
      {/* Daily Sales — 2/3 width */}
      <div className="lg:col-span-2 jewel-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Daily Sales — Last 7 Days</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Invoice value by day</p>
          </div>
          <span className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">Aug 16–22</span>
        </div>
        <DailySalesChart data={DAILY_SALES_DATA} />
      </div>

      {/* Category Breakdown */}
      <div className="jewel-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-foreground">Stock by Category</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Design count distribution</p>
          </div>
        </div>
        <CategoryPieChart data={CATEGORY_DATA} />
      </div>
    </div>
  );
}