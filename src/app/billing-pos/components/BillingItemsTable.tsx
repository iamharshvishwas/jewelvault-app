'use client';
import React from 'react';
import AppImage from '@/components/ui/AppImage';
import MaterialBadge from '@/components/ui/MaterialBadge';
import { Trash2, AlertTriangle } from 'lucide-react';
import type { EditableField } from './BillingPOSClient';
import {
  inr,
  type BillPreview,
  type BillingItem,
  type SavedBill,
  type SavedLine,
} from '@/lib/billing';
import { getDesigns } from '@/lib/designStore';
import { formatGrams } from '@/lib/pricing';

interface BillingItemsTableProps {
  items: BillingItem[];
  /** The live figures from pricing.ts, one line for each item (C12). */
  preview: BillPreview;
  /** The bill as the API saved it: from then on the figures are its, not the preview's (C12). */
  saved: SavedBill | null;
  /** Pieces the API refused (JV_PIECE_UNAVAILABLE): their lines are marked. */
  problemSkuIds: readonly string[];
  onUpdateItem: (id: string, field: EditableField, value: string) => void;
  onRemoveItem: (id: string) => void;
}

const shortDate = (date: string | null) =>
  date
    ? new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : '';

/** R2: what the metal rate of a line was made from, when that is worth a word: no rate (the person is asked for one), or a rate older than the bill date. */
function rateNote(item: BillingItem): { text: string; tone: 'red' | 'amber' } | null {
  const { sku, rate } = item;
  if (sku.sellingMethod !== 'By Weight') return null;
  if (rate.status === 'missing') {
    return item.metalRate.trim() === ''
      ? { text: `No daily rate for ${sku.material} ${sku.purity}: enter one`, tone: 'red' }
      : {
          text: `No daily rate for ${sku.material} ${sku.purity}: your rate is used`,
          tone: 'amber',
        };
  }
  if (rate.status === 'stale' && item.metalRate === item.rateDefault)
    return { text: `Rate of ${shortDate(rate.date)}, older than the bill date`, tone: 'amber' };
  return null;
}

