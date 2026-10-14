import React from 'react';
import { getInvoices } from '@/lib/appStore';
import StatusBadge from '@/components/ui/StatusBadge';
import Link from 'next/link';


export default function DesignSalesHistory() {
  const relatedInvoices = getInvoices().filter((inv) =>
    inv.items.some((item) => item.designNumber === 'SET-00572')
  );

  if (relatedInvoices.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-sm font-semibold text-foreground">No sales recorded for SET-00572</p>
        <p className="text-xs text-muted-foreground mt-1">Sales will appear here once SKUs from this design are sold.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Sales History — {relatedInvoices.length} invoice(s)</h3>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/60 border-b border-border">
              {['Invoice No.', 'Date', 'Customer', 'SKU', 'NW (g)', 'Rate', 'Labour', 'Total', 'Status'].map((h, i) => (
                <th key={`sh-th-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {relatedInvoices.map((inv) =>
              inv.items
                .filter((item) => item.designNumber === 'SET-00572')
                .map((item) => (
                  <tr key={`sales-hist-${inv.id}-${item.id}`} className="table-row-hover">
                    <td className="px-3 py-3">
                      <Link href={`/estimate?id=${inv.id}`} className="font-mono font-bold text-primary hover:underline">
                        {inv.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                      {new Date(inv.date).toLocaleDateString('en-IN')}
                    </td>
                    <td className="px-3 py-3 text-foreground">{inv.customerName}</td>
                    <td className="px-3 py-3 font-mono text-foreground">{item.skuNumber}</td>
                    <td className="px-3 py-3 font-tabular text-foreground">{item.customerNetWeight.toFixed(3)}</td>
                    <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">
                      ₹{item.metalRate.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-3 font-tabular text-foreground whitespace-nowrap">
                      ₹{item.labour.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">
                      ₹{item.itemTotal.toLocaleString('en-IN')}
                    </td>
                    <td className="px-3 py-3">
                      <StatusBadge status={inv.status === 'Paid' ? 'In Stock' : inv.status === 'Partial' ? 'Reserved' : 'Sold'} size="sm" />
                    </td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
