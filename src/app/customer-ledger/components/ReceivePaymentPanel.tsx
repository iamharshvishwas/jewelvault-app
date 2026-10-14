'use client';
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { X, Loader2, CheckCircle } from 'lucide-react';
import type { Customer, Invoice } from '@/lib/mockData';
import { recordPayment, settleSilverFine } from '@/lib/appStore';

interface ReceivePaymentPanelProps {
  customer: Customer;
  invoices: Invoice[];
  onClose: () => void;
}

interface PaymentFormData {
  paymentType: 'Amount' | 'Fine Silver' | 'Fine Cash';
  amount: number;
  fineGrams: number;
  silverRate: number;
  mode: string;
  reference: string;
  notes: string;
  invoiceId: string;
}

export default function ReceivePaymentPanel({ customer, invoices, onClose }: ReceivePaymentPanelProps) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedAmount, setSavedAmount] = useState(0);
  const [savedFine, setSavedFine] = useState(0);
  const [savedKind, setSavedKind] = useState<'Amount' | 'Fine Silver' | 'Fine Cash'>('Amount');

  const pendingInvoices = invoices.filter((inv) => inv.pendingAmount > 0 || (inv.fineWeightPending ?? 0) > 0);

  const { register, handleSubmit, formState: { errors }, watch } = useForm<PaymentFormData>({
    defaultValues: {
      paymentType: 'Amount',
      amount: customer.outstanding > 0 ? customer.outstanding : 0,
      fineGrams: customer.outstandingSilverFine > 0 ? customer.outstandingSilverFine : 0,
      silverRate: 0,
      mode: 'UPI',
      reference: '',
      notes: '',
      invoiceId: pendingInvoices[0]?.id ?? '',
    },
  });

  const amount = watch('amount');
  const paymentType = watch('paymentType');
  const fineGrams = Number(watch('fineGrams') || 0);
  const silverRate = Number(watch('silverRate') || 0);

  const onSubmit = async (data: PaymentFormData) => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 400));

    if (data.paymentType === 'Amount') {
      recordPayment(
        customer.id,
        {
          mode: data.mode as Invoice['payments'][0]['mode'],
          amount: Number(data.amount),
          date: new Date().toISOString(),
          reference: data.reference,
          notes: data.notes,
        },
        data.invoiceId || undefined
      );
      setSavedAmount(Number(data.amount));
      setSavedFine(0);
    } else {
      settleSilverFine(
        customer.id,
        Number(data.fineGrams),
        data.paymentType === 'Fine Cash' ? 'Cash' : 'Silver',
        data.paymentType === 'Fine Cash' ? Number(data.silverRate) : undefined,
        data.invoiceId || undefined
      );
      setSavedAmount(data.paymentType === 'Fine Cash' ? Number(data.fineGrams) * Number(data.silverRate) : 0);
      setSavedFine(Number(data.fineGrams));
    }
    setSavedKind(data.paymentType);
    setSaving(false);
    setSaved(true);
  };

  return (
    <div className="jewel-card p-5 border-2 border-primary/20 bg-gold-subtle slide-up">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-foreground">Receive Payment — {customer.name}</h3>
        <button onClick={onClose} className="btn-ghost p-1.5">
          <X size={16} />
        </button>
      </div>

      {saved ? (
        <div className="text-center py-4">
          <CheckCircle size={24} className="text-emerald-600 mx-auto mb-2" />
          <p className="font-semibold text-foreground">Payment Recorded</p>
          {savedKind === 'Amount' ? (
            <>
              <p className="text-xs text-muted-foreground mt-1">
                ₹{savedAmount.toLocaleString('en-IN')} received from {customer.name}
              </p>
              <p className="text-xs text-muted-foreground">
                Remaining amount outstanding: ₹{Math.max(0, customer.outstanding - savedAmount).toLocaleString('en-IN')}
              </p>
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground mt-1">
                {savedFine.toFixed(3)} g silver fine settled for {customer.name}
              </p>
              {savedKind === 'Fine Cash' && (
                <p className="text-xs text-muted-foreground">Cash equivalent: ₹{Math.round(savedAmount).toLocaleString('en-IN')}</p>
              )}
              <p className="text-xs text-muted-foreground">
                Remaining silver fine: {Math.max(0, (customer.outstandingSilverFine ?? 0) - savedFine).toFixed(3)} g
              </p>
            </>
          )}
          <button onClick={onClose} className="btn-secondary mt-3 py-2 text-xs">Close</button>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="sm:col-span-2">
              <label className="text-xs font-semibold text-foreground block mb-1.5">Settlement Type</label>
              <select {...register('paymentType')} className="input-field">
                <option value="Amount">Amount Payment</option>
                <option value="Fine Silver">Silver Fine Received</option>
                <option value="Fine Cash">Silver Fine Settled by Cash Rate</option>
              </select>
            </div>

            {paymentType === 'Amount' ? (
            <>
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">
                Amount (₹) <span className="text-red-500">*</span>
              </label>
              <p className="text-xs text-muted-foreground mb-1.5">Outstanding: ₹{customer.outstanding.toLocaleString('en-IN')}</p>
              <input
                type="number"
                {...register('amount', { required: 'Amount is required', min: { value: 1, message: 'Amount must be greater than 0' } })}
                className="input-field font-tabular text-lg font-bold"
                step={0.01}
                min={0}
              />
              {errors.amount && <p className="text-xs text-red-500 mt-1">{errors.amount.message}</p>}
            </div>

            {/* Payment Mode */}
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">
                Payment Mode <span className="text-red-500">*</span>
              </label>
              <select
                {...register('mode', { required: true })}
                className="input-field"
              >
                {['Cash', 'UPI', 'Card', 'Bank Transfer', 'Credit', 'Other'].map((m) => (
                  <option key={`pmmode-${m}`} value={m}>{m}</option>
                ))}
              </select>
            </div>
            </>
            ) : (
            <>
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">
                Fine Grams <span className="text-red-500">*</span>
              </label>
              <p className="text-xs text-muted-foreground mb-1.5">Fine pending: {(customer.outstandingSilverFine ?? 0).toFixed(3)} g</p>
              <input
                type="number"
                {...register('fineGrams', { required: 'Fine grams are required', min: { value: 0.001, message: 'Fine grams must be greater than 0' } })}
                className="input-field font-tabular text-lg font-bold"
                step={0.001}
                min={0}
              />
              {errors.fineGrams && <p className="text-xs text-red-500 mt-1">{errors.fineGrams.message}</p>}
            </div>

            {paymentType === 'Fine Cash' && (
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Silver Rate / g <span className="text-red-500">*</span>
                </label>
                <p className="text-xs text-muted-foreground mb-1.5">
                  Cash equivalent: ₹{Math.round(fineGrams * silverRate).toLocaleString('en-IN')}
                </p>
                <input
                  type="number"
                  {...register('silverRate', { required: 'Silver rate is required', min: { value: 1, message: 'Silver rate must be greater than 0' } })}
                  className="input-field font-tabular text-lg font-bold"
                  step={0.01}
                  min={0}
                />
                {errors.silverRate && <p className="text-xs text-red-500 mt-1">{errors.silverRate.message}</p>}
              </div>
            )}
            </>
            )}

            {/* Reference */}
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">Reference / UTR</label>
              <p className="text-xs text-muted-foreground mb-1.5">UPI transaction ID, cheque number, etc.</p>
              <input
                type="text"
                {...register('reference')}
                placeholder="e.g. UPI-9923411"
                className="input-field font-mono"
              />
            </div>

            {/* Against Invoice */}
            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">Against Invoice</label>
              <p className="text-xs text-muted-foreground mb-1.5">Leave blank to apply to oldest outstanding</p>
              <select {...register('invoiceId')} className="input-field">
                <option value="">— Apply to oldest outstanding —</option>
                {pendingInvoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoiceNumber} · ₹{inv.pendingAmount.toLocaleString('en-IN')} · {(inv.fineWeightPending ?? 0).toFixed(3)} g fine
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-semibold text-foreground block mb-1.5">Notes</label>
            <textarea
              {...register('notes')}
              rows={2}
              placeholder="Additional notes..."
              className="input-field resize-none text-sm"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-3">
            <button type="submit" disabled={saving} className="btn-primary flex-1 justify-center py-2.5">
              {saving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Recording...
                </>
              ) : (
                <>
                  <CheckCircle size={15} />
                  {paymentType === 'Amount'
                    ? `Record Payment · ₹${Number(amount || 0).toLocaleString('en-IN')}`
                    : `Settle Fine · ${fineGrams.toFixed(3)} g`}
                </>
              )}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary py-2.5">Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}
