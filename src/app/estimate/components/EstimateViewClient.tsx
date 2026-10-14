'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Printer, ArrowLeft, Search, FileText, Pencil, Save, X } from 'lucide-react';
import { getInvoiceById, getInvoices, updateInvoice, updateInvoiceDate } from '@/lib/appStore';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import type { CustomerType, Invoice } from '@/lib/mockData';

const STATUS_COLORS: Record<Invoice['status'], string> = {
  Paid: 'status-badge-instock',
  Partial: 'status-badge-reserved',
  Pending: 'status-badge-approval',
  Cancelled: 'status-badge-archived',
};

type EstimateFilter = 'All' | 'Received' | 'Partial' | 'Pending';

function dateInputValue(date: string) {
  const parsed = date ? new Date(date) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function pendingDays(invoice: Invoice) {
  const hasPending = invoice.pendingAmount > 0 || (invoice.fineWeightPending ?? 0) > 0;
  if (!hasPending || invoice.status === 'Cancelled') return 0;
  const parsed = new Date(invoice.date);
  if (Number.isNaN(parsed.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000));
}

function displayDate(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString('en-IN');
}

function displayDateTime(date: string) {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('en-IN');
}

function labourPerGram(invoiceItem: Invoice['items'][number]) {
  if (invoiceItem.customerNetWeight <= 0) return 0;
  return invoiceItem.labour / invoiceItem.customerNetWeight;
}

function recalculateEstimateDraft(invoice: Invoice): Invoice {
  const items = invoice.items.map((item) => {
    const metalAmount =
      (item.fineWeightDue ?? 0) > 0
        ? 0
        : item.sellingMethod === 'By Weight'
          ? item.customerNetWeight * item.metalRate
          : item.metalRate;
    const itemTotal = metalAmount + item.labour + item.piroi + item.otherCharges;
    return { ...item, metalAmount, itemTotal, taxRate: 0, taxAmount: 0 };
  });
  const subtotal = items.reduce((total, item) => total + item.itemTotal, 0);
  const grandTotal = Math.max(0, Math.round(subtotal - invoice.discount + invoice.additionalCharges));
  const amountReceived = invoice.payments.reduce((total, payment) => total + payment.amount, 0);
  const fineWeightDue = items.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled = Math.min(invoice.fineWeightSettled ?? 0, fineWeightDue);
  const fineWeightPending = Math.max(0, fineWeightDue - fineWeightSettled);
  const pendingAmount = Math.max(0, grandTotal - amountReceived);
  return {
    ...invoice,
    items,
    subtotal,
    discountPercent: subtotal > 0 ? (invoice.discount / subtotal) * 100 : 0,
    gst: 0,
    gstPercent: 0,
    roundOff: 0,
    grandTotal,
    amountReceived,
    pendingAmount,
    fineWeightDue,
    fineWeightSettled,
    fineWeightPending,
    amountDue: grandTotal,
    status: pendingAmount <= 0 && fineWeightPending <= 0 ? 'Paid' : amountReceived > 0 || fineWeightSettled > 0 ? 'Partial' : 'Pending',
  };
}

export default function EstimateViewClient() {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get('id') || '';
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<EstimateFilter>('All');
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Invoice | null>(null);

  useEffect(() => {
    const interval = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const invoices = getInvoices();
  void tick;
  const invoice = invoiceId ? getInvoiceById(invoiceId) : undefined;
  const filteredInvoices = invoices.filter((inv) => {
    const haystack = `${inv.invoiceNumber} ${inv.customerName} ${inv.customerMobile} ${inv.status} ${inv.notes}`.toLowerCase();
    const matchesQuery = haystack.includes(query.toLowerCase());
    const matchesStatus =
      statusFilter === 'All' ||
      (statusFilter === 'Received' && inv.status === 'Paid') ||
      (statusFilter === 'Partial' && inv.status === 'Partial') ||
      (statusFilter === 'Pending' && inv.status === 'Pending');
    return matchesQuery && matchesStatus;
  });
  const handleDateChange = (id: string, date: string) => {
    try {
      updateInvoiceDate(id, date);
      setTick((value) => value + 1);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to update estimate date.');
    }
  };
  const startEditing = (source: Invoice) => {
    setDraft(JSON.parse(JSON.stringify(source)) as Invoice);
    setEditing(true);
  };
  const cancelEditing = () => {
    setDraft(null);
    setEditing(false);
  };
  const updateDraftField = <K extends keyof Invoice>(field: K, value: Invoice[K]) => {
    setDraft((current) => (current ? recalculateEstimateDraft({ ...current, [field]: value }) : current));
  };
  const updateDraftItem = (itemId: string, field: keyof Invoice['items'][number], value: string | number) => {
    setDraft((current) => {
      if (!current) return current;
      const items = current.items.map((item) => (item.id === itemId ? { ...item, [field]: value } : item));
      return recalculateEstimateDraft({ ...current, items });
    });
  };
  const updateDraftSaleType = (saleType: CustomerType) => {
    setDraft((current) => {
      if (!current) return current;
      const items = current.items.map((item) => ({
        ...item,
        fineWeightDue: saleType === 'Wholesale' && item.material === 'Silver' ? item.customerNetWeight : 0,
      }));
      return recalculateEstimateDraft({ ...current, saleType, items });
    });
  };
  const saveDraft = () => {
    if (!draft) return;
    try {
      const saved = updateInvoice(draft.id, recalculateEstimateDraft(draft));
      setDraft(saved);
      setEditing(false);
      setTick((value) => value + 1);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to save estimate.');
    }
  };

  if (!invoiceId) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Saved Estimates</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {invoices.length} estimate{invoices.length !== 1 ? 's' : ''} saved locally
            </p>
          </div>
          <Link href="/billing-pos" className="btn-primary py-2">
            <FileText size={15} />
            New Estimate
          </Link>
        </div>

        <section className="jewel-card overflow-hidden">
          <div className="p-4 border-b border-border flex flex-col lg:flex-row lg:items-center gap-3 justify-between">
            <div className="relative max-w-lg w-full">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="input-field pl-9"
                placeholder="Search estimate number, customer, mobile, status..."
              />
            </div>
            <div className="flex items-center bg-muted rounded-sm p-1 overflow-x-auto">
              {(['All', 'Received', 'Partial', 'Pending'] as EstimateFilter[]).map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setStatusFilter(filter)}
                  className={`px-3 py-1.5 rounded-sm text-xs font-semibold whitespace-nowrap ${
                    statusFilter === filter ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {filter}
                </button>
              ))}
            </div>
          </div>

          {filteredInvoices.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-semibold text-foreground">No estimates found</p>
              <p className="text-xs text-muted-foreground mt-1">Create an estimate from New Estimate first.</p>
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60 border-b border-border">
                    {['Estimate No.', 'Date', 'Customer', 'Items', 'Grand Total', 'Received', 'Pending', 'Status', ''].map((heading) => (
                      <th key={heading} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredInvoices.map((inv) => (
                    <tr key={inv.id} className="table-row-hover">
                      <td className="px-3 py-3">
                        <Link href={`/estimate?id=${inv.id}`} className="font-mono font-bold text-primary hover:underline">
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                        <input
                          type="date"
                          value={dateInputValue(inv.date)}
                          onChange={(event) => handleDateChange(inv.id, event.target.value)}
                          className="input-field w-36 py-1 text-xs"
                        />
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-semibold text-foreground">{inv.customerName}</p>
                        {inv.customerMobile && <p className="text-muted-foreground">{inv.customerMobile}</p>}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{inv.items.length}</td>
                      <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">₹{inv.grandTotal.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3 font-tabular font-semibold text-emerald-600 whitespace-nowrap">₹{inv.amountReceived.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3 font-tabular font-semibold whitespace-nowrap">
                        {inv.pendingAmount > 0 || (inv.fineWeightPending ?? 0) > 0 ? (
                          <div className="space-y-0.5">
                            {inv.pendingAmount > 0 && <p className="text-amber-600">₹{inv.pendingAmount.toLocaleString('en-IN')}</p>}
                            {(inv.fineWeightPending ?? 0) > 0 && <p className="text-amber-600">{inv.fineWeightPending?.toFixed(3)} g fine</p>}
                            <p className="text-[11px] text-muted-foreground">{pendingDays(inv)} day{pendingDays(inv) !== 1 ? 's' : ''} pending</p>
                          </div>
                        ) : <span className="text-emerald-600">Nil</span>}
                      </td>
                      <td className="px-3 py-3">
                        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[inv.status]}`}>
                          {inv.status}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <Link href={`/estimate?id=${inv.id}`} className="text-xs text-primary hover:underline font-semibold">View</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="jewel-card p-8 text-center">
        <h1 className="text-xl font-bold text-foreground">No Estimate Found</h1>
        <p className="text-sm text-muted-foreground mt-2">This estimate may have been deleted.</p>
        <Link href="/estimate" className="btn-primary mt-4 inline-flex">Back to Saved Estimates</Link>
      </div>
    );
  }

  const visibleInvoice = editing && draft ? draft : invoice;
  const isRetailSilverPrint =
    (visibleInvoice.saleType ?? 'Retail') === 'Retail' &&
    visibleInvoice.items.length > 0 &&
    visibleInvoice.items.every((item) => item.material === 'Silver');
  const showLabourPerGramOnPrint =
    visibleInvoice.saleType === 'Semi-Wholesale' || visibleInvoice.saleType === 'Wholesale';

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/estimate" className="btn-secondary py-2">
          <ArrowLeft size={15} />
          Saved Estimates
        </Link>
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <button onClick={saveDraft} className="btn-primary py-2">
                <Save size={15} />
                Save Changes
              </button>
              <button onClick={cancelEditing} className="btn-secondary py-2">
                <X size={15} />
                Cancel
              </button>
            </>
          ) : (
            <button onClick={() => startEditing(invoice)} className="btn-secondary py-2">
              <Pencil size={15} />
              Edit Estimate
            </button>
          )}
          <button onClick={() => window.print()} className="btn-primary py-2" disabled={editing}>
            <Printer size={15} />
            Print / Save PDF
          </button>
        </div>
      </div>

      <section className="print-estimate-sheet bg-white border border-border rounded-xl p-6 text-foreground">
        <div className="flex justify-between gap-4 border-b border-border pb-4">
          <div>
            <h1 className="text-2xl font-bold">{BUSINESS_NAME}</h1>
            <p className="text-sm text-muted-foreground">Estimate only. GST not charged.</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Estimate No.</p>
            <p className="font-mono font-bold text-primary">{visibleInvoice.invoiceNumber}</p>
            <input
              type="date"
              value={dateInputValue(visibleInvoice.date)}
              onChange={(event) =>
                editing
                  ? updateDraftField('date', new Date(`${event.target.value}T12:00:00`).toISOString())
                  : handleDateChange(visibleInvoice.id, event.target.value)
              }
              className="input-field w-36 py-1 text-xs mt-2 print:hidden"
            />
            <p className="text-xs text-muted-foreground mt-1 print:block hidden">{displayDateTime(visibleInvoice.date)}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 py-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Customer</p>
            {editing ? (
              <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  value={visibleInvoice.customerName}
                  onChange={(event) => updateDraftField('customerName', event.target.value)}
                  className="input-field py-1.5 text-xs"
                  placeholder="Customer name"
                />
                <input
                  value={visibleInvoice.customerMobile}
                  onChange={(event) => updateDraftField('customerMobile', event.target.value)}
                  className="input-field py-1.5 text-xs"
                  placeholder="Mobile"
                />
              </div>
            ) : (
              <>
                <p className="font-semibold">{visibleInvoice.customerName}</p>
                {visibleInvoice.customerMobile && <p className="text-sm text-muted-foreground">{visibleInvoice.customerMobile}</p>}
              </>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">{editing ? 'Sale Type' : 'Status'}</p>
            {editing ? (
              <select
                value={visibleInvoice.saleType ?? 'Retail'}
                onChange={(event) => updateDraftSaleType(event.target.value as CustomerType)}
                className="input-field w-44 py-1.5 text-xs mt-1"
              >
                {(['Retail', 'Semi-Wholesale', 'Wholesale'] as CustomerType[]).map((type) => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            ) : (
              <p className="font-semibold">{visibleInvoice.status}</p>
            )}
          </div>
        </div>

        <div className="overflow-x-auto print:hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/60 border-y border-border">
                {['Design', 'SKU', 'GW', 'Customer NW', 'Purity', 'Rate', 'Labour/g', 'Labour Total', 'Piroi', 'Total'].map((heading) => (
                  <th key={heading} className="px-3 py-2 text-left font-semibold uppercase text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleInvoice.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-3 py-3 font-mono">{item.designNumber}</td>
                  <td className="px-3 py-3 font-mono">{item.skuNumber}</td>
                  <td className="px-3 py-3">
                    {editing ? <input type="number" value={item.grossWeight} onChange={(event) => updateDraftItem(item.id, 'grossWeight', parseFloat(event.target.value) || 0)} className="input-field w-20 py-1 text-xs" step="0.001" /> : `${item.grossWeight.toFixed(3)} g`}
                  </td>
                  <td className="px-3 py-3">
                    {editing ? <input type="number" value={item.customerNetWeight} onChange={(event) => updateDraftItem(item.id, 'customerNetWeight', parseFloat(event.target.value) || 0)} className="input-field w-20 py-1 text-xs" step="0.001" /> : `${item.customerNetWeight.toFixed(3)} g`}
                  </td>
                  <td className="px-3 py-3">{item.purity}</td>
                  <td className="px-3 py-3">
                    {editing ? <input type="number" value={item.metalRate} onChange={(event) => updateDraftItem(item.id, 'metalRate', parseFloat(event.target.value) || 0)} className="input-field w-24 py-1 text-xs" /> : `₹${item.metalRate.toLocaleString('en-IN')}`}
                  </td>
                  <td className="px-3 py-3">₹{labourPerGram(item).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                  <td className="px-3 py-3">
                    {editing ? <input type="number" value={item.labour} onChange={(event) => updateDraftItem(item.id, 'labour', parseFloat(event.target.value) || 0)} className="input-field w-24 py-1 text-xs" /> : `₹${item.labour.toLocaleString('en-IN')}`}
                  </td>
                  <td className="px-3 py-3">
                    {editing ? <input type="number" value={item.piroi} onChange={(event) => updateDraftItem(item.id, 'piroi', parseFloat(event.target.value) || 0)} className="input-field w-20 py-1 text-xs" /> : `₹${item.piroi.toLocaleString('en-IN')}`}
                  </td>
                  <td className="px-3 py-3 font-bold">₹{item.itemTotal.toLocaleString('en-IN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="hidden print:block">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/60 border-y border-border">
                {(isRetailSilverPrint
                  ? ['Design', 'SKU', 'Purity', 'Total']
                  : showLabourPerGramOnPrint
                    ? ['Design', 'SKU', 'GW', 'Customer NW', 'Purity', 'Rate', 'Labour/g', 'Labour Total', 'Piroi', 'Total']
                    : ['Design', 'SKU', 'GW', 'Customer NW', 'Purity', 'Rate', 'Labour', 'Piroi', 'Total']
                ).map((heading) => (
                  <th key={heading} className="px-3 py-2 text-left font-semibold uppercase text-muted-foreground">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleInvoice.items.map((item) => (
                <tr key={item.id}>
                  <td className="px-3 py-3 font-mono">{item.designNumber}</td>
                  <td className="px-3 py-3 font-mono">{item.skuNumber}</td>
                  {isRetailSilverPrint ? (
                    <>
                      <td className="px-3 py-3">{item.purity}</td>
                      <td className="px-3 py-3 font-bold">₹{item.itemTotal.toLocaleString('en-IN')}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-3 py-3">{item.grossWeight.toFixed(3)} g</td>
                      <td className="px-3 py-3">{item.customerNetWeight.toFixed(3)} g</td>
                      <td className="px-3 py-3">{item.purity}</td>
                      <td className="px-3 py-3">₹{item.metalRate.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3">
                        ₹{(showLabourPerGramOnPrint ? labourPerGram(item) : item.labour).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </td>
                      {showLabourPerGramOnPrint && (
                        <td className="px-3 py-3">₹{item.labour.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</td>
                      )}
                      <td className="px-3 py-3">₹{item.piroi.toLocaleString('en-IN')}</td>
                      <td className="px-3 py-3 font-bold">₹{item.itemTotal.toLocaleString('en-IN')}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 ml-auto max-w-xs space-y-2 text-sm">
          <div className="flex justify-between"><span>Subtotal</span><strong>₹{visibleInvoice.subtotal.toLocaleString('en-IN')}</strong></div>
          <div className="flex justify-between items-center gap-3">
            <span>Discount</span>
            {editing ? (
              <input type="number" value={visibleInvoice.discount} onChange={(event) => updateDraftField('discount', parseFloat(event.target.value) || 0)} className="input-field w-28 py-1 text-xs text-right" />
            ) : (
              <strong>₹{visibleInvoice.discount.toLocaleString('en-IN')}</strong>
            )}
          </div>
          <div className="flex justify-between items-center gap-3">
            <span>Additional Charges</span>
            {editing ? (
              <input type="number" value={visibleInvoice.additionalCharges} onChange={(event) => updateDraftField('additionalCharges', parseFloat(event.target.value) || 0)} className="input-field w-28 py-1 text-xs text-right" />
            ) : (
              <strong>₹{visibleInvoice.additionalCharges.toLocaleString('en-IN')}</strong>
            )}
          </div>
          <div className="flex justify-between">
            <span>GST</span>
            <strong>₹{visibleInvoice.gst.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</strong>
          </div>
          <div className="border-t border-border pt-2 flex justify-between text-lg"><span>Grand Total</span><strong className="text-primary">₹{visibleInvoice.grandTotal.toLocaleString('en-IN')}</strong></div>
          {(visibleInvoice.fineWeightDue ?? 0) > 0 && (
            <>
              <div className="flex justify-between"><span>Fine Due</span><strong>{visibleInvoice.fineWeightDue?.toFixed(3)} g</strong></div>
              <div className="flex justify-between"><span>Fine Pending</span><strong>{visibleInvoice.fineWeightPending?.toFixed(3)} g</strong></div>
            </>
          )}
          <div className="flex justify-between"><span>Received</span><strong>₹{visibleInvoice.amountReceived.toLocaleString('en-IN')}</strong></div>
          <div className="flex justify-between"><span>Pending</span><strong>₹{visibleInvoice.pendingAmount.toLocaleString('en-IN')}</strong></div>
        </div>
        {editing && (
          <div className="mt-4 print:hidden">
            <label className="text-xs font-semibold text-muted-foreground block mb-1">Notes</label>
            <textarea
              value={visibleInvoice.notes}
              onChange={(event) => updateDraftField('notes', event.target.value)}
              className="input-field min-h-20 text-xs"
              placeholder="Estimate notes"
            />
          </div>
        )}
      </section>
    </div>
  );
}
