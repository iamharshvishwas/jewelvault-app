'use client';
import React from 'react';
import Link from 'next/link';
import AppImage from '@/components/ui/AppImage';
import StatusBadge from '@/components/ui/StatusBadge';
import MaterialBadge from '@/components/ui/MaterialBadge';
import { Edit, Printer, Eye, ArrowUpDown, Trash2 } from 'lucide-react';
import type { Design, SkuStatus } from '@/lib/mockData';

interface InventoryTableProps {
  designs: Design[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onDeleteDesign?: (design: Design) => void;
}

export default function InventoryTable({ designs, selectedIds, onToggleSelect, onSelectAll, onDeleteDesign }: InventoryTableProps) {
  return (
    <div className="jewel-card overflow-hidden">
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/60 border-b border-border">
              <th className="w-8 px-3 py-3">
                <input
                  type="checkbox"
                  checked={selectedIds.size === designs.length && designs.length > 0}
                  onChange={onSelectAll}
                  className="w-3.5 h-3.5 rounded accent-primary"
                />
              </th>
              <th className="px-3 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider w-16">Photo</th>
              {[
                { id: 'th-design', label: 'Design No.' },
                { id: 'th-name', label: 'Name' },
                { id: 'th-category', label: 'Category' },
                { id: 'th-material', label: 'Material' },
                { id: 'th-skus', label: 'SKUs' },
                { id: 'th-gw', label: 'Gross Wt.' },
                { id: 'th-status', label: 'Status' },
                { id: 'th-location', label: 'Location' },
                { id: 'th-actions', label: '' },
              ].map((col) => (
                <th key={col.id} className="px-3 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  <span className="flex items-center gap-1">
                    {col.label}
                    {col.label && col.id !== 'th-actions' && (
                      <ArrowUpDown size={11} className="opacity-40 hover:opacity-100 cursor-pointer transition-opacity" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {designs.map((design) => {
              const inStockCount = design.skus.filter((s) => s.status === 'In Stock').length;
              const displayStatus: SkuStatus = inStockCount > 0 ? 'In Stock' : (design.skus[0]?.status ?? 'Archived');
              const totalGW = design.skus.reduce((a, s) => a + s.grossWeight, 0);
              const locations = [...new Set(design.skus.map((s) => s.location))];

              return (
                <tr key={`inv-table-${design.id}`} className="table-row-hover transition-colors group">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(design.id)}
                      onChange={() => onToggleSelect(design.id)}
                      className="w-3.5 h-3.5 rounded accent-primary"
                    />
                  </td>
                  <td className="px-3 py-3">
                    <div className="w-10 h-10 rounded-lg overflow-hidden image-placeholder flex-shrink-0">
                      <AppImage
                        src={design.primaryImage}
                        alt={`${design.designNumber} ${design.category} jewellery thumbnail`}
                        width={40}
                        height={40}
                        className="w-full h-full object-cover"
                      />
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <Link href={`/design-detail?id=${design.id}`} className="font-bold font-mono text-foreground hover:text-primary transition-colors">
                      {design.designNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground max-w-32 truncate">{design.designName || '—'}</td>
                  <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{design.category}</td>
                  <td className="px-3 py-3">
                    <MaterialBadge material={design.material} purity={design.purity} />
                  </td>
                  <td className="px-3 py-3 font-tabular">
                    <span className="font-semibold text-foreground">{inStockCount}</span>
                    <span className="text-muted-foreground">/{design.skus.length}</span>
                  </td>
                  <td className="px-3 py-3 font-tabular text-muted-foreground whitespace-nowrap">
                    {totalGW.toFixed(3)} g
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={displayStatus} size="sm" />
                  </td>
                  <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                    {locations.join(', ')}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Link href={`/design-detail?id=${design.id}`} className="btn-ghost p-1.5" title="View Design">
                        <Eye size={14} />
                      </Link>
                      <Link href={`/edit-stock?id=${design.id}`} className="btn-ghost p-1.5" title="Edit Existing Stock">
                        <Edit size={14} />
                      </Link>
                      <Link href="/print-tags" className="btn-ghost p-1.5" title="Print Tags">
                        <Printer size={14} />
                      </Link>
                      {onDeleteDesign && (
                        <button
                          onClick={() => onDeleteDesign(design)}
                          className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Delete Design"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
