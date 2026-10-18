import React from 'react';
import Link from 'next/link';
import type { Invoice } from '@/lib/mockData';
import { gramsShown, rupeesShown } from '@/lib/ledgerView';

// The bills of one customer with the figures of V1 (spec section 11): received, pending, the silver still owed and the status are the server's, written the same way as on the customer card
// and the estimate (src/lib/ledgerView.ts). The dues brought forward are listed too, as an opening balance, and so is a cancelled bill: the pending of the bills adds up to the card's outstanding.
interface CustomerInvoiceListProps {
  invoices: Invoice[];
}

const STATUS_COLORS: Record<string, string> = {
  Paid: 'status-badge-instock',
  Partial: 'status-badge-reserved',
  Pending: 'status-badge-approval',
  Cancelled: 'status-badge-archived',
};

const HEADINGS = [
  'Invoice No.',
  'Date',
  'Items',
  'Grand Total',
  'Received',
  'Pending',
  'Status',
  '',
];

export default function CustomerInvoiceList({ invoices }: CustomerInvoiceListProps) {
  if (invoices.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm font-semibold text-foreground">No invoices yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Invoices will appear here once sales are recorded for this customer.
        </p>
        <Link href="/billing-pos" className="btn-primary mt-3 inline-flex py-2 text-xs">
          + New Sale
        </Link>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/60 border-b border-border">
            {HEADINGS.map((h, i) => (
              <th
                key={`ith-${i}`}
                className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {invoices.map((inv) => {
            const finePending = inv.fineWeightPending ?? 0;
            return (
              <tr key={`inv-list-${inv.id}`} data-testid="invoice-row" className="table-row-hover">
                <td className="px-3 py-3">
                  <Link
                    href={`/estimate?id=${inv.id}`}
                    className="font-mono font-bold text-primary hover:underline"
                  >
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                  {new Date(inv.date).toLocaleDateString('en-IN')}
                </td>
                <td className="px-3 py-3 text-muted-foreground">
                  {inv.openingBalance
                    ? 'Opening balance'
                    : `${inv.items.length} item${inv.items.length !== 1 ? 's' : ''}`}
                </td>
                <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">
                  {rupeesShown(inv.grandTotal)}
                </td>
                <td className="px-3 py-3 font-tabular text-emerald-600 font-semibold whitespace-nowrap">
                  {rupeesShown(inv.amountReceived)}
                </td>
                <td className="px-3 py-3 font-tabular whitespace-nowrap">
                  {inv.pendingAmount > 0 || finePending > 0 ? (
                    <div className="space-y-0.5">
                      {inv.pendingAmount > 0 && (
                        <p className="font-bold text-amber-600">{rupeesShown(inv.pendingAmount)}</p>
                      )}
                      {finePending > 0 && (
                        <p className="font-bold text-amber-600">{gramsShown(finePending)} fine</p>
                      )}
                    </div>
                  ) : (
                    <span className="text-emerald-600 font-semibold">Nil</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <span
                    className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[inv.status] ?? 'status-badge-archived'}`}
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
