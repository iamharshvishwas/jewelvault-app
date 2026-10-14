'use client';
import React, { useState, useEffect } from 'react';
import { getDesigns } from '@/lib/designStore';
import StatusBadge from '@/components/ui/StatusBadge';
import { Printer, Edit, ScanLine, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import type { Design } from '@/lib/mockData';

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

// Simulated role — in production this comes from auth context
const USER_ROLE: 'admin' | 'sales' = 'admin';

export default function DesignSkuTable() {
  const design = useDesignFromUrl();
  const [showOriginalNW, setShowOriginalNW] = useState(false);
  const canViewOriginalNW = USER_ROLE === 'admin';

  if (!design) {
    return (
      <div className="py-8 text-center text-muted-foreground text-sm">
        No design selected.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Physical SKUs — {design.skus.length} pieces</h3>
        <div className="flex items-center gap-2">
          {canViewOriginalNW && (
            <button
              onClick={() => setShowOriginalNW((p) => !p)}
              className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                showOriginalNW
                  ? 'bg-amber-50 border-amber-200 text-amber-700' :'bg-muted border-border text-muted-foreground hover:text-foreground'
              }`}
            >
              {showOriginalNW ? <Eye size={13} /> : <EyeOff size={13} />}
              {showOriginalNW ? 'Hide Original NW' : 'Show Original NW (Admin)'}
            </button>
          )}
          <button className="btn-primary py-1.5 text-xs">
            + Add SKU
          </button>
        </div>
      </div>

      {canViewOriginalNW && showOriginalNW && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs px-3 py-2 rounded-lg">
          <AlertTriangle size={13} />
          <span className="font-semibold">Admin View:</span>
          Original Net Weight is visible. This data is confidential and must never appear on customer documents.
        </div>
      )}

      {design.skus.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground text-sm">No SKUs for this design yet.</div>
      ) : (
        <>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {[
                    { id: 'th-sku', label: 'SKU Number' },
                    { id: 'th-gw', label: 'Gross Wt.' },
                    ...(canViewOriginalNW && showOriginalNW ? [{ id: 'th-onw', label: 'Orig. NW (Admin)' }] : []),
                    { id: 'th-cnw', label: 'Customer NW' },
                    { id: 'th-stones', label: 'Stones' },
                    { id: 'th-kundan', label: 'Kundan' },
                    { id: 'th-piroi', label: 'Piroi' },
                    { id: 'th-labour', label: 'Labour Rate' },
                    { id: 'th-status', label: 'Status' },
                    { id: 'th-location', label: 'Location' },
                    { id: 'th-barcode', label: 'Barcode' },
                    { id: 'th-actions', label: '' },
                  ].map((col) => (
                    <th key={col.id} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                      {col.label}
                      {col.id === 'th-onw' && (
                        <span className="ml-1 bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded text-xs normal-case">
                          Admin Only
                        </span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {design.skus.map((sku) => (
                  <tr key={`sku-row-${sku.id}`} className="table-row-hover transition-colors group">
                    <td className="px-3 py-3">
                      <span className="font-mono font-bold text-foreground">{sku.skuNumber}</span>
                      {sku.status === 'Sold' && (
                        <span className="ml-2 text-xs bg-red-100 text-red-600 px-1.5 py-0.5 rounded-full font-semibold">SOLD</span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">{sku.grossWeight > 0 ? `${sku.grossWeight.toFixed(3)} g` : '—'}</td>
                    {canViewOriginalNW && showOriginalNW && (
                      <td className="px-3 py-3 font-tabular text-amber-700 font-semibold whitespace-nowrap bg-amber-50/50">
                        {sku.originalNetWeight > 0 ? `${sku.originalNetWeight.toFixed(3)} g` : '—'}
                      </td>
                    )}
                    <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">{sku.customerNetWeight > 0 ? `${sku.customerNetWeight.toFixed(3)} g` : '—'}</td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground">
                      {sku.stones > 0 ? `${sku.stones} (${sku.stoneWeight.toFixed(3)}g)` : '—'}
                    </td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground">
                      {sku.kundan > 0 ? `${sku.kundan} (${sku.kundanWeight.toFixed(3)}g)` : '—'}
                    </td>
                    <td className="px-3 py-3 font-tabular text-muted-foreground whitespace-nowrap">
                      {sku.piroi > 0 ? `₹${sku.piroi.toLocaleString('en-IN')}` : '—'}
                    </td>
                    <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">
                      {sku.labour > 0 ? `₹${sku.labour.toLocaleString('en-IN')}/${sku.sellingMethod === 'By Weight' ? 'g' : 'pc'}` : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={sku.status} size="sm" />
                    </td>
                    <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">{sku.location}</td>
                    <td className="px-3 py-3">
                      <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{sku.barcode}</span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button className="btn-ghost p-1.5" title="Print Tag">
                          <Printer size={13} />
                        </button>
                        <button className="btn-ghost p-1.5" title="Edit SKU">
                          <Edit size={13} />
                        </button>
                        <button className="btn-ghost p-1.5" title="Scan Barcode">
                          <ScanLine size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Weight Summary */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-border">
            {[
              { id: 'ws-gw', label: 'Total Gross Weight', value: `${design.skus.reduce((a, s) => a + s.grossWeight, 0).toFixed(3)} g` },
              { id: 'ws-cnw', label: 'Total Customer NW', value: `${design.skus.reduce((a, s) => a + s.customerNetWeight, 0).toFixed(3)} g` },
              { id: 'ws-stones', label: 'Total Stones', value: `${design.skus.reduce((a, s) => a + s.stones, 0)}` },
              { id: 'ws-kundan', label: 'Total Kundan', value: `${design.skus.reduce((a, s) => a + s.kundan, 0)}` },
            ].map((item) => (
              <div key={item.id} className="text-center p-2 bg-muted/40 rounded-lg">
                <p className="text-xs text-muted-foreground mb-0.5">{item.label}</p>
                <p className="text-sm font-bold text-foreground font-tabular">{item.value}</p>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
