'use client';
import React, { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { getDesigns } from '@/lib/designStore';
import { computeCategoryStockData, computeAgeingStock } from '@/lib/appStore';
import { Package, AlertTriangle, Layers } from 'lucide-react';

const AgeingBarChart = dynamic(() => import('./charts/AgeingBarChart'), { ssr: false });
const CategoryStockBar = dynamic(() => import('./charts/CategoryStockBar'), { ssr: false });

export default function ReportInventory() {
  const [designs, setDesigns] = useState(getDesigns());
  const [categoryData, setCategoryData] = useState(computeCategoryStockData());
  const [ageingData, setAgeingData] = useState(computeAgeingStock());

  useEffect(() => {
    const refresh = () => {
      setDesigns(getDesigns());
      setCategoryData(computeCategoryStockData());
      setAgeingData(computeAgeingStock());
    };
    refresh();
    const interval = setInterval(refresh, 1500);
    return () => clearInterval(interval);
  }, []);

  const allSkus = designs?.flatMap((d) => d?.skus);
  const totalSkus = allSkus?.length;
  const inStockSkus = allSkus?.filter((s) => s?.status === 'In Stock')?.length;

  // Convert ageing stock to chart format
  const ageingChartData = [
    { bucket: '0–30 days', count: allSkus?.filter((s) => { const days = (Date.now() - new Date(s.createdAt)?.getTime()) / 86400000; return days <= 30 && s?.status === 'In Stock'; })?.length, weight: 0 },
    { bucket: '31–60 days', count: allSkus?.filter((s) => { const days = (Date.now() - new Date(s.createdAt)?.getTime()) / 86400000; return days > 30 && days <= 60 && s?.status === 'In Stock'; })?.length, weight: 0 },
    { bucket: '61–90 days', count: allSkus?.filter((s) => { const days = (Date.now() - new Date(s.createdAt)?.getTime()) / 86400000; return days > 60 && days <= 90 && s?.status === 'In Stock'; })?.length, weight: 0 },
    { bucket: '90+ days', count: ageingData?.length, weight: ageingData?.reduce((a, s) => a + s?.grossWeight, 0) },
  ];

  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { id: 'ri-designs', label: 'Total Designs', value: designs?.length, icon: <Layers size={16} className="text-primary" />, bg: 'bg-gold-subtle' },
          { id: 'ri-skus', label: 'Total SKUs', value: totalSkus, icon: <Package size={16} className="text-blue-600" />, bg: 'bg-blue-50' },
          { id: 'ri-instock', label: 'In Stock', value: inStockSkus, icon: <Package size={16} className="text-emerald-600" />, bg: 'bg-emerald-50' },
          { id: 'ri-ageing', label: 'Ageing 90+ Days', value: ageingData?.length, icon: <AlertTriangle size={16} className="text-red-500" />, bg: 'bg-red-50' },
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
          <h3 className="text-sm font-semibold text-foreground mb-3">Stock by Category</h3>
          <CategoryStockBar data={categoryData} />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground mb-3">Ageing Distribution</h3>
          <AgeingBarChart data={ageingChartData} />
        </div>
      </div>
      {/* Stock Table */}
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-3">Design-wise Stock Summary</h3>
        {designs?.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground text-sm">No designs in inventory yet.</div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Design No.', 'Name', 'Category', 'Material', 'Purity', 'Total SKUs', 'In Stock', 'Sold', 'Reserved', 'Total GW (g)']?.map((h, i) => (
                    <th key={`ri-th-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {designs?.map((design) => {
                  const inStock = design?.skus?.filter((s) => s?.status === 'In Stock')?.length;
                  const sold = design?.skus?.filter((s) => s?.status === 'Sold')?.length;
                  const reserved = design?.skus?.filter((s) => s?.status === 'Reserved')?.length;
                  const totalGW = design?.skus?.reduce((a, s) => a + s?.grossWeight, 0);
                  return (
                    <tr key={`ri-row-${design?.id}`} className="table-row-hover">
                      <td className="px-3 py-3 font-mono font-bold text-foreground">{design?.designNumber}</td>
                      <td className="px-3 py-3 text-foreground max-w-32 truncate">{design?.designName || '—'}</td>
                      <td className="px-3 py-3 text-muted-foreground">{design?.category}</td>
                      <td className="px-3 py-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${design?.material === 'Gold' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-700'}`}>
                          {design?.material}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{design?.purity}</td>
                      <td className="px-3 py-3 font-tabular font-semibold text-foreground">{design?.skus?.length}</td>
                      <td className="px-3 py-3 font-tabular text-emerald-600 font-semibold">{inStock}</td>
                      <td className="px-3 py-3 font-tabular text-red-600 font-semibold">{sold}</td>
                      <td className="px-3 py-3 font-tabular text-amber-600 font-semibold">{reserved}</td>
                      <td className="px-3 py-3 font-tabular text-foreground">{totalGW?.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}