import React from 'react';
import type { LedgerEntry } from '@/lib/mockData';
import {
  balanceShown,
  fineBalanceShown,
  gramsShown,
  ledgerKindLabel,
  rupeesShown,
  sumGrams,
  sumRupees,
} from '@/lib/ledgerView';

// The ledger of one customer: one row per event of V3 (spec section 11), in the order of V3, with the running balance and the running silver balance the SERVER worked out for that row. Nothing
// is added up again on a row: the foot is the last row, which is the customer's balance of V2 (I4), and the totals of the debit and credit columns. A balance below zero is an advance and says so.
interface CustomerLedgerTableProps {
  entries: LedgerEntry[];
}

// by the words on the row (src/lib/ledgerView.ts); the last three are the prototype's own types, kept for a preview build
const TYPE_COLORS: Record<string, string> = {
  Invoice: 'bg-blue-100 text-blue-700',
  'Opening balance': 'bg-blue-100 text-blue-700',
  Cancellation: 'bg-amber-100 text-amber-700',
  Payment: 'bg-emerald-100 text-emerald-700',
  'Opening advance': 'bg-emerald-100 text-emerald-700',
  Fine: 'bg-sky-100 text-sky-700',
  Refund: 'bg-purple-100 text-purple-700',
  Void: 'bg-red-100 text-red-700',
  Credit: 'bg-purple-100 text-purple-700',
  Return: 'bg-amber-100 text-amber-700',
  Adjustment: 'bg-slate-100 text-slate-700',
};

const HEADINGS = [
  'Date',
  'Type',
  'Description',
  'Reference',
  'Debit (₹)',
  'Credit (₹)',
  'Balance (₹)',
  'Fine In',
  'Fine Out',
  'Fine Balance',
];

function CustomerLedgerTable({ entries }: CustomerLedgerTableProps) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-10">
        <p className="text-sm font-semibold text-foreground">No ledger entries yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          Transactions will appear here once invoices or payments are recorded.
        </p>
      </div>
    );
  }

  const last = entries[entries.length - 1];

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table data-testid="ledger-table" className="w-full text-xs">
        <thead>
          <tr className="bg-muted/60 border-b border-border">
            {HEADINGS.map((h, i) => (
              <th
                key={`lth-${i}`}
                className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {entries.map((entry) => {
            const label = ledgerKindLabel(entry);
            return (
              <tr key={entry.id} data-testid="ledger-row" className="table-row-hover">
                <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                  {new Date(entry.date).toLocaleDateString('en-IN')}
                </td>
                <td className="px-3 py-3">
                  <span
                    className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TYPE_COLORS[label] ?? 'bg-muted text-muted-foreground'}`}
                  >
                    {label}
                  </span>
                </td>
                <td className="px-3 py-3 text-foreground max-w-xs truncate">{entry.description}</td>
                <td className="px-3 py-3">
                  {entry.reference && (
                    <span className="font-mono text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                      {entry.reference}
                    </span>
                  )}
                </td>
                <td className="px-3 py-3 font-tabular text-right">
                  {entry.debit > 0 ? (
                    <span className="text-red-600 font-semibold">{rupeesShown(entry.debit)}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-3 font-tabular text-right">
                  {entry.credit > 0 ? (
                    <span className="text-emerald-600 font-semibold">
                      {rupeesShown(entry.credit)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-3 font-tabular text-right font-bold">
                  <span className={entry.balance > 0 ? 'text-amber-700' : 'text-emerald-700'}>
                    {balanceShown(entry.balance)}
                  </span>
                </td>
                <td className="px-3 py-3 font-tabular text-right">
                  {(entry.fineDebit ?? 0) > 0 ? (
                    <span className="text-red-600 font-semibold">
                      {gramsShown(entry.fineDebit ?? 0)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-3 py-3 font-tabular text-right">
                  {(entry.fineCredit ?? 0) > 0 ? (
                    <span className="text-emerald-600 font-semibold">
                      {gramsShown(entry.fineCredit ?? 0)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  )}
                </td>
                <td className="px-3 py-3 font-tabular text-right font-bold">
                  <span
                    className={(entry.fineBalance ?? 0) > 0 ? 'text-amber-700' : 'text-emerald-700'}
                  >
                    {fineBalanceShown(entry.fineBalance ?? 0)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr data-testid="ledger-total" className="bg-muted/40 border-t-2 border-border">
            <td
              colSpan={4}
              className="px-3 py-2.5 text-xs font-semibold text-muted-foreground uppercase"
            >
              Current Balance
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-red-600">
              {rupeesShown(sumRupees(entries.map((e) => e.debit)))}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-emerald-600">
              {rupeesShown(sumRupees(entries.map((e) => e.credit)))}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-amber-700 text-sm">
              {balanceShown(last.balance)}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-red-600">
              {gramsShown(sumGrams(entries.map((e) => e.fineDebit ?? 0)))}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-emerald-600">
              {gramsShown(sumGrams(entries.map((e) => e.fineCredit ?? 0)))}
            </td>
            <td className="px-3 py-2.5 font-tabular text-right font-bold text-amber-700 text-sm">
              {fineBalanceShown(last.fineBalance ?? 0)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// a clock tick of the card must not draw 5,000 rows again: the table is drawn again only when its entries are another array
export default React.memo(CustomerLedgerTable);
