'use client';
import React from 'react';
import AppImage from '@/components/ui/AppImage';
import MaterialBadge from '@/components/ui/MaterialBadge';
import { Trash2, AlertTriangle } from 'lucide-react';
import type { BillingItem } from './BillingPOSClient';
import { getDesigns } from '@/lib/designStore';

interface BillingItemsTableProps {
  items: BillingItem[];
  onUpdateItem: (id: string, field: keyof BillingItem, value: number) => void;
  onRemoveItem: (id: string) => void;
}

export default function BillingItemsTable({ items, onUpdateItem, onRemoveItem }: BillingItemsTableProps) {
  const moneyInputClass = 'input-field h-11 w-32 text-sm py-2 font-tabular font-bold text-right';

  if (items.length === 0) {
    return (
      <div className="jewel-card p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
          <AlertTriangle size={20} className="text-muted-foreground" />
        </div>
        <p className="text-sm font-semibold text-foreground">No items added yet</p>
        <p className="text-xs text-muted-foreground mt-1">Scan a barcode or enter a SKU number above to add jewellery to this invoice.</p>
      </div>
    );
  }

  return (
    <div className="jewel-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Invoice Items ({items.length})</h3>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-sm min-w-[1180px]">
          <thead>
            <tr className="bg-muted/60 border-b border-border">
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">Item</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">NW (g)</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Qty</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Rate / Price</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Metal Amt</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">Fine Due</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">Labour Rate</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">Piroi</th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">Other</th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground uppercase tracking-wider">Total</th>
              <th className="px-2 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => {
              const design = getDesigns().find((d) => d.id === item.sku.designId);
              return (
                <tr key={item.id} className="table-row-hover">
                  {/* Item Info */}
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-2.5">
                      <div className="w-10 h-10 rounded-lg overflow-hidden image-placeholder flex-shrink-0">
                        {design && (
                          <AppImage
                            src={design.primaryImage}
                            alt={`${item.sku.designNumber} ${item.sku.category} jewellery billing item`}
                            width={40}
                            height={40}
                            className="w-full h-full object-cover"
                          />
                        )}
                      </div>
                      <div>
                        <p className="font-mono font-bold text-foreground">{item.sku.skuNumber}</p>
                        <p className="text-muted-foreground">{item.sku.category}</p>
                        <MaterialBadge material={item.sku.material} purity={item.sku.purity} />
                      </div>
                    </div>
                  </td>

                  {/* Customer NW — read only, from SKU master */}
                  <td className="px-4 py-4 font-tabular font-bold text-foreground whitespace-nowrap">
                    {item.sku.sellingMethod === 'By Weight'
                      ? item.sku.customerNetWeight.toFixed(3)
                      : <span className="text-muted-foreground">Per Piece</span>
                    }
                  </td>

                  {/* Quantity — editable only for per-piece items */}
                  <td className="px-4 py-4">
                    {item.sku.sellingMethod === 'Per Piece' ? (
                      <input
                        type="number"
                        value={item.quantity}
                        onChange={(e) => onUpdateItem(item.id, 'quantity', parseFloat(e.target.value) || 1)}
                        className="input-field h-11 w-20 text-sm py-2 font-tabular font-bold text-center"
                        step={1}
                        min={1}
                      />
                    ) : (
                      <span className="text-muted-foreground">1</span>
                    )}
                  </td>

                  {/* Metal rate or piece price — editable */}
                  <td className="px-4 py-4">
                    <input
                      type="number"
                      value={item.metalRate}
                      onChange={(e) => onUpdateItem(item.id, 'metalRate', parseFloat(e.target.value) || 0)}
                      className={moneyInputClass}
                      step={0.01}
                      min={0}
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {item.sku.sellingMethod === 'By Weight' ? 'per gram metal rate' : 'piece sale price'}
                    </p>
                  </td>

                  {/* Metal Amount — calculated */}
                  <td className="px-4 py-4 font-tabular text-foreground whitespace-nowrap">
                    ₹{item.metalAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>

                  <td className="px-4 py-4 font-tabular font-semibold text-amber-600 whitespace-nowrap">
                    {item.fineWeightDue > 0 ? `${item.fineWeightDue.toFixed(3)} g` : '-'}
                  </td>

                  {/* Labour — editable */}
                  <td className="px-4 py-4">
                    {item.sku.sellingMethod === 'By Weight' ? (
                      <>
                        <input
                          type="number"
                          value={item.labour}
                          onChange={(e) => onUpdateItem(item.id, 'labour', parseFloat(e.target.value) || 0)}
                          className={moneyInputClass}
                          step={0.01}
                          min={0}
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          per gram · ₹{item.labourAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                        </p>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">Included in piece price</span>
                    )}
                  </td>

                  {/* Piroi — editable */}
                  <td className="px-4 py-4">
                    <input
                      type="number"
                      value={item.piroi}
                      onChange={(e) => onUpdateItem(item.id, 'piroi', parseFloat(e.target.value) || 0)}
                      className={moneyInputClass}
                      step={0.01}
                      min={0}
                    />
                  </td>

                  {/* Other Charges */}
                  <td className="px-4 py-4">
                    <input
                      type="number"
                      value={item.otherCharges}
                      onChange={(e) => onUpdateItem(item.id, 'otherCharges', parseFloat(e.target.value) || 0)}
                      className={moneyInputClass}
                      step={1}
                      min={0}
                    />
                  </td>

                  {/* Item Total */}
                  <td className="px-4 py-4 text-right font-tabular font-extrabold text-base text-foreground whitespace-nowrap">
                    ₹{item.itemTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>

                  {/* Remove */}
                  <td className="px-2 py-3">
                    <button
                      onClick={() => onRemoveItem(item.id)}
                      className="btn-ghost p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50"
                      title="Remove item from invoice"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="bg-muted/40 border-t-2 border-border">
              <td colSpan={9} className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Subtotal
              </td>
              <td className="px-3 py-2.5 text-right font-tabular font-bold text-foreground text-sm">
                ₹{items.reduce((a, i) => a + i.itemTotal, 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
