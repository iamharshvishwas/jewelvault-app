'use client';
import React, { useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle, Loader2 } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import type { Customer, Invoice, InvoiceItem, Payment } from '@/lib/mockData';
import {
  MAX_PAYMENT_ROWS,
  PAYMENT_MODES,
  billSaveFailure,
  buildBillBody,
  inr,
  isPan,
  normalisePan,
  paymentsTotal,
  savedBillFrom,
  signedRupees,
  type BillPreview,
  type BillingItem,
  type PaymentEntry,
  type PaymentMode,
  type SaleType,
  type SaveFailure,
  type SavedBill,
} from '@/lib/billing';
import {
  addInvoice,
  getInvoiceById,
  getNextInvoiceNumber,
  saveBill,
  saveCustomerPan,
} from '@/lib/appStore';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { updateSkuStatus } from '@/lib/designStore';
import { PREVIEW_MODE } from '@/lib/previewMode';
import { formatGrams, formatRupees } from '@/lib/pricing';

interface BillingSummaryPanelProps {
  /** The live figures from pricing.ts (C12). */
  preview: BillPreview;
  discount: string;
  onDiscountChange: (v: string) => void;
  additionalCharges: string;
  onAdditionalChargesChange: (v: string) => void;
  customer: Customer | null;
  notes: string;
  onNotesChange: (v: string) => void;
  items: BillingItem[];
  invoiceNumber: string;
  saleType: SaleType;
  invoiceDate: string;
  /** The signed-in role: only the owner may give a reason for cash over the limit (Z1). */
  role: string | null;
  /** C12: the API's pricing.ts is this build's. Save on bills is off while it is not. */
  billsAllowed: boolean;
  /** WEB16: a rate used on the bill is not confirmed today and the question has not been answered: the first bill of the day waits for it. */
  rateGuardOpen?: boolean;
  /** A save is on its way, or the bill is saved: nothing can be changed. */
  locked: boolean;
  saved: SavedBill | null;
  onBusyChange: (busy: boolean) => void;
  onSaved: (saved: SavedBill) => void;
  onProblemPieces: (skuIds: string[]) => void;
  onNewSale: () => void;
}

interface PanState {
  stage: 'asking' | 'saving' | 'done' | 'skipped';
  value: string;
  error: string | null;
}

const PAN_HELP =
  'A PAN is ten characters: five capital letters, four digits and one capital letter, for example ABCDE1234F.';

const rupeesOf = (paise: number) => Number(formatRupees(paise));

