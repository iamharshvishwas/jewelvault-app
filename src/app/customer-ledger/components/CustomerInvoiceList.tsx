import React from 'react';
import Link from 'next/link';
import type { Invoice } from '@/lib/mockData';

interface CustomerInvoiceListProps {
  invoices: Invoice[];
}

const STATUS_COLORS: Record<string, string> = {
  Paid: 'status-badge-instock',
  Partial: 'status-badge-reserved',
  Pending: 'status-badge-approval',
  Cancelled: 'status-badge-archived',
};

export default function CustomerInvoiceList({ invoices }: CustomerInvoiceListProps) {
  if (invoices.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm font-semibold text-foreground">No invoices yet</p>
        <p className="text-xs text-muted-foreground mt-1">Invoices will appear here once sales are recorded for this customer.</p>
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
            {['Invoice No.', 'Date', 'Items', 'Grand Total', 'Received', 'Pending', 'Status', ''].map((h, i) => (
              <th key={`ith-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {invoices.map((inv) => (
            <tr key={`inv-list-${inv.id}`} className="table-row-hover">
              <td className="px-3 py-3">
                <Link href={`/estimate?id=${inv.id}`} className="font-mono font-bold text-primary hover:underline">
                  {inv.invoiceNumber}
                </Link>
              </td>
              <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                {new Date(inv.date).toLocaleDateString('en-IN')}
              </td>
              <td className="px-3 py-3 text-muted-foreground">{inv.items.length} item{inv.items.length !== 1 ? 's' : ''}</td>
              <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">
                ₹{inv.grandTotal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </td>
              <td className="px-3 py-3 font-tabular text-emerald-600 font-semibold whitespace-nowrap">
                ₹{inv.amountReceived.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </td>
              <td className="px-3 py-3 font-tabular whitespace-nowrap">
                {inv.pendingAmount > 0 || (inv.fineWeightPending ?? 0) > 0 ? (
                  <div className="space-y-0.5">
                    {inv.pendingAmount > 0 && (
                      <p className="font-bold text-amber-600">₹{inv.pendingAmount.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
                    )}
                    {(inv.fineWeightPending ?? 0) > 0 && (
                      <p className="font-bold text-amber-600">{inv.fineWeightPending?.toFixed(3)} g fine</p>
                    )}
                  </div>
                ) : (
                  <span className="text-emerald-600 font-semibold">Nil</span>
                )}
              </td>
              <td className="px-3 py-3">
                <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${STATUS_COLORS[inv.status] ?? 'status-badge-archived'}`}>
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
  );
}