export default function BillingItemsTable({
  items,
  preview,
  saved,
  problemSkuIds,
  onUpdateItem,
  onRemoveItem,
}: BillingItemsTableProps) {
  const moneyInputClass = 'input-field h-11 w-32 text-sm py-2 font-tabular font-bold text-right';

  if (items.length === 0) {
    return (
      <div className="jewel-card p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
          <AlertTriangle size={20} className="text-muted-foreground" />
        </div>
        <p className="text-sm font-semibold text-foreground">No items added yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Scan a barcode or enter a SKU number above to add jewellery to this invoice.
        </p>
      </div>
    );
  }

  // the figures of a line: the API's once the bill is saved, else the preview's
  const savedOf = (item: BillingItem): SavedLine | undefined =>
    saved?.lines.find((line) => line.skuId === item.sku.id);
  const everyLinePriced = preview.lines.length > 0 && preview.lines.every((line) => line.priced);
  const subtotal = saved
    ? saved.subtotal
    : everyLinePriced
      ? preview.lines.reduce((sum, line) => sum + (line.priced?.itemTotalPaise ?? 0), 0)
      : null;

  return (
    <div className="jewel-card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Invoice Items ({items.length})</h3>
      </div>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-sm min-w-[1180px]">
          <thead>
            <tr className="bg-muted/60 border-b border-border">
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                Item
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                NW (g)
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                Qty
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                Rate / Price
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                Metal Amt
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                Fine Due
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                Labour Rate
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                Piroi
              </th>
              <th className="px-4 py-3 text-left font-semibold text-muted-foreground uppercase tracking-wider">
                Other
              </th>
              <th className="px-4 py-3 text-right font-semibold text-muted-foreground uppercase tracking-wider">
                Total
              </th>
              <th className="px-2 py-2.5"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item, index) => {
              const design = getDesigns().find((d) => d.id === item.sku.designId);
              const sku = item.sku.skuNumber;
              const line = preview.lines[index];
              const priced = line?.priced ?? null;
              const final = savedOf(item);
              const note = rateNote(item);
              const refused = problemSkuIds.includes(item.sku.id);
              const metalAmount = final ? final.metalAmount : (priced?.metalAmountPaise ?? null);
              const labourAmount = final ? final.labourAmount : (priced?.labourAmountPaise ?? null);
              const fineMg = final ? final.fineWeightDueMg : (priced?.fineWeightDueMg ?? null);
              const total = final ? final.total : (priced?.itemTotalPaise ?? null);
              return (
                <tr
                  key={item.id}
                  data-sku={sku}
                  className={`table-row-hover ${refused ? 'bg-red-50' : ''}`}
                >
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
                        {item.heldStatus && (
                          <p
                            data-testid="held-badge"
                            className="mt-1 text-[10px] font-semibold text-amber-700"
                          >
                            {item.heldStatus}: billed on your confirmation
                          </p>
                        )}
                        {refused && (
                          <p
                            data-testid="piece-refused"
                            className="mt-1 text-[10px] font-semibold text-red-600"
                          >
                            Not available: remove it from the bill
                          </p>
                        )}
                      </div>
                    </div>
                  </td>

                  {/* Customer NW — read only, from SKU master */}
                  <td className="px-4 py-4 font-tabular font-bold text-foreground whitespace-nowrap">
                    {item.sku.sellingMethod === 'By Weight' ? (
                      item.sku.customerNetWeight.toFixed(3)
                    ) : (
                      <span className="text-muted-foreground">Per Piece</span>
                    )}
                  </td>

                  {/* Quantity — editable only for per-piece items */}
                  <td className="px-4 py-4">
                    {item.sku.sellingMethod === 'Per Piece' ? (
                      <input
                        type="number"
                        aria-label={`Quantity ${sku}`}
                        value={item.quantity}
                        onChange={(e) => onUpdateItem(item.id, 'quantity', e.target.value)}
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
                      aria-label={`Metal rate ${sku}`}
                      value={item.metalRate}
                      onChange={(e) => onUpdateItem(item.id, 'metalRate', e.target.value)}
                      className={moneyInputClass}
                      step={0.01}
                      min={0}
                    />
                    <p className="text-[10px] text-muted-foreground mt-1">
                      {item.sku.sellingMethod === 'By Weight'
                        ? 'per gram metal rate'
                        : 'piece sale price'}
                    </p>
                    {note && (
                      <p
                        data-testid="rate-note"
                        className={`text-[10px] font-semibold mt-1 ${
                          note.tone === 'red' ? 'text-red-600' : 'text-amber-700'
                        }`}
                      >
                        {note.text}
                      </p>
                    )}
                  </td>

                  {/* Metal Amount — calculated */}
                  <td className="px-4 py-4 font-tabular text-foreground whitespace-nowrap">
                    {metalAmount === null ? '-' : inr(metalAmount)}
                  </td>

                  <td className="px-4 py-4 font-tabular font-semibold text-amber-600 whitespace-nowrap">
                    {fineMg !== null && fineMg > 0 ? `${formatGrams(fineMg)} g` : '-'}
                  </td>

                  {/* Labour — editable */}
                  <td className="px-4 py-4">
                    {item.sku.sellingMethod === 'By Weight' ? (
                      <>
                        <input
                          type="number"
                          aria-label={`Labour rate ${sku}`}
                          value={item.labour}
                          onChange={(e) => onUpdateItem(item.id, 'labour', e.target.value)}
                          className={moneyInputClass}
                          step={0.01}
                          min={0}
                        />
                        <p className="text-[10px] text-muted-foreground mt-1">
                          per gram · {labourAmount === null ? '-' : inr(labourAmount)}
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
                      aria-label={`Piroi ${sku}`}
                      value={item.piroi}
                      onChange={(e) => onUpdateItem(item.id, 'piroi', e.target.value)}
                      className={moneyInputClass}
                      step={0.01}
                      min={0}
                    />
                  </td>

                  {/* Other Charges */}
                  <td className="px-4 py-4">
                    <input
                      type="number"
                      aria-label={`Other charges ${sku}`}
                      value={item.otherCharges}
                      onChange={(e) => onUpdateItem(item.id, 'otherCharges', e.target.value)}
                      className={moneyInputClass}
                      step={1}
                      min={0}
                    />
                  </td>

                  {/* Item Total */}
                  <td className="px-4 py-4 text-right font-tabular font-extrabold text-base text-foreground whitespace-nowrap">
                    <span data-testid="item-total">{total === null ? '-' : inr(total)}</span>
                    {!final && line?.error && (
                      <p
                        role="alert"
                        data-testid="line-error"
                        className="mt-1 max-w-[16rem] whitespace-normal text-right text-[10px] font-semibold text-red-600"
                      >
                        {line.error}
                      </p>
                    )}
                  </td>

                  {/* Remove */}
                  <td className="px-2 py-3">
                    <button
                      onClick={() => onRemoveItem(item.id)}
                      className="btn-ghost p-1.5 text-red-500 hover:text-red-700 hover:bg-red-50"
                      title="Remove item from invoice"
                      aria-label={`Remove ${sku}`}
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
              <td
                colSpan={9}
                className="px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground uppercase tracking-wider"
              >
                Subtotal
              </td>
              <td className="px-3 py-2.5 text-right font-tabular font-bold text-foreground text-sm">
                {subtotal === null ? '-' : inr(subtotal)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
