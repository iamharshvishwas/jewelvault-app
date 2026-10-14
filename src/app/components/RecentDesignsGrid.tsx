'use client';
import React from 'react';
import Link from 'next/link';
import AppImage from '@/components/ui/AppImage';
import { getDesigns } from '@/lib/designStore';
import StatusBadge from '@/components/ui/StatusBadge';

import { ArrowRight } from 'lucide-react';
import type { SkuStatus } from '@/lib/mockData';

export default function RecentDesignsGrid() {
  const recent = getDesigns().slice(0, 6);

  if (recent.length === 0) {
    return (
      <div className="jewel-card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-foreground">Recently Added Designs</h3>
          <Link href="/inventory-management" className="text-xs text-primary hover:underline flex items-center gap-1">
            View All <ArrowRight size={12} />
          </Link>
        </div>
        <div className="py-8 text-center text-muted-foreground text-sm">
          No designs yet. <Link href="/add-design" className="text-primary hover:underline">Add your first design →</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="jewel-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-foreground">Recently Added Designs</h3>
        <Link href="/inventory-management" className="text-xs text-primary hover:underline flex items-center gap-1">
          View All <ArrowRight size={12} />
        </Link>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {recent.map((design) => {
          const inStockCount = design.skus.filter((s) => s.status === 'In Stock').length;
          const displayStatus: SkuStatus = inStockCount > 0 ? 'In Stock' : (design.skus[0]?.status ?? 'Archived');
          return (
            <Link
              key={`recent-${design.id}`}
              href={`/design-detail?id=${design.id}`}
              className="group block"
            >
              <div className="aspect-square rounded-xl overflow-hidden image-placeholder mb-2">
                <AppImage
                  src={design.primaryImage}
                  alt={`${design.designNumber} — ${design.designName || design.category} jewellery design`}
                  width={160}
                  height={160}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />
              </div>
              <p className="font-mono text-xs font-bold text-primary truncate">{design.designNumber}</p>
              <p className="text-xs text-muted-foreground truncate">{design.category}</p>
              <StatusBadge status={displayStatus} size="xs" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}