export default function BillingSummaryPanel({
  preview,
  discount,
  onDiscountChange,
  additionalCharges,
  onAdditionalChargesChange,
  customer,
  notes,
  onNotesChange,
  items,
  invoiceNumber,
  saleType,
  invoiceDate,
  role,
  billsAllowed,
  rateGuardOpen = false,
  locked,
  saved,
  onBusyChange,
  onSaved,
  onProblemPieces,
  onNewSale,
}: BillingSummaryPanelProps) {
  const [payments, setPayments] = useState<PaymentEntry[]>([
    { id: 'pmt-1', mode: 'UPI', amount: '' },
  ]);
  const nextPaymentNumber = useRef(2);
  const [cashReason, setCashReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<SaveFailure | null>(null);
  const [pan, setPan] = useState<PanState>({ stage: 'asking', value: '', error: null });
  // C6: a second click before the first answer is ignored. The ref answers at once, before the button has been drawn disabled.
  const inFlight = useRef(false);
  const panInFlight = useRef(false);
  // the bill's own figures (V1) arrive with the poll that follows the save; the link to the estimate waits for them
  useRowCacheVersion('bills', 'bill-summary');

  const itemCount = items.length;
  const bill = preview.bill;
  const shown = saved
    ? {
        subtotal: saved.subtotal,
        discount: saved.discount,
        additional: saved.additionalCharges,
        roundOff: saved.roundOff,
        grand: saved.grandTotal,
        fineMg: saved.fineWeightDueMg,
      }
    : bill
      ? {
          subtotal: bill.subtotalPaise,
          discount: bill.discountPaise,
          additional: bill.additionalChargesPaise,
          roundOff: bill.roundOffPaise,
          grand: bill.grandTotalPaise,
          fineMg: bill.fineWeightDueMg,
        }
      : itemCount === 0
        ? { subtotal: 0, discount: 0, additional: 0, roundOff: 0, grand: 0, fineMg: 0 }
        : null;

  const typedPaid = paymentsTotal(payments);
  const received = saved ? saved.received : typeof typedPaid === 'number' ? typedPaid : 0;
  const pending = saved ? saved.pending : shown ? Math.max(0, shown.grand - received) : null;
  const overpaid = !saved && shown !== null && received > shown.grand;

  const addPaymentRow = () => {
    const id = `pmt-${nextPaymentNumber.current}`;
    nextPaymentNumber.current += 1;
    setPayments((prev) => [...prev, { id, mode: 'Cash', amount: '' }]);
  };

  const updatePayment = (id: string, field: 'mode' | 'amount', value: string) => {
    setPayments((prev) => prev.map((p) => (p.id === id ? { ...p, [field]: value } : p)));
  };

  const removePayment = (id: string) => {
    setPayments((prev) => prev.filter((p) => p.id !== id));
  };

  /** The prototype's own save, for the preview build only: no server, the piece goes Sold at once, the invoice is kept in this page. */
  const saveInPreview = () => {
    if (!bill) return;
    const now = invoiceDate
      ? new Date(`${invoiceDate}T12:00:00`).toISOString()
      : new Date().toISOString();
    const invNumber = invoiceNumber || getNextInvoiceNumber();
    const invoiceItems: InvoiceItem[] = items.map((item, index) => {
      const priced = preview.lines[index].priced;
      return {
        id: `iitem-${item.sku.id}`,
        designNumber: item.sku.designNumber,
        skuNumber: item.sku.skuNumber,
        material: item.sku.material,
        purity: item.sku.purity,
        grossWeight: item.sku.grossWeight,
        customerNetWeight: item.sku.customerNetWeight,
        metalRate: Number(item.metalRate) || 0,
        labour: rupeesOf(priced?.labourAmountPaise ?? 0),
        piroi: Number(item.piroi) || 0,
        otherCharges: Number(item.otherCharges) || 0,
        metalAmount: rupeesOf(priced?.metalAmountPaise ?? 0),
        fineWeightDue: Number(formatGrams(priced?.fineWeightDueMg ?? 0)),
        itemTotal: rupeesOf(priced?.itemTotalPaise ?? 0),
        sellingMethod: item.sku.sellingMethod,
        imageRef: '',
        category: item.sku.category,
        taxRate: 0,
        taxAmount: 0,
      };
    });
    const invoicePayments: Payment[] = payments
      .filter((p) => (Number(p.amount) || 0) > 0)
      .map((p) => ({
        id: `pmt-${p.id}-${crypto.randomUUID()}`,
        mode: p.mode,
        amount: Number(p.amount) || 0,
        date: now,
        reference: '',
        notes: '',
      }));
    const amountReceived = invoicePayments.reduce((a, p) => a + p.amount, 0);
    const grand = rupeesOf(bill.grandTotalPaise);
    const fineDue = Number(formatGrams(bill.fineWeightDueMg));
    const pendingAmt = Math.max(0, grand - amountReceived);
    const status: Invoice['status'] =
      pendingAmt <= 0 && fineDue <= 0 ? 'Paid' : amountReceived > 0 ? 'Partial' : 'Pending';
    const invoice: Invoice = {
      id: `inv-${crypto.randomUUID()}`,
      invoiceNumber: invNumber,
      customerId: customer?.id ?? 'walk-in',
      customerName: customer?.name ?? 'Walk-in Customer',
      customerMobile: customer?.mobile ?? '',
      items: invoiceItems,
      payments: invoicePayments,
      subtotal: rupeesOf(bill.subtotalPaise),
      discount: rupeesOf(bill.discountPaise),
      discountPercent: bill.subtotalPaise > 0 ? (bill.discountPaise / bill.subtotalPaise) * 100 : 0,
      additionalCharges: rupeesOf(bill.additionalChargesPaise),
      gst: 0,
      gstPercent: 0,
      roundOff: rupeesOf(bill.roundOffPaise),
      grandTotal: grand,
      amountReceived,
      pendingAmount: pendingAmt,
      status,
      saleType,
      fineWeightDue: fineDue,
      fineWeightSettled: 0,
      fineWeightPending: fineDue,
      amountDue: grand,
      date: now,
      createdBy: 'Staff',
      notes: `[${saleType} Estimate]${notes ? ` ${notes}` : ''}`,
    };
    for (const item of items) updateSkuStatus(item.sku.id, 'Sold');
    addInvoice(invoice);
    onSaved({
      billId: invoice.id,
      billNo: invNumber,
      customerId: invoice.customerId,
      customerName: invoice.customerName,
      billDate: invoiceDate,
      saleType,
      subtotal: bill.subtotalPaise,
      discount: bill.discountPaise,
      additionalCharges: bill.additionalChargesPaise,
      roundOff: bill.roundOffPaise,
      grandTotal: bill.grandTotalPaise,
      fineWeightDueMg: bill.fineWeightDueMg,
      lines: items.map((item, index) => ({
        skuId: item.sku.id,
        skuNo: item.sku.skuNumber,
        metalAmount: preview.lines[index].priced?.metalAmountPaise ?? 0,
        labourAmount: preview.lines[index].priced?.labourAmountPaise ?? 0,
        fineWeightDueMg: preview.lines[index].priced?.fineWeightDueMg ?? 0,
        total: preview.lines[index].priced?.itemTotalPaise ?? 0,
      })),
      received: Math.round(amountReceived * 100),
      advanceApplied: 0,
      pending: Math.round(pendingAmt * 100),
      warnings: [],
      differences: [],
    });
  };

  // C5 (b): never optimistic. The screen shows a saving state, calls X1 with a fresh Idempotency-Key (the same key when this is the same bill pressed again after a call that did not
  // end well, C6, L5), and shows the bill as saved only from the API's answer, with the API's figures. On a failure it says why, in plain words, and changes nothing.
  const handleSave = async () => {
    if (inFlight.current || locked || itemCount === 0 || rateGuardOpen) return;
    if (PREVIEW_MODE) {
      saveInPreview();
      return;
    }
    const built = buildBillBody({
      customerId: customer?.id ?? null,
      saleType,
      billDate: invoiceDate,
      items,
      discount,
      additionalCharges,
      notes,
      payments,
      cashOverrideReason: role === 'owner' ? cashReason : '',
    });
    if ('error' in built) {
      setFailure({ message: built.error, cashLimit: null, pieceIds: [], unconfirmed: false });
      return;
    }
    inFlight.current = true;
    setSaving(true);
    onBusyChange(true);
    setFailure(null);
    onProblemPieces([]);
    try {
      const answer = await saveBill(built.body);
      onSaved(savedBillFrom(answer, preview, items, customer?.name ?? 'Walk-in Customer'));
    } catch (error) {
      const found = billSaveFailure(error, { role, walkIn: customer === null });
      setFailure(found);
      onProblemPieces(found.pieceIds);
    } finally {
      inFlight.current = false;
      setSaving(false);
      onBusyChange(false);
    }
  };

  // a new sale remounts this panel (BillingPOSClient keys it), so its payments, messages and prompts start afresh
  const handleNewSale = () => onNewSale();

  // Z3: the bill is saved either way; the PAN is asked for afterwards and written to the customer as an ordinary edit
  const handleSavePan = async () => {
    if (!saved || panInFlight.current) return;
    const value = normalisePan(pan.value);
    if (!isPan(value)) {
      setPan({ stage: 'asking', value: pan.value, error: PAN_HELP });
      return;
    }
    panInFlight.current = true;
    setPan({ stage: 'saving', value, error: null });
    try {
      await saveCustomerPan(saved.customerId, value);
      setPan({ stage: 'done', value, error: null });
    } catch (error) {
      setPan({
        stage: 'asking',
        value,
        error: error instanceof Error ? error.message : 'The PAN could not be saved.',
      });
    } finally {
      panInFlight.current = false;
    }
  };

  const askForPan = saved !== null && saved.warnings.includes('PAN_MISSING');
  const invoiceReady = saved !== null && getInvoiceById(saved.billId) !== undefined;
  const reasonShown = (failure?.cashLimit?.ownerMayGiveReason ?? false) || cashReason !== '';
  // no bill total (a line cannot be priced, a figure is not a number) means nothing can be saved; the reason is under the button
  const saveDisabled =
    saving || locked || itemCount === 0 || !billsAllowed || rateGuardOpen || preview.bill === null;

  return (
    <div className="space-y-3 sticky top-4">
      <fieldset disabled={locked} className="space-y-3 min-w-0">
        {/* Bill Summary */}
        <div className="jewel-card p-4">
          <h3 className="text-sm font-semibold text-foreground mb-1">Estimate Summary</h3>
          <p className="text-xs text-muted-foreground mb-4">
            No GST is added. This is an estimate only.
          </p>

          <div className="space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Subtotal ({itemCount} items)</span>
              <span data-testid="subtotal" className="font-tabular font-semibold text-foreground">
                {shown ? inr(shown.subtotal) : '-'}
              </span>
            </div>

            {/* Discount */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Discount</span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">₹</span>
                <input
                  type="number"
                  aria-label="Discount"
                  value={saved ? formatRupees(saved.discount) : discount}
                  placeholder="0"
                  onChange={(e) => onDiscountChange(e.target.value)}
                  className="input-field w-24 text-xs py-1 text-right font-tabular"
                  min={0}
                  step={100}
                />
              </div>
            </div>

            {shown && shown.discount > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">After Discount</span>
                <span className="font-tabular text-foreground">
                  {inr(shown.subtotal - shown.discount)}
                </span>
              </div>
            )}

            {/* Additional Charges */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">Add. Charges</span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">₹</span>
                <input
                  type="number"
                  aria-label="Additional charges"
                  value={saved ? formatRupees(saved.additionalCharges) : additionalCharges}
                  placeholder="0"
                  onChange={(e) => onAdditionalChargesChange(e.target.value)}
                  className="input-field w-24 text-xs py-1 text-right font-tabular"
                  min={0}
                />
              </div>
            </div>

            {/* Round Off */}
            {shown && shown.roundOff !== 0 && (
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Round Off</span>
                <span data-testid="round-off" className="font-tabular text-muted-foreground">
                  {signedRupees(shown.roundOff)}
                </span>
              </div>
            )}

            {/* Grand Total */}
            <div className="border-t-2 border-border pt-2 flex justify-between">
              <span className="font-bold text-foreground">Grand Total</span>
              <span
                data-testid="grand-total"
                data-source={saved ? 'saved' : 'preview'}
                className="text-xl font-bold text-primary font-tabular"
              >
                {shown ? inr(shown.grand, false) : '-'}
              </span>
            </div>

            {shown && shown.fineMg > 0 && (
              <div className="rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <div className="flex justify-between gap-3">
                  <span className="font-semibold">Silver fine due</span>
                  <span className="font-bold font-tabular">{formatGrams(shown.fineMg)} g</span>
                </div>
                <p className="mt-1 text-[11px]">
                  Silver value is not charged now. It will be settled later by silver received or
                  cash at that day&apos;s silver rate.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Payment */}
        <div className="jewel-card p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground">Payment</h3>
            {payments.length < MAX_PAYMENT_ROWS && (
              <button
                type="button"
                onClick={addPaymentRow}
                className="text-xs text-primary hover:underline"
              >
                + Add Mode
              </button>
            )}
          </div>

          <div className="space-y-2 mb-3">
            {payments.map((pmt, index) => (
              <div key={pmt.id} className="flex items-center gap-2">
                <select
                  aria-label={`Payment mode ${index + 1}`}
                  value={pmt.mode}
                  onChange={(e) => updatePayment(pmt.id, 'mode', e.target.value as PaymentMode)}
                  className="input-field text-xs py-1.5 flex-shrink-0"
                  style={{ width: '8rem' }}
                >
                  {PAYMENT_MODES.map((m) => (
                    <option key={`mode-${pmt.id}-${m}`} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <div className="relative flex-1">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    ₹
                  </span>
                  <input
                    type="number"
                    aria-label={`Payment amount ${index + 1}`}
                    value={saved ? '' : pmt.amount}
                    onChange={(e) => updatePayment(pmt.id, 'amount', e.target.value)}
                    placeholder="0"
                    className="input-field text-xs py-1.5 pl-5 font-tabular"
                    min={0}
                  />
                </div>
                {payments.length > 1 && (
                  <button
                    type="button"
                    aria-label={`Remove payment ${index + 1}`}
                    onClick={() => removePayment(pmt.id)}
                    className="text-muted-foreground hover:text-red-500 transition-colors"
                  >
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
              <span data-testid="received" className="font-tabular font-semibold text-emerald-600">
                {inr(received, received % 100 !== 0)}
              </span>
            </div>
            {saved && saved.advanceApplied > 0 && (
              <p data-testid="advance-adjusted" className="text-sm font-semibold text-emerald-700">
                Advance adjusted: {inr(saved.advanceApplied, saved.advanceApplied % 100 !== 0)}
              </p>
            )}
            <div className="flex justify-between text-sm">
              <span className="font-semibold text-foreground">Pending Amount</span>
              <span
                data-testid="pending"
                className={`font-tabular font-bold text-lg ${
                  pending !== null && pending > 0 ? 'text-amber-600' : 'text-emerald-600'
                }`}
              >
                {pending === null ? '-' : inr(pending, pending % 100 !== 0)}
              </span>
            </div>
            {overpaid && (
              <p data-testid="overpaid" className="text-xs font-semibold text-red-600">
                The payments are more than the bill. Lower a payment before saving.
              </p>
            )}
            {typeof typedPaid === 'string' && (
              <p className="text-xs font-semibold text-red-600">{typedPaid}</p>
            )}
          </div>
        </div>

        {/* Notes */}
        <div className="jewel-card p-4">
          <label className="text-xs font-semibold text-muted-foreground block mb-1.5">
            Estimate Notes
            <textarea
              value={notes}
              onChange={(e) => onNotesChange(e.target.value)}
              placeholder="Add notes for this estimate..."
              rows={2}
              className="input-field text-xs resize-none mt-1.5 font-normal"
            />
          </label>
        </div>
      </fieldset>

      {/* Z1: the owner may give a reason for cash over the limit; a biller cannot, the owner enters that payment */}
      {!saved && reasonShown && (
        <div className="jewel-card p-4">
          <label className="text-xs font-semibold text-muted-foreground block">
            Reason for cash over the limit (owner)
            <textarea
              data-testid="cash-reason"
              value={cashReason}
              onChange={(e) => setCashReason(e.target.value)}
              placeholder="At least 10 characters"
              rows={2}
              disabled={saving}
              className="input-field text-xs resize-none mt-1.5 font-normal"
            />
          </label>
        </div>
      )}

      {/* Save Button */}
      {saved ? (
        <div
          data-testid="bill-saved"
          className="jewel-card p-4 bg-emerald-50 border-emerald-200 text-center"
        >
          <CheckCircle size={20} className="text-emerald-600 mx-auto mb-1" />
          <p className="text-sm font-semibold text-emerald-700">Estimate Saved!</p>
          <p className="text-xs text-emerald-600">
            <span data-testid="saved-bill-no">{saved.billNo}</span> ·{' '}
            {saved.lines.length === 1 ? 'SKU' : 'SKUs'} marked as Sold
          </p>
          {saved.differences.length > 0 && (
            <div
              role="status"
              data-testid="figures-differ"
              className="mt-3 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800"
            >
              <p className="font-semibold">
                The saved bill is not the same as the preview. The figures shown are the saved ones.
              </p>
              <ul className="mt-1 list-disc pl-4">
                {saved.differences.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
          {saved.warnings.includes('RATE_MISSING') && (
            <p
              data-testid="warning-rate-missing"
              className="mt-3 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800"
            >
              There is no daily rate for one of the metals on this date. The rate you entered was
              used.
            </p>
          )}
          {saved.warnings.includes('RATE_STALE') && (
            <p
              data-testid="warning-rate-stale"
              className="mt-3 rounded-sm border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800"
            >
              The daily rate for one of the metals is older than the date of the bill.
            </p>
          )}
          {askForPan && pan.stage !== 'skipped' && pan.stage !== 'done' && (
            <div
              data-testid="pan-prompt"
              className="mt-3 rounded-sm border border-amber-200 bg-amber-50 px-3 py-3 text-left text-xs text-amber-900"
            >
              <p className="font-semibold">
                PAN needed: this bill is ₹2,00,000 or more and {saved.customerName} has no PAN on
                file.
              </p>
              <input
                aria-label="PAN"
                value={pan.value}
                maxLength={12}
                disabled={pan.stage === 'saving'}
                onChange={(e) => setPan({ stage: 'asking', value: e.target.value, error: null })}
                placeholder="ABCDE1234F"
                className="input-field mt-2 text-xs font-mono uppercase"
              />
              {pan.error && (
                <p role="alert" data-testid="pan-error" className="mt-1 text-red-600">
                  {pan.error}
                </p>
              )}
              <div className="mt-2 flex gap-2">
                <SaveButton
                  type="button"
                  onClick={handleSavePan}
                  disabled={pan.stage === 'saving'}
                  className="btn-primary py-1.5 text-xs"
                >
                  {pan.stage === 'saving' ? 'Saving…' : 'Save PAN'}
                </SaveButton>
                <button
                  type="button"
                  onClick={() => setPan((p) => ({ ...p, stage: 'skipped' }))}
                  disabled={pan.stage === 'saving'}
                  className="btn-ghost py-1.5 text-xs"
                >
                  Skip
                </button>
              </div>
              <p className="mt-1 text-[11px]">
                The bill is saved either way. A customer without a PAN can give a declaration on
                paper.
              </p>
            </div>
          )}
          {askForPan && pan.stage === 'done' && (
            <p data-testid="pan-saved" className="mt-3 text-xs font-semibold text-emerald-700">
              PAN saved for {saved.customerName}.
            </p>
          )}
          <div className="flex gap-2 mt-3">
            {invoiceReady ? (
              <Link
                href={`/estimate?id=${saved.billId}`}
                className="btn-primary flex-1 py-2 text-xs justify-center"
              >
                View Estimate
              </Link>
            ) : (
              <span
                aria-busy="true"
                className="btn-primary flex-1 py-2 text-xs justify-center opacity-60"
              >
                View Estimate
              </span>
            )}
            <button
              type="button"
              onClick={handleNewSale}
              className="btn-secondary flex-1 py-2 text-xs justify-center"
            >
              New Sale
            </button>
          </div>
        </div>
      ) : (
        <>
          {failure && (
            <div
              role="alert"
              data-testid="bill-save-error"
              className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
            >
              {failure.message}
            </div>
          )}
          <SaveButton
            type="button"
            data-testid="save-bill"
            onClick={handleSave}
            disabled={saveDisabled}
            title={
              billsAllowed
                ? undefined
                : 'This page and the server do not work out bills the same way'
            }
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
                Save Estimate{shown && bill ? ` · ${inr(shown.grand, false)}` : ''}
              </>
            )}
          </SaveButton>
          {rateGuardOpen && (
            <p data-testid="rate-guard-hold" className="text-xs text-amber-700 text-center">
              Confirm today&apos;s rate above, or choose Bill without confirming.
            </p>
          )}
          {itemCount > 0 && preview.error && (
            <p data-testid="preview-error" className="text-xs text-red-600 text-center">
              {preview.error}
            </p>
          )}
          {!customer && itemCount > 0 && (
            <p className="text-xs text-amber-600 text-center">
              No customer selected — will be saved as Walk-in Customer
            </p>
          )}
        </>
      )}
    </div>
  );
}
