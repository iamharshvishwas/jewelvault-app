import React from 'react';
import type { Material } from '@/lib/mockData';

interface MaterialBadgeProps {
  material: Material;
  purity?: string;
  size?: 'xs' | 'sm' | 'md';
}

export default function MaterialBadge({ material, purity, size = 'sm' }: MaterialBadgeProps) {
  const isGold = material === 'Gold';
  return (
    <span
      className={`
        inline-flex items-center gap-1 font-semibold rounded-full
        ${size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : 'text-xs px-2 py-0.5'}
        ${isGold
          ? 'bg-amber-50 text-amber-800 border border-amber-200' :'bg-slate-100 text-slate-700 border border-slate-200'
        }
      `}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${isGold ? 'bg-amber-500' : 'bg-slate-500'}`} />
      {purity ? `${purity} ${material}` : material}
    </span>
  );
}
