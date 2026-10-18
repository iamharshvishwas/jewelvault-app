// How the estimate, the customer card and the customer's ledger write a figure (spec C14: they cannot disagree, so they write it the same way). Task WEB10.
//
//   - A rupee amount is written in the Indian grouping with its paise only when it has some: ₹22,000 and ₹1,000.50, never ₹1,000.5 and never a rounded rupee. A negative one has the minus in
//     front: -₹40.
//   - A running balance (the ledger's last row, the card's "Balance") is the rupees the customer owes, or, below zero, the advance the shop holds for them, said in words: ₹2,000 advance.
//     The same for the silver: 3.500 g, or 1.000 g advance.
//   - The figures arrive as JS numbers made from the API's text (at most two decimals for money, three for grams, `src/lib/appStore.ts`), so they are turned back into whole paise and
//     milligrams here by rounding, which is exact for them, and every total is added up in those integers, never in floating point.
//
// This file keeps nothing and calls nothing.
import { inr } from './billing';
import { formatGrams } from './pricing';
import type { LedgerEntry, LedgerKind } from './mockData';

const paiseOf = (rupees: number): number => Math.round(rupees * 100);
const mgOf = (grams: number): number => Math.round(grams * 1000);

/** ₹22,000 or ₹1,000.50 (paise only when there are some); -₹40 for a negative amount. */
export function rupeesShown(rupees: number): string {
  const paise = paiseOf(rupees);
  return inr(paise, paise % 100 !== 0);
}

/** 3.500 g */
export function gramsShown(grams: number): string {
  return `${formatGrams(mgOf(grams))} g`;
}

/** A running balance: what the customer owes, or "₹2,000 advance" when it is below zero. */
export function balanceShown(rupees: number): string {
  return paiseOf(rupees) < 0 ? `${rupeesShown(-rupees)} advance` : rupeesShown(rupees);
}

/** The silver balance: "3.500 g", or "1.000 g advance" when the customer has given more than they owe. */
export function fineBalanceShown(grams: number): string {
  return mgOf(grams) < 0 ? `${gramsShown(-grams)} advance` : gramsShown(grams);
}

/** The exact total of a column of rupee amounts. */
export function sumRupees(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + paiseOf(amount), 0) / 100;
}

/** The exact total of a column of gram amounts. */
export function sumGrams(amounts: readonly number[]): number {
  return amounts.reduce((total, amount) => total + mgOf(amount), 0) / 1000;
}

// ---- the kinds of row of V3

const KIND_LABEL: Readonly<Record<LedgerKind, string>> = {
  Invoice: 'Invoice',
  Opening: 'Opening balance',
  Cancellation: 'Cancellation',
  Payment: 'Payment',
  'Opening advance': 'Opening advance',
  Fine: 'Fine',
  Refund: 'Refund',
  Void: 'Void',
};

/** The words on a row: the kind V3 gave it, or the prototype's type for an entry that has none (a preview build). */
export function ledgerKindLabel(entry: Pick<LedgerEntry, 'kind' | 'type'>): string {
  return entry.kind ? KIND_LABEL[entry.kind] : entry.type;
}

/** The rows of the Payments tab: money received, silver received and an advance brought forward (a refund is money out, a void is the reverse of a row). */
export function isPaymentEntry(entry: Pick<LedgerEntry, 'kind' | 'type'>): boolean {
  if (!entry.kind) return entry.type === 'Payment';
  return entry.kind === 'Payment' || entry.kind === 'Opening advance' || entry.kind === 'Fine';
}

/** The receipts that have been voided: V3 gives a voided receipt a second row of the kind Void with the receipt's id. */
export function voidedReceipts(entries: readonly LedgerEntry[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const entry of entries)
    if (entry.kind === 'Void' && entry.paymentId) ids.add(entry.paymentId);
  return ids;
}
