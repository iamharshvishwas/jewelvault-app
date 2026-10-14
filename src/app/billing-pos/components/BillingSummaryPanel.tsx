'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { CreditCard, Banknote, Smartphone, Building2, Clock, CheckCircle, Loader2 } from 'lucide-react';
import type { Customer } from '@/lib/mockData';
import type { BillingItem } from './BillingPOSClient';
import { addInvoice, getNextInvoiceNumber } from '@/lib/appStore';
import { updateSkuStatus } from '@/lib/designStore';
import type { Invoice, InvoiceItem, Payment } from '@/lib/mockData';

interface BillingSummaryPanelProps {
  subtotal: number;
  discount: number;
  onDiscountChange: (v: number) => void;
  additionalCharges: number;
  onAdditionalChargesChange: (v: number) => void;
  gstPercent: number;
  gstAmount: number;
  roundOff: number;
  finalTotal: number;
  customer: Customer | null;
  notes: string;
  onNotesChange: (v: string) => void;
  itemCount: number;
  items: BillingItem[];
  invoiceNumber: string;
  saleType: 'Retail' | 'Semi-Wholesale' | 'Wholesale';
  invoiceDate: string;
  onNewSale: () => void;
}

type PaymentMode = 'Cash' | 'UPI' | 'Card' | 'Bank Transfer' | 'Credit';

interface PaymentEntry {
  id: string;
  mode: PaymentMode;
  amount: number;
  reference: string;
}

const MODE_ICONS: Record<PaymentMode, React.ReactNode> = {
  Cash: <Banknote size={14} />,
  UPI: <Smartphone size={14} />,
  Card: <CreditCard size={14} />,
  'Bank Transfer': <Building2 size={14} />,
  Credit: <Clock size={14} />,
};

