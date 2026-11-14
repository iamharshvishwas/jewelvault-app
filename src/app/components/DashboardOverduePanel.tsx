'use client';
import React from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { getOverdueCustomers } from '@/lib/appStore';
import { useSession } from '@/lib/authStore';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { paiseShown } from '@/lib/ledgerView';
import { dayLabel } from '@/lib/rateGuard';
import { OVERDUE_DAYS } from '@/lib/selectors';

// FB-D3 (Siddhi #7): "Payment pending over 60 days", for the owner and the biller. The customers with a bill that still has money pending (V1) and is more than 60 days old on the
// Asia/Kolkata calendar (src/lib/selectors.ts `overdueCustomers`: opening-balance dues count, a cancelled bill does not, the walk-in is never listed). Each name opens that customer's ledger. The
// oldest first, the ten oldest shown; the screen is drawn again when the bills or customers change and when the day changes.

/** On a phone (under 640 px) the card keeps the name, the amount and the days: the mobile and the date of the oldest bill have no room, and are on the customer's ledger one tap away. */
const PHONE_HIDDEN: ReadonlySet<string> = new Set(['Mobile', 'Oldest pending bill']);

/** How many customers the card lists; the owner has the whole list in Reports > Payments (Download outstanding list). The biller cannot open Reports, so the card sends the biller to the owner. */
const SHOWN = 10;

export default function DashboardOverduePanel() {
  useRowCacheVersion('bill-summary', 'customers');
  useBusinessToday(); // draws the card again at midnight in India (the list itself is of today's date)
  const rows = getOverdueCustomers();
  const { role } = useSession();

  return (
    <section data-testid="overdue-panel" className="jewel-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <AlertTriangle
            size={15}
            className={rows.length > 0 ? 'text-amber-600' : 'text-muted-foreground'}
          />
          Payment pending over {OVERDUE_DAYS} days
        </h2>
        <span data-testid="overdue-count" className="text-xs text-muted-foreground">
          {rows.length === 0
            ? 'None'
            : `${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}`}
        </span>
      </div>
      {rows.length === 0 ? (
        <p data-testid="overdue-none" className="text-xs text-muted-foreground">
          No customer has a payment pending for more than {OVERDUE_DAYS} days.
        </p>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/60 border-b border-border">
                {['Customer', 'Mobile', 'Pending', 'Oldest pending bill', 'Days'].map((heading) => (
                  <th
                    key={heading}
                    className={`px-3 py-2 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap ${PHONE_HIDDEN.has(heading) ? 'hidden sm:table-cell' : ''}`}
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.slice(0, SHOWN).map((row) => (
                <tr key={row.customerId} data-testid="overdue-row" className="table-row-hover">
                  <td className="px-3 py-2.5 font-semibold">
                    <Link
                      href={`/customer-ledger?customer=${row.customerId}`}
                      data-testid="overdue-customer"
                      className="text-primary hover:underline"
                    >
                      {row.name || 'Unknown customer'}
                    </Link>
                  </td>
                  <td className="hidden px-3 py-2.5 font-mono text-muted-foreground sm:table-cell">
                    {row.mobile || '-'}
                  </td>
                  <td className="px-3 py-2.5 font-tabular font-bold text-amber-700 whitespace-nowrap">
                    {paiseShown(Number(row.pendingPaise))}
                  </td>
                  <td className="hidden px-3 py-2.5 whitespace-nowrap sm:table-cell">
                    {dayLabel(row.oldestPendingBillDate)}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                      {row.daysPending} days
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > SHOWN && (
            <p data-testid="overdue-more" className="mt-2 text-xs text-muted-foreground">
              And {rows.length - SHOWN} more.{' '}
              {role === 'owner'
                ? 'The owner has the whole list in Reports, Payments.'
                : 'Ask the owner for the full list.'}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
