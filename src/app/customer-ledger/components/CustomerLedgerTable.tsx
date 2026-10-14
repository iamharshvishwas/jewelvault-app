import React from 'react';
import type { LedgerEntry } from '@/lib/mockData';

interface CustomerLedgerTableProps {
  entries: LedgerEntry[];
}

const TYPE_COLORS: Record<string, string> = {
  Invoice: 'bg-blue-100 text-blue-700',
  Payment: 'bg-emerald-100 text-emerald-700',
  Credit: 'bg-purple-100 text-purple-700',
  Return: 'bg-amber-100 text-amber-700',
  Adjustment: 'bg-slate-100 text-slate-700',
};

export default function CustomerLedgerTable({ entries }: CustomerLedgerTableProps) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm font-semibold text-foreground">No ledger entries yet</p>
        <p className="text-xs text-muted-foreground mt-1">Transactions will appear here once invoices or payments are recorded.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/60 border-b border-border">
            {['Date', 'Type', 'Description', 'Reference', 'Debit (₹)', 'Credit (₹)', 'Balance (₹)', 'Fine In', 'Fine Out', 'Fine Balance'].map((h, i) => (
              <th key={`lth-${i}`} className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => (
            <tr key={entry.id} className="table-row-hover">
              <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                {new Date(entry.date).toLocaleDateString('en-IN')}
              </td>
              <td className="px-3 py-3">
                <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TYPE_COLORS[entry.type] ?? 'bg-muted text-muted-foreground'}`}>
                  {entry.type}
                </span>
              </td>
              <td className="px-3 py-3 text-foreground max-w-xs truncate">{entry.description}</td>
              <td className="px-3 py-3">
                <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">{entry.reference}</span>
              </td>
              <td className="px-3 py-3 font-tabular text-right">
                {entry.debit > 0 ? (
                  <span className="text-red-600 font-semibold">₹{entry.debit.toLocaleString('en-IN')}</span>
                ) : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-3 font-tabular text-right">
                {entry.credit > 0 ? (
                  <span className="text-emerald-600 font-semibold">₹{entry.credit.toLocaleString('en-IN')}</span>
                ) : <span className="text-muted-foreground">—</span>}
              </td>
              <td className="px-3 py-3 font-tabular text-right font-bold">
                <span className={entry.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                  ₹{entry.balance.toLocaleString('en-IN')}
                </span>
              </td>
              <td className="px-3 py-3 font-tabular text-right">
                {(entry.fineDebit ?? 0) > 0 ? <span className="text-red-600 font-semibold">{entry.fineDebit?.toFixed(3)} g</span> : <span className="text-muted-foreground">-</span>}
              </td>
              <td className="px-3 py-3 font-tabular text-right">
                {(entry.fineCredit ?? 0) > 0 ? <span className="text-emerald-600 font-semibold">{entry.fineCredit?.toFixed(3)} g</span> : <span className="text-muted-foreground">-</span>}
              </td>
              <td className="px-3 py-3 font-tabular text-right font-bold">
                <span className={(entry.fineBalance ?? 0) > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                  {(entry.fineBalance ?? 0).toFixed(3)} g
                </span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-muted/40 border-t-2 border-border">
            <td colSpan={4} className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase">
              Current Balance
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-red-600">
              ₹{entries.reduce((a, e) => a + e.debit, 0).toLocaleString('en-IN')}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-emerald-600">
              ₹{entries.reduce((a, e) => a + e.credit, 0).toLocaleString('en-IN')}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-amber-700 text-sm">
              ₹{(entries[entries.length - 1]?.balance ?? 0).toLocaleString('en-IN')}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-red-600">
              {entries.reduce((a, e) => a + (e.fineDebit ?? 0), 0).toFixed(3)} g
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-emerald-600">
              {entries.reduce((a, e) => a + (e.fineCredit ?? 0), 0).toFixed(3)} g
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-amber-700 text-sm">
              {(entries[entries.length - 1]?.fineBalance ?? 0).toFixed(3)} g
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
