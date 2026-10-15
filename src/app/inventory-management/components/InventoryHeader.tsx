'use client';
import React, { useState, useEffect } from 'react';
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
import { downloadCsv, downloadExcel, printPdf, type ExportRow } from '@/lib/exportUtils';
import { useSession } from '@/lib/authStore';

export default function InventoryHeader() {
  const [view, setView] = useState<'grid' | 'table'>('grid');
  const [stats, setStats] = useState({ designs: 0, skus: 0, inStock: 0 });
  const { role } = useSession();
  const isAdmin = role === 'owner';

  useEffect(() => {
    const compute = () => {
      const designs = getDesigns();
      const allSkus = designs?.flatMap((d) => d?.skus);
      setStats({
        designs: designs?.length,
        skus: allSkus?.length,
        inStock: allSkus?.filter((s) => s?.status === 'In Stock')?.length,
      });
    };
    compute();
    const interval = setInterval(compute, 800);
    return () => clearInterval(interval);
  }, []);

  const inventoryRows = (): ExportRow[] =>
    getDesigns().flatMap((design) =>
      design.skus.map((sku) => ({
        'Design No.': design.designNumber,
        'Design Name': design.designName,
        Category: design.category,
        Subcategory: design.subcategory,
        SKU: sku.skuNumber,
        Barcode: sku.barcode,
        Material: sku.material,
        Purity: sku.purity,
        'Selling Method': sku.sellingMethod,
        Status: sku.status,
        Location: sku.location,
        'Gross Weight (g)': sku.grossWeight,
        'Original Net Weight (g)': sku.originalNetWeight,
        'Customer Net Weight (g)': sku.customerNetWeight,
        Stones: sku.stones,
        'Stone Weight': sku.stoneWeight,
        Kundan: sku.kundan,
        'Kundan Weight': sku.kundanWeight,
        Piroi: sku.piroi,
        'Retail Labour/Rate': sku.retailLabour ?? sku.labour,
        'Semi-Wholesale Labour/Rate': sku.semiWholesaleLabour ?? '',
        'Wholesale Labour/Rate': sku.wholesaleLabour ?? sku.labour,
        'Created At': new Date(sku.createdAt).toLocaleString('en-IN'),
        Notes: sku.notes,
      }))
    );

  const exportInventory = (format: 'csv' | 'excel' | 'pdf') => {
    const rows = inventoryRows();
    if (format === 'csv') downloadCsv('Inventory SKU Export', rows);
    if (format === 'excel') downloadExcel('Inventory SKU Export', rows, `${stats.skus} SKUs`);
    if (format === 'pdf') printPdf('Inventory SKU Export', rows, `${stats.skus} SKUs`);
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
