'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Printer, ArrowLeft, Search, FileText } from 'lucide-react';
import { getInvoiceById, getInvoices } from '@/lib/appStore';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { gramsShown, rupeesShown } from '@/lib/ledgerView';
import type { Invoice } from '@/lib/mockData';

// The saved estimates, read-only (task WEB10; spec K1, Y8, C15). A bill is never edited and never re-dated in M1: a correction is a re-issue by the owner (WEB11), so this screen has no date
// field, no edit mode and no draft, and writes nothing. Every figure on it is the bill's row of V1 in memory (received, pending, the silver pending, the status) as the server worked it out,
// written the same way as on the customer card and in the ledger (src/lib/ledgerView.ts). It is drawn again whenever memory changes: a poll, or a payment made in this browser or in another.

const STATUS_COLORS: Record<Invoice['status'], string> = {
  Paid: 'status-badge-instock',
  Partial: 'status-badge-reserved',
  Pending: 'status-badge-approval',
  Cancelled: 'status-badge-archived',
};

type EstimateFilter = 'All' | 'Received' | 'Partial' | 'Pending';

// what the bills are made of (src/lib/appStore.ts)
const BILLS = [
  'users',
  'customers',
  'bills',
  'bill-summary',
  'bill-items',
  'receipts',
  'receipt-allocations',
] as const;

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

function labourPerGram(invoiceItem: Invoice['items'][number]) {
  if (invoiceItem.customerNetWeight <= 0) return 0;
  return invoiceItem.labour / invoiceItem.customerNetWeight;
}

