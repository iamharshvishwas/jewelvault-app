'use client';

import React from 'react';
import { BUSINESS_NAME } from '@/lib/businessConfig';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  balanceShown,
  fineBalanceShown,
  gramsShown,
  ledgerKindLabel,
  rupeesShown,
  sumRupees,
} from '@/lib/ledgerView';
import type { Customer, LedgerEntry } from '@/lib/mockData';
import { getSettings } from '@/lib/settingsStore';

// FB-D1 (Siddhi #4): one customer's ledger on paper, for the browser's Print / Save PDF (the same print shell as the estimate, WEB13; the rules are in src/styles/tailwind.css under
// `.print-ledger-sheet`). It is not on the screen: the screen has the ledger table. On paper it is the shop's header (the Settings' `business`, a blank address or phone not printed), the
// customer, the day it was printed (Asia/Kolkata), every row of V3 as the server sent it (nothing worked out again, the description whole, never cut) and four totals: the debit and the
// credit columns added in paise, and the balance and the silver balance of the last row, which are the customer's (I4).
interface CustomerLedgerPrintProps {
  customer: Customer;
  entries: LedgerEntry[];
}

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

const dayShown = (businessDate: string) =>
  new Date(`${businessDate}T12:00:00.000Z`).toLocaleDateString('en-IN');

function CustomerLedgerPrint({ customer, entries }: CustomerLedgerPrintProps) {
  useRowCacheVersion('settings');
  const today = useBusinessToday();
  const { business } = getSettings();
  const shopName = business.legalName.trim() || BUSINESS_NAME;
  const shopAddress = business.address.trim();
  const shopPhone = business.phone.trim();
  const last = entries[entries.length - 1];

  return (
    <section
      data-testid="ledger-print-sheet"
      className="print-ledger-sheet hidden print:block text-foreground"
    >
      <div className="print-ledger-head border-b border-border pb-4">
        <h1 data-testid="ledger-print-shop-name" className="text-2xl font-bold">
          {shopName}
        </h1>
        {shopAddress && (
          <p
            data-testid="ledger-print-shop-address"
            className="whitespace-pre-line text-sm text-muted-foreground"
          >
            {shopAddress}
          </p>
        )}
        {shopPhone && (
          <p data-testid="ledger-print-shop-phone" className="text-sm text-muted-foreground">
            Phone: {shopPhone}
          </p>
        )}
      </div>

      <div className="print-ledger-party flex justify-between gap-4 py-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Customer ledger</p>
          <p data-testid="ledger-print-customer" className="font-semibold">
            {customer.name}
          </p>
          {customer.mobile && (
            <p data-testid="ledger-print-mobile" className="text-sm text-muted-foreground">
              {customer.mobile}
            </p>
          )}
        </div>
        {today && (
          <p data-testid="ledger-print-asof" className="text-sm text-muted-foreground">
            {`As of ${dayShown(today)}`}
          </p>
        )}
      </div>

      {last === undefined ? (
        <p data-testid="ledger-print-empty" className="py-4 text-sm">
          No ledger entries yet.
        </p>
      ) : (
        <>
          <table className="w-full text-xs">
            <thead>
              <tr>
                {HEADINGS.map((heading) => (
                  <th key={heading} className="px-2 py-2 text-left font-semibold uppercase">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} data-testid="ledger-print-row">
                  <td className="whitespace-nowrap">
                    {new Date(entry.date).toLocaleDateString('en-IN')}
                  </td>
                  <td>{ledgerKindLabel(entry)}</td>
                  <td>{entry.description}</td>
                  <td>{entry.reference}</td>
                  <td className="whitespace-nowrap text-right">
                    {entry.debit > 0 ? rupeesShown(entry.debit) : '—'}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {entry.credit > 0 ? rupeesShown(entry.credit) : '—'}
                  </td>
                  <td className="whitespace-nowrap text-right font-bold">
                    {balanceShown(entry.balance)}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {(entry.fineDebit ?? 0) > 0 ? gramsShown(entry.fineDebit ?? 0) : '-'}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    {(entry.fineCredit ?? 0) > 0 ? gramsShown(entry.fineCredit ?? 0) : '-'}
                  </td>
                  <td className="whitespace-nowrap text-right font-bold">
                    {fineBalanceShown(entry.fineBalance ?? 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div
            data-testid="ledger-print-totals"
            className="print-ledger-totals mt-5 ml-auto max-w-xs space-y-2 text-sm"
          >
            <div className="flex justify-between">
              <span>Total Debit</span>
              <strong data-testid="ledger-print-total-debit">
                {rupeesShown(sumRupees(entries.map((entry) => entry.debit)))}
              </strong>
            </div>
            <div className="flex justify-between">
              <span>Total Credit</span>
              <strong data-testid="ledger-print-total-credit">
                {rupeesShown(sumRupees(entries.map((entry) => entry.credit)))}
              </strong>
            </div>
            <div className="border-t border-border pt-2 flex justify-between text-lg">
              <span>Balance</span>
              <strong data-testid="ledger-print-total-balance">{balanceShown(last.balance)}</strong>
            </div>
            <div className="flex justify-between">
              <span>Silver Fine Balance</span>
              <strong data-testid="ledger-print-total-fine-balance">
                {fineBalanceShown(last.fineBalance ?? 0)}
              </strong>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

// the card is drawn again on every poll; the sheet is drawn again only when its entries are another array (a ledger of thousands of rows is not made twice for a tick of the clock)
export default React.memo(CustomerLedgerPrint);
