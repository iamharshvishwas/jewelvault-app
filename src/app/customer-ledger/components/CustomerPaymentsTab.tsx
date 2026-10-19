'use client';
import React from 'react';
import VoidReceiptAction from '@/components/owner/VoidReceiptAction';
import { useOwnerActions } from '@/components/owner/useOwnerActions';
import { getReceiptFacts } from '@/lib/appStore';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { gramsShown, rupeesShown } from '@/lib/ledgerView';
import type { LedgerEntry } from '@/lib/mockData';

// The Payments tab of the customer card: the receipts of the customer (money, silver, an opening advance) and, below them, the refunds (spec Y1, Y7, Y10, S7; tasks WEB10 and WEB11). A
// receipt is never deleted: the owner VOIDS it (a Void button on each live row, owner only), and a voided one stays in the list tagged Voided. A refund is money handed back; it is
// listed apart, with its own Void button, because a payment whose money was already handed back cannot be voided until the refund is ("void the refund first"). A biller sees the rows
// and no button.

interface CustomerPaymentsTabProps {
  entries: readonly LedgerEntry[];
  /** The refunds of the customer (ledger rows of the kind Refund). */
  refunds: readonly LedgerEntry[];
  /** The receipts V3 shows a Void row for. */
  voided: ReadonlySet<string>;
}

const shortDate = (date: string) =>
  new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

/** What a receipt is, in a few words, for the dialog that voids it. */
function labelOf(entry: LedgerEntry): string {
  const money = entry.debit > 0 ? entry.debit : entry.credit;
  const fine = (entry.fineCredit ?? 0) > 0 ? gramsShown(entry.fineCredit ?? 0) : null;
  const what =
    money > 0 && fine ? `${rupeesShown(money)} and ${fine} silver` : (fine ?? rupeesShown(money));
  return `${what} on ${shortDate(entry.date)}`;
}

export default function CustomerPaymentsTab({
  entries,
  refunds,
  voided,
}: CustomerPaymentsTabProps) {
  const owner = useOwnerActions();
  useRowCacheVersion('receipts');
  const showAction = owner;

  const isVoided = (entry: LedgerEntry): boolean =>
    !!entry.paymentId &&
    (voided.has(entry.paymentId) || getReceiptFacts(entry.paymentId)?.status === 'voided');

  return (
    <div className="space-y-5">
      {entries.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          No payments recorded yet.
        </div>
      ) : (
        <div className="overflow-x-auto scrollbar-thin">
          <table data-testid="payments-table" className="w-full text-xs">
            <thead>
              <tr className="bg-muted/60 border-b border-border">
                {['Date', 'Description', 'Reference', 'Amount', 'Fine']
                  .concat(showAction ? ['Action'] : [])
                  .map((heading) => (
                    <th
                      key={heading}
                      className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                    >
                      {heading}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  data-testid="payment-row"
                  data-receipt-id={entry.paymentId ?? ''}
                  className="table-row-hover"
                >
                  <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                    {new Date(entry.date).toLocaleDateString('en-IN')}
                  </td>
                  <td className="px-3 py-3 text-foreground">
                    {entry.description}
                    {isVoided(entry) && (
                      <span
                        data-testid="voided-tag"
                        className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700"
                      >
                        Voided
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {entry.reference || '-'}
                  </td>
                  <td className="px-3 py-3 font-tabular font-bold text-emerald-600 whitespace-nowrap">
                    {rupeesShown(entry.credit)}
                  </td>
                  <td className="px-3 py-3 font-tabular font-bold text-amber-600 whitespace-nowrap">
                    {(entry.fineCredit ?? 0) > 0 ? gramsShown(entry.fineCredit ?? 0) : '-'}
                  </td>
                  {showAction && (
                    <td className="px-3 py-3">
                      {entry.paymentId && (
                        <VoidReceiptAction receiptId={entry.paymentId} label={labelOf(entry)} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {refunds.length > 0 && (
        <div data-testid="refunds-list">
          <h4 className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">
            Refunds (money handed back)
          </h4>
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['Date', 'Description', 'Reference', 'Amount']
                    .concat(showAction ? ['Action'] : [])
                    .map((heading) => (
                      <th
                        key={heading}
                        className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                      >
                        {heading}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {refunds.map((entry) => (
                  <tr
                    key={entry.id}
                    data-testid="refund-row"
                    data-receipt-id={entry.paymentId ?? ''}
                    className="table-row-hover"
                  >
                    <td className="px-3 py-3 text-muted-foreground whitespace-nowrap">
                      {new Date(entry.date).toLocaleDateString('en-IN')}
                    </td>
                    <td className="px-3 py-3 text-foreground">
                      {entry.description}
                      {isVoided(entry) && (
                        <span
                          data-testid="voided-tag"
                          className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-semibold text-red-700"
                        >
                          Voided
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                      {entry.reference || '-'}
                    </td>
                    <td className="px-3 py-3 font-tabular font-bold text-foreground whitespace-nowrap">
                      {rupeesShown(entry.debit)}
                    </td>
                    {showAction && (
                      <td className="px-3 py-3">
                        {entry.paymentId && (
                          <VoidReceiptAction
                            receiptId={entry.paymentId}
                            label={labelOf(entry)}
                            refund
                          />
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