export default function EstimateViewClient() {
  const searchParams = useSearchParams();
  const invoiceId = searchParams.get('id') || '';
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<EstimateFilter>('All');

  useRowCacheVersion(...BILLS);

  const invoices = getInvoices();
  const invoice = invoiceId ? getInvoiceById(invoiceId) : undefined;
  const filteredInvoices = invoices.filter((inv) => {
    const haystack =
      `${inv.invoiceNumber} ${inv.customerName} ${inv.customerMobile} ${inv.status} ${inv.notes}`.toLowerCase();
    const matchesQuery = haystack.includes(query.toLowerCase());
    const matchesStatus =
      statusFilter === 'All' ||
      (statusFilter === 'Received' && inv.status === 'Paid') ||
      (statusFilter === 'Partial' && inv.status === 'Partial') ||
      (statusFilter === 'Pending' && inv.status === 'Pending');
    return matchesQuery && matchesStatus;
  });

  if (!invoiceId) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Saved Estimates</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {invoices.length} estimate{invoices.length !== 1 ? 's' : ''}
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
              <Search
                size={15}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
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
                    statusFilter === filter
                      ? 'bg-card text-primary shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
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
              <p className="text-xs text-muted-foreground mt-1">
                Create an estimate from New Estimate first.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60 border-b border-border">
                    {[
                      'Estimate No.',
                      'Date',
                      'Customer',
                      'Items',
                      'Grand Total',
                      'Received',
                      'Pending',
                      'Status',
                      '',
                    ].map((heading, i) => (
                      <th
                        key={`${heading}-${i}`}
                        className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredInvoices.map((inv) => (
                    <tr key={inv.id} data-testid="estimate-row" className="table-row-hover">
                      <td className="px-3 py-3">
                        <Link
                          href={`/estimate?id=${inv.id}`}
                          className="font-mono font-bold text-primary hover:underline"
                        >
                          {inv.invoiceNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                        {displayDate(inv.date)}
                      </td>
                      <td className="px-3 py-3">
                        <p className="font-semibold text-foreground">{inv.customerName}</p>
                        {inv.customerMobile && (
                          <p className="text-muted-foreground">{inv.customerMobile}</p>
                        )}
                      </td>
                      <td className="px-3 py-3 text-muted-foreground">{inv.items.length}</td>
                      <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">
                        {rupeesShown(inv.grandTotal)}
                      </td>
                      <td className="px-3 py-3 font-tabular font-semibold text-emerald-600 whitespace-nowrap">
                        {rupeesShown(inv.amountReceived)}
                      </td>
                      <td className="px-3 py-3 font-tabular font-semibold whitespace-nowrap">
                        {inv.pendingAmount > 0 || (inv.fineWeightPending ?? 0) > 0 ? (
                          <div className="space-y-0.5">
                            {inv.pendingAmount > 0 && (
                              <p className="text-amber-600">{rupeesShown(inv.pendingAmount)}</p>
                            )}
                            {(inv.fineWeightPending ?? 0) > 0 && (
                              <p className="text-amber-600">
                                {gramsShown(inv.fineWeightPending ?? 0)} fine
                              </p>
                            )}
                            <p className="text-[11px] text-muted-foreground">
                              {pendingDays(inv)} day{pendingDays(inv) !== 1 ? 's' : ''} pending
                            </p>
                          </div>
                        ) : (
                          <span className="text-emerald-600">Nil</span>
                        )}
                      </td>
                      <td className="px-3 py-3">
                        <span
                          className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[inv.status]}`}
                        >
                          {inv.status}
                        </span>
                      </td>
                      <td className="px-3 py-3">
                        <Link
                          href={`/estimate?id=${inv.id}`}
                          className="text-xs text-primary hover:underline font-semibold"
                        >
                          View
                        </Link>
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
        <p className="text-sm text-muted-foreground mt-2">
          There is no estimate with that number in the books.
        </p>
        <Link href="/estimate" className="btn-primary mt-4 inline-flex">
          Back to Saved Estimates
        </Link>
      </div>
    );
  }

  const opening = invoice.openingBalance === true;
  const isRetailSilverPrint =
    (invoice.saleType ?? 'Retail') === 'Retail' &&
    invoice.items.length > 0 &&
    invoice.items.every((item) => item.material === 'Silver');
  const showLabourPerGramOnPrint =
    invoice.saleType === 'Semi-Wholesale' || invoice.saleType === 'Wholesale';

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between print:hidden">
        <Link href="/estimate" className="btn-secondary py-2">
          <ArrowLeft size={15} />
          Saved Estimates
        </Link>
        <button onClick={() => window.print()} className="btn-primary py-2">
          <Printer size={15} />
          Print / Save PDF
        </button>
      </div>

      <section className="print-estimate-sheet bg-white border border-border rounded-xl p-6 text-foreground">
        <div className="flex justify-between gap-4 border-b border-border pb-4">
          <div>
            <h1 className="text-2xl font-bold">{BUSINESS_NAME}</h1>
            <p className="text-sm text-muted-foreground">
              {opening
                ? 'Opening balance: dues brought forward.'
                : 'Estimate only. GST not charged.'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Estimate No.</p>
            <p data-testid="estimate-number" className="font-mono font-bold text-primary">
              {invoice.invoiceNumber}
            </p>
            <p data-testid="estimate-date" className="text-xs text-muted-foreground mt-2">
              {displayDate(invoice.date)}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 py-4">
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Customer</p>
            <p className="font-semibold">{invoice.customerName}</p>
            {invoice.customerMobile && (
              <p className="text-sm text-muted-foreground">{invoice.customerMobile}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Status</p>
            <p data-testid="estimate-status" className="font-semibold">
              {invoice.status}
            </p>
          </div>
        </div>

        {invoice.status === 'Cancelled' && (
          <p
            data-testid="estimate-cancelled"
            className="mb-3 rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
          >
            This estimate was cancelled. Nothing is owed on it.
          </p>
        )}

        {invoice.items.length > 0 && (
          <>
            <div className="overflow-x-auto print:hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/60 border-y border-border">
                    {[
                      'Design',
                      'SKU',
                      'GW',
                      'Customer NW',
                      'Purity',
                      'Rate',
                      'Labour/g',
                      'Labour Total',
                      'Piroi',
                      'Total',
                    ].map((heading) => (
                      <th
                        key={heading}
                        className="px-3 py-2 text-left font-semibold uppercase text-muted-foreground"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoice.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-3 font-mono">{item.designNumber}</td>
                      <td className="px-3 py-3 font-mono">{item.skuNumber}</td>
                      <td className="px-3 py-3">{gramsShown(item.grossWeight)}</td>
                      <td className="px-3 py-3">{gramsShown(item.customerNetWeight)}</td>
                      <td className="px-3 py-3">{item.purity}</td>
                      <td className="px-3 py-3">{rupeesShown(item.metalRate)}</td>
                      <td className="px-3 py-3">{rupeesShown(Math.round(labourPerGram(item)))}</td>
                      <td className="px-3 py-3">{rupeesShown(item.labour)}</td>
                      <td className="px-3 py-3">{rupeesShown(item.piroi)}</td>
                      <td className="px-3 py-3 font-bold">{rupeesShown(item.itemTotal)}</td>
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
                        ? [
                            'Design',
                            'SKU',
                            'GW',
                            'Customer NW',
                            'Purity',
                            'Rate',
                            'Labour/g',
                            'Labour Total',
                            'Piroi',
                            'Total',
                          ]
                        : [
                            'Design',
                            'SKU',
                            'GW',
                            'Customer NW',
                            'Purity',
                            'Rate',
                            'Labour',
                            'Piroi',
                            'Total',
                          ]
                    ).map((heading) => (
                      <th
                        key={heading}
                        className="px-3 py-2 text-left font-semibold uppercase text-muted-foreground"
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {invoice.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-3 py-3 font-mono">{item.designNumber}</td>
                      <td className="px-3 py-3 font-mono">{item.skuNumber}</td>
                      {isRetailSilverPrint ? (
                        <>
                          <td className="px-3 py-3">{item.purity}</td>
                          <td className="px-3 py-3 font-bold">{rupeesShown(item.itemTotal)}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-3">{gramsShown(item.grossWeight)}</td>
                          <td className="px-3 py-3">{gramsShown(item.customerNetWeight)}</td>
                          <td className="px-3 py-3">{item.purity}</td>
                          <td className="px-3 py-3">{rupeesShown(item.metalRate)}</td>
                          <td className="px-3 py-3">
                            {rupeesShown(
                              Math.round(
                                showLabourPerGramOnPrint ? labourPerGram(item) : item.labour
                              )
                            )}
                          </td>
                          {showLabourPerGramOnPrint && (
                            <td className="px-3 py-3">{rupeesShown(Math.round(item.labour))}</td>
                          )}
                          <td className="px-3 py-3">{rupeesShown(item.piroi)}</td>
                          <td className="px-3 py-3 font-bold">{rupeesShown(item.itemTotal)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="mt-5 ml-auto max-w-xs space-y-2 text-sm">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <strong>{rupeesShown(invoice.subtotal)}</strong>
          </div>
          <div className="flex justify-between items-center gap-3">
            <span>Discount</span>
            <strong>{rupeesShown(invoice.discount)}</strong>
          </div>
          <div className="flex justify-between items-center gap-3">
            <span>Additional Charges</span>
            <strong>{rupeesShown(invoice.additionalCharges)}</strong>
          </div>
          <div className="flex justify-between">
            <span>GST</span>
            <strong>{rupeesShown(invoice.gst)}</strong>
          </div>
          <div className="border-t border-border pt-2 flex justify-between text-lg">
            <span>Grand Total</span>
            <strong data-testid="estimate-grand-total" className="text-primary">
              {rupeesShown(invoice.grandTotal)}
            </strong>
          </div>
          {(invoice.fineWeightDue ?? 0) > 0 && (
            <>
              <div className="flex justify-between">
                <span>Fine Due</span>
                <strong data-testid="estimate-fine-due">
                  {gramsShown(invoice.fineWeightDue ?? 0)}
                </strong>
              </div>
              <div className="flex justify-between">
                <span>Fine Pending</span>
                <strong data-testid="estimate-fine-pending">
                  {gramsShown(invoice.fineWeightPending ?? 0)}
                </strong>
              </div>
            </>
          )}
          <div className="flex justify-between">
            <span>Received</span>
            <strong data-testid="estimate-received">{rupeesShown(invoice.amountReceived)}</strong>
          </div>
          <div className="flex justify-between">
            <span>Pending</span>
            <strong data-testid="estimate-pending">{rupeesShown(invoice.pendingAmount)}</strong>
          </div>
        </div>
      </section>
    </div>
  );
}
