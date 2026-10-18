'use client';
import React from 'react';
import { CheckCircle } from 'lucide-react';
import { billNumberOf, getCustomerBooks } from '@/lib/appStore';
import { inr } from '@/lib/billing';
import { usePollState } from '@/lib/cache/poll';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import type { SavedFine, SavedPayment } from '@/lib/payments';
import { formatGrams, parseRupees } from '@/lib/pricing';

// What the panel shows once the API has answered (spec C5 (b), C17; task WEB09). Every figure is the API's: the parts are the allocation rows of the answer, the advance and the fine
// remaining are the figures it sent, and the customer's outstanding and advance are the row of V2 in memory. That row arrives with the poll the client makes at once after the write,
// so until a poll has finished after the answer the line says the figures are being updated, rather than show the books as they were before the payment.

interface SavedProps {
  customerId: string;
  customerName: string;
  /** `getPollState().polls` when the answer arrived: a poll that finishes after it has read the books again. */
  polledAt: number;
  onClose: () => void;
}

const billName = (billId: string): string => billNumberOf(billId) ?? 'a bill';
const paise = (value: number): string => inr(value);

export function PaymentSaved({
  customerId,
  customerName,
  saved,
  polledAt,
  onClose,
}: SavedProps & { saved: SavedPayment }) {
  const poll = usePollState();
  useRowCacheVersion('customer-balances', 'bills');
  const books = getCustomerBooks(customerId);
  const fresh = books !== null && poll.polls > polledAt;
  const held = fresh ? parseRupees(books.advance) : 0;
  return (
    <div data-testid="payment-saved" className="text-center py-4">
      <CheckCircle size={24} className="text-emerald-600 mx-auto mb-2" />
      <p className="font-semibold text-foreground">Payment Recorded</p>
      <p className="text-xs text-muted-foreground mt-1">
        {paise(saved.amount)} received from {customerName}
        {saved.mode ? ` by ${saved.mode}` : ''}
      </p>
      {saved.parts.length > 0 && (
        <ul data-testid="payment-parts" className="mt-2 space-y-0.5 text-xs text-foreground">
          {saved.parts.map((part) => (
            <li key={part.billId} data-testid="payment-part">
              {paise(part.paise)} to {billName(part.billId)}
            </li>
          ))}
        </ul>
      )}
      {saved.adjusted.length > 0 && (
        <p data-testid="payment-adjusted" className="mt-1 text-xs font-semibold text-emerald-700">
          Advance adjusted:{' '}
          {saved.adjusted
            .map((part) => `${paise(part.paise)} to ${billName(part.billId)}`)
            .join(', ')}
        </p>
      )}
      {saved.advanceRemaining > 0 && (
        <p data-testid="payment-advance" className="mt-1 text-xs font-semibold text-emerald-700">
          Kept as advance: {paise(saved.advanceRemaining)}
        </p>
      )}
      <p data-testid="payment-remaining" className="mt-1 text-xs text-muted-foreground">
        {fresh
          ? `Remaining amount outstanding: ${paise(parseRupees(books.outstanding))}`
          : 'Updating the figures…'}
      </p>
      {held > 0 && (
        <p data-testid="payment-books-advance" className="text-xs text-muted-foreground">
          Advance held by this customer: {paise(held)}
        </p>
      )}
      <button type="button" onClick={onClose} className="btn-secondary mt-3 py-2 text-xs">
        Close
      </button>
    </div>
  );
}

export function FineSaved({
  customerName,
  saved,
  onClose,
}: Omit<SavedProps, 'customerId' | 'polledAt'> & { saved: SavedFine }) {
  const cash = saved.kind === 'fine_cash';
  return (
    <div data-testid="fine-saved" className="text-center py-4">
      <CheckCircle size={24} className="text-emerald-600 mx-auto mb-2" />
      <p className="font-semibold text-foreground">Silver Fine Settled</p>
      <p className="text-xs text-muted-foreground mt-1">
        {formatGrams(saved.grams)} g silver fine {cash ? 'settled by cash' : 'received'} for{' '}
        {customerName}
      </p>
      {cash && (
        <p data-testid="fine-cash" className="text-xs text-muted-foreground">
          Cash equivalent: {paise(saved.amount)}
          {saved.silverRate !== null ? ` at ${paise(saved.silverRate)} a gram` : ''}
        </p>
      )}
      {saved.parts.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-foreground">
          {saved.parts.map((part) => (
            <li key={part.billId} data-testid="fine-part">
              {formatGrams(part.mg)} g against {billName(part.billId)}
            </li>
          ))}
        </ul>
      )}
      {saved.adjusted.length > 0 && (
        <p className="mt-1 text-xs font-semibold text-emerald-700">
          Silver adjusted:{' '}
          {saved.adjusted
            .map((part) => `${formatGrams(part.mg)} g against ${billName(part.billId)}`)
            .join(', ')}
        </p>
      )}
      <p data-testid="fine-remaining" className="mt-1 text-xs text-muted-foreground">
        Remaining silver fine: {formatGrams(saved.fineRemaining)} g
      </p>
      <button type="button" onClick={onClose} className="btn-secondary mt-3 py-2 text-xs">
        Close
      </button>
    </div>
  );
}
