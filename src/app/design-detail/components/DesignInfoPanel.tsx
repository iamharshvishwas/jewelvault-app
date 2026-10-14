'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { getDesigns } from '@/lib/designStore';
import StatusBadge from '@/components/ui/StatusBadge';
import MaterialBadge from '@/components/ui/MaterialBadge';
import { Edit, Plus, Printer, Share2, Tag } from 'lucide-react';
import type { SkuStatus, Design } from '@/lib/mockData';

function useDesignFromUrl(): Design | null {
  const [design, setDesign] = useState<Design | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get('id');
    const found = getDesigns().find((d) => d.id === id) ?? getDesigns()[0] ?? null;
    setDesign(found);
  }, []);
  return design;
}

export default function DesignInfoPanel() {
  const design = useDesignFromUrl();

  if (!design) {
    return (
      <div className="jewel-card p-5 h-full flex items-center justify-center">
        <p className="text-muted-foreground text-sm">No design selected. Go back to <Link href="/inventory-management" className="text-primary hover:underline">Inventory</Link>.</p>
      </div>
    );
  }

  const inStockCount = design.skus.filter((s) => s.status === 'In Stock').length;
  const displayStatus: SkuStatus = inStockCount > 0 ? 'In Stock' : (design.skus[0]?.status ?? 'Archived');

  return (
    <div className="jewel-card p-5 h-full">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-2xl font-bold text-foreground font-mono">{design.designNumber}</span>
            <StatusBadge status={displayStatus} />
          </div>
          {design.designName && (
            <p className="text-sm text-muted-foreground">{design.designName}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost p-2" title="Share">
            <Share2 size={15} />
          </button>
          <button className="btn-secondary py-2">
            <Edit size={14} />
            <span className="hidden sm:inline">Edit</span>
          </button>
        </div>
      </div>

      {/* Tags */}
      {design.tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {design.tags.map((tag) => (
            <span key={`tag-${design.id}-${tag}`} className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* Details Grid */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        {[
          { id: 'di-cat', label: 'Category', value: design.category },
          { id: 'di-sub', label: 'Sub-category', value: design.subcategory || '—' },
          { id: 'di-sell', label: 'Selling Method', value: design.sellingMethod },
          { id: 'di-purity', label: 'Purity', value: design.purity },
        ].map((item) => (
          <div key={item.id} className="p-3 bg-muted/40 rounded-xl">
            <p className="text-xs text-muted-foreground mb-0.5">{item.label}</p>
            <p className="text-sm font-semibold text-foreground">{item.value}</p>
          </div>
        ))}
      </div>

      {/* Material */}
      <div className="flex items-center gap-2 mb-4">
        <MaterialBadge material={design.material} />
        <span className="text-sm text-muted-foreground">{design.material} · {design.purity}</span>
      </div>

      {/* Labour & Piroi */}
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="p-3 bg-muted/40 rounded-xl">
          <p className="text-xs text-muted-foreground mb-0.5">Default Labour Rate</p>
          <p className="text-sm font-semibold text-foreground">
            {design.labour > 0 ? `₹${design.labour.toLocaleString('en-IN')}/${design.sellingMethod === 'By Weight' ? 'g' : 'pc'}` : '—'}
          </p>
        </div>
        <div className="p-3 bg-muted/40 rounded-xl">
          <p className="text-xs text-muted-foreground mb-0.5">Default Piroi</p>
          <p className="text-sm font-semibold text-foreground">
            {design.piroi > 0 ? `₹${design.piroi.toLocaleString('en-IN')}` : '—'}
          </p>
        </div>
      </div>

      {/* Description */}
      {design.description && (
        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-1">Description</p>
          <p className="text-sm text-foreground">{design.description}</p>
        </div>
      )}

      {/* SKU Summary */}
      <div className="p-3 bg-secondary rounded-xl border border-border mb-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Available Pieces</p>
            <p className="text-2xl font-bold text-primary">{inStockCount}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Total SKUs</p>
            <p className="text-lg font-bold text-foreground">{design.skus.length}</p>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary py-2 text-xs flex-1">
          <Plus size={13} />
          Add SKU
        </button>
        <Link href="/print-tags" className="btn-secondary py-2 text-xs flex-1 justify-center">
          <Printer size={13} />
          Print Tags
        </Link>
        <button className="btn-ghost py-2 text-xs flex-1">
          <Tag size={13} />
          View Sales
        </button>
      </div>
    </div>
  );
}
