'use client';
import React, { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import {
  Plus,
  Grid,
  List,
  ScanLine,
  Printer,
  Download,
  Upload,
  FileSpreadsheet,
  FileText,
} from 'lucide-react';
import { getDesigns } from '@/lib/designStore';
import { filterDesigns, inventoryStats } from '@/lib/inventoryFilter';
import { useInventoryFilter } from '@/lib/inventoryFilterStore';
import type { Design } from '@/lib/mockData';
import { downloadCsv, downloadExcel, printPdf, type ExportRow } from '@/lib/exportUtils';
import { inventoryExportRows } from '@/lib/inventoryExport';
import { useSession } from '@/lib/authStore';

export default function InventoryHeader() {
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const filter = useInventoryFilter();
  const [allDesigns, setAllDesigns] = useState<Design[]>([]);
  const { role } = useSession();
  const isAdmin = role === 'owner';

  useEffect(() => {
    const compute = () => setAllDesigns(getDesigns());
    compute();
    const interval = setInterval(compute, 800);
    return () => clearInterval(interval);
  }, []);

  // the line under the title is the designs the filter panel lets through, with all the pieces of those designs
  const stats = useMemo(
    () => inventoryStats(filterDesigns(allDesigns, filter)),
    [allDesigns, filter]
  );
  // the exports below are of the whole stock, filter or not, and say so with their own count
  const exportSkus = useMemo(() => inventoryStats(allDesigns).skus, [allDesigns]);

  const inventoryRows = (): ExportRow[] => inventoryExportRows(getDesigns(), role);

  const exportInventory = (format: 'csv' | 'excel' | 'pdf') => {
    const rows = inventoryRows();
    if (format === 'csv') downloadCsv('Inventory SKU Export', rows);
    if (format === 'excel') downloadExcel('Inventory SKU Export', rows, `${exportSkus} SKUs`);
    if (format === 'pdf') printPdf('Inventory SKU Export', rows, `${exportSkus} SKUs`);
  };

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Inventory</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {stats?.designs} design{stats?.designs !== 1 ? 's' : ''} · {stats?.skus} SKU
          {stats?.skus !== 1 ? 's' : ''} · {stats?.inStock} in stock
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {/* View Toggle */}
        <div className="flex items-center bg-muted rounded-lg p-1">
          <button
            onClick={() => setView('grid')}
            className={`p-1.5 rounded-md transition-colors ${view === 'grid' ? 'bg-card shadow-sm text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            aria-label="Grid view"
          >
            <Grid size={16} />
          </button>
          <button
            onClick={() => setView('table')}
            className={`p-1.5 rounded-md transition-colors ${view === 'table' ? 'bg-card shadow-sm text-primary' : 'text-muted-foreground hover:text-foreground'}`}
            aria-label="Table view"
          >
            <List size={16} />
          </button>
        </div>

        {isAdmin && (
          <Link href="/scan-detail" className="btn-ghost py-2 text-xs">
            <ScanLine size={15} />
            <span className="hidden sm:inline">Scan</span>
          </Link>
        )}
        <Link href="/print-tags" className="btn-ghost py-2 text-xs">
          <Printer size={15} />
          <span className="hidden sm:inline">Print Tags</span>
        </Link>
        <button onClick={() => exportInventory('excel')} className="btn-ghost py-2 text-xs">
          <FileSpreadsheet size={15} />
          <span className="hidden sm:inline">Excel</span>
        </button>
        <button onClick={() => exportInventory('csv')} className="btn-ghost py-2 text-xs">
          <Download size={15} />
          <span className="hidden sm:inline">CSV</span>
        </button>
        <button onClick={() => exportInventory('pdf')} className="btn-ghost py-2 text-xs">
          <FileText size={15} />
          <span className="hidden sm:inline">PDF</span>
        </button>
        <button className="btn-ghost py-2 text-xs">
          <Upload size={15} />
          <span className="hidden sm:inline">Import</span>
        </button>
        <Link href="/add-design" className="btn-primary py-2">
          <Plus size={15} />
          <span>Add Design</span>
        </Link>
      </div>
    </div>
  );
}
