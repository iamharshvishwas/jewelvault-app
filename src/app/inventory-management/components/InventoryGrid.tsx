'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import AppImage from '@/components/ui/AppImage';
import { getDesigns, removeDesign, removeDesigns } from '@/lib/designStore';
import StatusBadge from '@/components/ui/StatusBadge';
import MaterialBadge from '@/components/ui/MaterialBadge';
import InventoryTable from './InventoryTable';
import {
  Grid,
  List,
  Printer,
  Tag,
  ArrowLeftRight,
  Archive,
  ChevronLeft,
  ChevronRight,
  Trash2,
  AlertTriangle,
  X,
  Package,
} from 'lucide-react';
import { useSession } from '@/lib/authStore';
import type { SkuStatus, Design } from '@/lib/mockData';

const SORT_OPTIONS = [
  { id: 'sort-newest', label: 'Newest First' },
  { id: 'sort-oldest', label: 'Oldest First' },
  { id: 'sort-design', label: 'Design Number' },
  { id: 'sort-category', label: 'Category' },
  { id: 'sort-weight', label: 'Weight (High–Low)' },
];

// ─── Delete Confirmation Modal ────────────────────────────────────────────────

function DeleteConfirmModal({
  design,
  onConfirm,
  onCancel,
}: {
  design: Design;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      {/* Modal */}
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-5">
        {/* Close */}
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X size={16} />
        </button>

        {/* Icon + Title */}
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={22} className="text-red-500" />
          </div>
          <div>
            <h3 className="text-lg font-bold text-foreground">Delete Design?</h3>
            <p className="text-sm text-muted-foreground mt-0.5">This action cannot be undone.</p>
          </div>
        </div>

        {/* Design Info */}
        <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-xl border border-border">
          <div className="w-12 h-12 rounded-lg overflow-hidden flex-shrink-0 image-placeholder">
            <AppImage
              src={design.primaryImage}
              alt={design.designNumber}
              width={48}
              height={48}
              className="w-full h-full object-cover"
            />
          </div>
          <div>
            <p className="font-mono font-bold text-sm text-foreground">{design.designNumber}</p>
            {design.designName && (
              <p className="text-xs text-muted-foreground">{design.designName}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {design.category} · {design.skus.length} SKU{design.skus.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          Deleting this design will remove it and all its associated SKUs from inventory. Sales
          history will be preserved.
        </p>

        {/* Actions */}
        <div className="flex gap-3 pt-1">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 border border-border rounded-xl text-sm font-medium text-foreground hover:bg-muted/40 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 px-4 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-semibold transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 size={14} />
            Delete Design
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function InventoryGrid() {
  const [designs, setDesigns] = useState<Design[]>([]);
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState('sort-newest');
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<Design | null>(null);
  const { role } = useSession();
  const perPage = 8;
  const isAdmin = role === 'owner';

  // Sync from store on mount and on window focus (so new designs from Add Design appear)
  useEffect(() => {
    const sync = () => setDesigns([...getDesigns()]);
    sync();
    window.addEventListener('focus', sync);
    // Also poll every 500ms to catch same-tab navigation updates
    const interval = setInterval(sync, 500);
    return () => {
      window.removeEventListener('focus', sync);
      clearInterval(interval);
    };
  }, []);

  const total = designs.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const paginated = designs.slice((page - 1) * perPage, page * perPage);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selectedIds.size === paginated.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(paginated.map((d) => d.id)));
  };

  const handleDeleteConfirm = () => {
    if (!deleteTarget) return;
    removeDesign(deleteTarget.id);
    setDesigns([...getDesigns()]);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(deleteTarget.id);
      return next;
    });
    setDeleteTarget(null);
    const newTotal = getDesigns().length;
    const newTotalPages = Math.max(1, Math.ceil(newTotal / perPage));
    if (page > newTotalPages) setPage(newTotalPages);
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    const selectedSkuCount = designs
      .filter((design) => selectedIds.has(design.id))
      .reduce((total, design) => total + design.skus.length, 0);
    if (
      !window.confirm(
        `Delete ${selectedIds.size} design(s) and ${selectedSkuCount} SKU(s)? This cannot be undone.`
      )
    )
      return;
    removeDesigns(selectedIds);
    setDesigns([...getDesigns()]);
    setSelectedIds(new Set());
  };

  // ── Empty State ──────────────────────────────────────────────────────────────
  if (designs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center space-y-4">
        <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
          <Package size={28} className="text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground mb-1">No designs yet</h3>
          <p className="text-sm text-muted-foreground max-w-xs">
            Add your first jewellery design to get started. Click <strong>+ Add Design</strong>{' '}
            above.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Delete Modal */}
      {deleteTarget && (
        <DeleteConfirmModal
          design={deleteTarget}
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="input-field text-xs py-1.5 w-44"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground">{total} designs</span>
        </div>

        <div className="flex items-center bg-muted rounded-lg p-1">
          <button
            onClick={() => setView('grid')}
            className={`p-1.5 rounded-md transition-colors ${view === 'grid' ? 'bg-card shadow-sm text-primary' : 'text-muted-foreground'}`}
          >
            <Grid size={15} />
          </button>
          <button
            onClick={() => setView('table')}
            className={`p-1.5 rounded-md transition-colors ${view === 'table' ? 'bg-card shadow-sm text-primary' : 'text-muted-foreground'}`}
          >
            <List size={15} />
          </button>
        </div>
      </div>

      {/* Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="slide-up flex items-center gap-3 bg-foreground text-primary-foreground px-4 py-2.5 rounded-xl">
          <span className="text-sm font-semibold">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2 ml-2">
            <Link
              href="/print-tags"
              className="flex items-center gap-1.5 text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors"
            >
              <Printer size={13} /> Print Tags
            </Link>
            <button className="flex items-center gap-1.5 text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors">
              <Tag size={13} /> Change Category
            </button>
            <button className="flex items-center gap-1.5 text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors">
              <ArrowLeftRight size={13} /> Transfer
            </button>
            <button className="flex items-center gap-1.5 text-xs bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors">
              <Archive size={13} /> Archive
            </button>
            {isAdmin && (
              <button
                onClick={handleDeleteSelected}
                className="flex items-center gap-1.5 text-xs bg-red-500/80 hover:bg-red-500 px-3 py-1.5 rounded-lg transition-colors"
              >
                <Trash2 size={13} /> Delete
              </button>
            )}
          </div>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="ml-auto text-xs text-white/60 hover:text-white"
          >
            Clear
          </button>
        </div>
      )}

      {/* Grid View */}
      {view === 'grid' && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4 gap-3">
          {paginated.map((design) => {
            const inStockCount = design.skus.filter((s) => s.status === 'In Stock').length;
            const isSelected = selectedIds.has(design.id);
            const displayStatus: SkuStatus =
              inStockCount > 0 ? 'In Stock' : (design.skus[0]?.status ?? 'Archived');
            const totalGW = design.skus.reduce((a, s) => a + s.grossWeight, 0);

            return (
              <div
                key={`inv-grid-${design.id}`}
                className={`jewel-card overflow-hidden cursor-pointer transition-all duration-150 group ${isSelected ? 'ring-2 ring-primary' : ''}`}
              >
                {/* Checkbox */}
                <div className="relative">
                  <div className="absolute top-2 left-2 z-10">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleSelect(design.id)}
                      className="w-4 h-4 rounded accent-primary cursor-pointer"
                    />
                  </div>
                  {isAdmin && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(design);
                      }}
                      className="absolute top-2 right-2 z-10 w-7 h-7 rounded-full bg-white/90 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-50"
                      title="Delete design"
                    >
                      <Trash2 size={13} className="text-red-500" />
                    </button>
                  )}
                  <Link href={`/design-detail?id=${design.id}`}>
                    <div className="aspect-square bg-muted overflow-hidden image-placeholder">
                      <AppImage
                        src={design.primaryImage}
                        alt={`${design.designNumber} - ${design.designName || design.category}`}
                        width={300}
                        height={300}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                    </div>
                  </Link>
                </div>
                <div className="p-3 space-y-2">
                  <div className="flex items-start justify-between gap-1">
                    <div>
                      <p className="font-mono text-xs font-bold text-primary leading-tight">
                        {design.designNumber}
                      </p>
                      {design.designName && (
                        <p className="text-xs text-foreground font-medium leading-tight mt-0.5 line-clamp-1">
                          {design.designName}
                        </p>
                      )}
                    </div>
                    <StatusBadge status={displayStatus} size="xs" />
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <MaterialBadge material={design.material} size="xs" />
                    <span className="text-xs text-muted-foreground">{design.purity}</span>
                    <span className="text-xs text-muted-foreground">·</span>
                    <span className="text-xs text-muted-foreground">{design.category}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/50">
                    <span>
                      {design.skus.length} SKU{design.skus.length !== 1 ? 's' : ''}
                    </span>
                    {totalGW > 0 && <span>{totalGW.toFixed(3)}g GW</span>}
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Link
                      href={`/edit-stock?id=${design.id}`}
                      className="btn-secondary py-1.5 text-xs flex-1 justify-center"
                    >
                      Edit Stock
                    </Link>
                    <Link
                      href={`/design-detail?id=${design.id}`}
                      className="btn-ghost py-1.5 text-xs flex-1 justify-center"
                    >
                      View
                    </Link>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Table View */}
      {view === 'table' && (
        <InventoryTable
          designs={paginated}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onSelectAll={selectAll}
          onDeleteDesign={isAdmin ? (design) => setDeleteTarget(design) : undefined}
        />
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <span className="text-xs text-muted-foreground">
            Showing {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="w-7 h-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronLeft size={13} />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                onClick={() => setPage(p)}
                className={`w-7 h-7 rounded-lg border text-xs font-medium transition-all ${
                  p === page
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'border-border text-muted-foreground hover:border-primary/40'
                }`}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="w-7 h-7 rounded-lg border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <ChevronRight size={13} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