export default function BillingSummaryPanel({
  subtotal, discount, onDiscountChange, additionalCharges, onAdditionalChargesChange,
  gstPercent, gstAmount, roundOff, finalTotal, customer, notes, onNotesChange, itemCount,
  items, invoiceNumber, saleType, invoiceDate, onNewSale,
}: BillingSummaryPanelProps) {
  const [payments, setPayments] = useState<PaymentEntry[]>([
    { id: 'pmt-1', mode: 'UPI', amount: 0, reference: '' },
  ]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedInvoiceNumber, setSavedInvoiceNumber] = useState('');

  const totalReceived = payments.reduce((a, p) => a + p.amount, 0);
  const pendingAmount = finalTotal - totalReceived;
  const fineWeightDue = items.reduce((total, item) => total + item.fineWeightDue, 0);

  const addPaymentRow = () => {
    setPayments((prev) => [
      ...prev,
      { id: `pmt-${prev.length + 1}`, mode: 'Cash', amount: 0, reference: '' },
    ]);
  };

  const updatePayment = (id: string, field: 'mode' | 'amount' | 'reference', value: string | number) => {
    setPayments((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const removePayment = (id: string) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
  };

  const handleSave = async () => {
    if (itemCount === 0) {
      alert('Please add at least one item to the estimate.');
      return;
    }
    setSaving(true);

    await new Promise((r) => setTimeout(r, 400));

    const now = invoiceDate ? new Date(`${invoiceDate}T12:00:00`).toISOString() : new Date().toISOString();
    const invNumber = invoiceNumber || getNextInvoiceNumber();

    // Build estimate item snapshots.
    const invoiceItems: InvoiceItem[] = items.map((item) => ({
      id: `iitem-${item.sku.id}`,
      designNumber: item.sku.designNumber,
      skuNumber: item.sku.skuNumber,
      material: item.sku.material,
      purity: item.sku.purity,
      grossWeight: item.sku.grossWeight,
      customerNetWeight: item.sku.customerNetWeight,
      metalRate: item.metalRate,
      labour: item.labourAmount,
      piroi: item.piroi,
      otherCharges: item.otherCharges,
      metalAmount: item.metalAmount,
      fineWeightDue: item.fineWeightDue,
      itemTotal: item.itemTotal,
      sellingMethod: item.sku.sellingMethod,
      imageRef: '',
      category: item.sku.category,
      taxRate: 0,
      taxAmount: 0,
    }));

    // Build payments.
    const invoicePayments: Payment[] = payments
      .filter((p) => p.amount > 0)
      .map((p) => ({
        id: `pmt-${p.id}-${Date.now()}`,
        mode: p.mode,
        amount: p.amount,
        date: now,
        reference: p.reference,
        notes: '',
      }));

    const amountReceived = invoicePayments.reduce((a, p) => a + p.amount, 0);
    const pendingAmt = Math.max(0, Math.round(finalTotal) - amountReceived);
    const status: Invoice['status'] =
      pendingAmt <= 0 && fineWeightDue <= 0 ? 'Paid' : amountReceived > 0 ? 'Partial' : 'Pending';

    const invoice: Invoice = {
      id: `inv-${Date.now()}`,
      invoiceNumber: invNumber,
      customerId: customer?.id ?? 'walk-in',
      customerName: customer?.name ?? 'Walk-in Customer',
      customerMobile: customer?.mobile ?? '',
      items: invoiceItems,
      payments: invoicePayments,
      subtotal,
      discount,
      discountPercent: subtotal > 0 ? (discount / subtotal) * 100 : 0,
      additionalCharges,
      gst: gstAmount,
      gstPercent,
      roundOff,
      grandTotal: Math.round(finalTotal),
      amountReceived,
      pendingAmount: pendingAmt,
      status,
      saleType,
      fineWeightDue,
      fineWeightSettled: 0,
      fineWeightPending: fineWeightDue,
      amountDue: Math.round(finalTotal),
      date: now,
      createdBy: 'Staff',
      notes: `[${saleType} Estimate]${notes ? ` ${notes}` : ''}`,
    };

    for (const item of items) {
      updateSkuStatus(item.sku.id, 'Sold');
    }

    addInvoice(invoice);

    setSavedInvoiceNumber(invNumber);
    setSaving(false);
    setSaved(true);
  };

  const handleNewSale = () => {
    setSaved(false);
    setSavedInvoiceNumber('');
    setPayments([{ id: 'pmt-1', mode: 'UPI', amount: 0, reference: '' }]);
    onNewSale();
  };

  return (
    <div className="space-y-3 sticky top-4">
      {/* Bill Summary */}
      <div className="jewel-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-1">Estimate Summary</h3>
        <p className="text-xs text-muted-foreground mb-4">
          No GST is added. This is an estimate only.
        </p>

        <div className="space-y-2.5">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Subtotal ({itemCount} items)</span>
            <span className="font-tabular font-semibold text-foreground">₹{subtotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
          </div>

          {/* Discount */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">Discount</span>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">₹</span>
              <input
                type="number"
                value={discount}
                onChange={(e) => onDiscountChange(parseFloat(e.target.value) || 0)}
                className="input-field w-24 text-xs py-1 text-right font-tabular"
                min={0}
                step={100}
              />
            </div>
          </div>

          {discount > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">After Discount</span>
              <span className="font-tabular text-foreground">₹{(subtotal - discount).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
            </div>
          )}

          {/* Additional Charges */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-muted-foreground">Add. Charges</span>
            <div className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground">₹</span>
              <input
                type="number"
                value={additionalCharges}
                onChange={(e) => onAdditionalChargesChange(parseFloat(e.target.value) || 0)}
                className="input-field w-24 text-xs py-1 text-right font-tabular"
                min={0}
              />
            </div>
          </div>

          {/* Round Off */}
          {gstPercent > 0 && (
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">GST ({gstPercent}%)</span>
              <span className="font-tabular font-semibold text-foreground">₹{gstAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
            </div>
          )}

          {/* Round Off */}
          {roundOff !== 0 && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Round Off</span>
              <span className="font-tabular text-muted-foreground">{roundOff > 0 ? '+' : ''}{roundOff.toFixed(2)}</span>
            </div>
          )}

          {/* Grand Total */}
          <div className="border-t-2 border-border pt-2 flex justify-between">
            <span className="font-bold text-foreground">Grand Total</span>
            <span className="text-xl font-bold text-primary font-tabular">₹{Math.round(finalTotal).toLocaleString('en-IN')}</span>
          </div>

          {fineWeightDue > 0 && (
            <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <div className="flex justify-between gap-3">
                <span className="font-semibold">Silver fine due</span>
                <span className="font-bold font-tabular">{fineWeightDue.toFixed(3)} g</span>
              </div>
              <p className="mt-1 text-[11px]">
                Silver value is not charged now. It will be settled later by silver received or cash at that day&apos;s silver rate.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Payment */}
      <div className="jewel-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-foreground">Payment</h3>
          <button onClick={addPaymentRow} className="text-xs text-primary hover:underline">+ Add Mode</button>
        </div>

        <div className="space-y-2 mb-3">
          {payments.map((pmt) => (
            <div key={pmt.id} className="flex items-center gap-2">
              <select
                value={pmt.mode}
                onChange={(e) => updatePayment(pmt.id, 'mode', e.target.value)}
                className="input-field text-xs py-1.5 w-32 flex-shrink-0"
              >
                {(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Credit'] as PaymentMode[]).map((m) => (
                  <option key={`mode-${pmt.id}-${m}`} value={m}>{m}</option>
                ))}
              </select>
              <div className="relative flex-1">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                <input
                  type="number"
                  value={pmt.amount || ''}
                  onChange={(e) => updatePayment(pmt.id, 'amount', parseFloat(e.target.value) || 0)}
                  placeholder="0"
                  className="input-field text-xs py-1.5 pl-5 font-tabular"
                  min={0}
                />
              </div>
              {payments.length > 1 && (
                <button onClick={() => removePayment(pmt.id)} className="text-muted-foreground hover:text-red-500 transition-colors">
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        {/* Received vs Pending */}
        <div className="space-y-1.5 pt-2 border-t border-border">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Amount Received</span>
            <span className="font-tabular font-semibold text-emerald-600">₹{totalReceived.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="font-semibold text-foreground">Pending Amount</span>
            <span className={`font-tabular font-bold text-lg ${pendingAmount > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
              ₹{Math.max(0, Math.round(pendingAmount)).toLocaleString('en-IN')}
            </span>
          </div>
        </div>
      </div>

      {/* Notes */}
      <div className="jewel-card p-4">
        <label className="text-xs font-semibold text-muted-foreground block mb-1.5">Estimate Notes</label>
        <textarea
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder="Add notes for this estimate..."
          rows={2}
          className="input-field text-xs resize-none"
        />
      </div>

      {/* Save Button */}
      {saved ? (
        <div className="jewel-card p-4 bg-emerald-50 border-emerald-200 text-center">
          <CheckCircle size={20} className="text-emerald-600 mx-auto mb-1" />
          <p className="text-sm font-semibold text-emerald-700">Estimate Saved!</p>
          <p className="text-xs text-emerald-600">{savedInvoiceNumber} · SKUs marked as Sold</p>
          <div className="flex gap-2 mt-3">
            <Link href={`/estimate?id=${savedInvoiceNumber}`} className="btn-primary flex-1 py-2 text-xs justify-center">View Estimate</Link>
            <button onClick={handleNewSale} className="btn-secondary flex-1 py-2 text-xs justify-center">New Sale</button>
          </div>
        </div>
      ) : (
        <button
          onClick={handleSave}
          disabled={saving || itemCount === 0}
          className="btn-primary w-full justify-center py-3 text-sm"
        >
          {saving ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Saving Estimate...
            </>
          ) : (
            <>
              <CheckCircle size={16} />
              Save Estimate · ₹{Math.round(finalTotal).toLocaleString('en-IN')}
            </>
          )}
        </button>
      )}

      {!customer && itemCount > 0 && (
        <p className="text-xs text-amber-600 text-center">
          No customer selected — will be saved as Walk-in Customer
        </p>
      )}
    </div>
  );
}
