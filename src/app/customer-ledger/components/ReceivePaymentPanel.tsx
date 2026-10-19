'use client';
import React, { useEffect, useRef, useState } from 'react';
import { X, Loader2, CheckCircle } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import type { Customer, Invoice } from '@/lib/mockData';
import {
  forgetPaymentTries,
  getBillsOfCustomer,
  getCustomerBooks,
  saveFineSettlement,
  savePayment,
} from '@/lib/appStore';
import { useSession } from '@/lib/authStore';
import { PAYMENT_MODES, WALK_IN_ID, inr } from '@/lib/billing';
import { getPollState } from '@/lib/cache/poll';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  billOptionLabel,
  buildFineBody,
  buildPaymentBody,
  cashEquivalentPaise,
  payableBills,
  paymentSaveFailure,
  savedFineFrom,
  savedPaymentFrom,
  type PaymentFailure,
  type SavedFine,
  type SavedPayment,
} from '@/lib/payments';
import { LIMITS, formatGrams, formatRupees, parseGrams, parseRupees } from '@/lib/pricing';
import { FineSaved, PaymentSaved } from './PaymentSaved';

// The payment and silver-fine panel of the customer card (spec C5 (b), C6, C7, C13, C17, X2, X3, Y3, Y5, SF1, SF2, Z1, Z2, K5; task WEB09). It calls record_payment (X2) and settle_fine
// (X3) with an Idempotency-Key for each user action (the same key when the same payment is saved again after a call that did not end well), shows a saving state, shows the result only
// from the API's answer (each bill the money went to, what is kept as advance, the fine that is left), and says in plain words why a save was refused. After the write the client polls
// at once (C17), so the customer's outstanding and advance in this panel and on the card are read again from the server. The five payment modes of D13 are the only ones: there is no Credit.

interface ReceivePaymentPanelProps {
  customer: Customer;
  /** The prototype's list of the customer's invoices, kept so that the card need not change. The panel reads the customer's bills (the opening-balance bill included) itself. */
  invoices?: Invoice[];
  onClose: () => void;
}

type Kind = 'Amount' | 'Fine Silver' | 'Fine Cash';

type Done =
  | { type: 'payment'; saved: SavedPayment; polls: number }
  | { type: 'fine'; saved: SavedFine; polls: number };

/** The starting text of a field from a figure of the card: blank for nothing owed. */
function startingText(value: number, scale: 2 | 3): string {
  if (!(value > 0)) return '';
  try {
    return scale === 2 ? formatRupees(parseRupees(value)) : formatGrams(parseGrams(value));
  } catch {
    return String(value);
  }
}

/** A refusal on the screen, before any call: the sentence, and nothing else to do. */
const refusedOnScreen = (message: string): PaymentFailure => ({
  message,
  cashLimit: null,
  unconfirmed: false,
});

const rupeesOfText = (text: string): number | null => {
  try {
    const paise = parseRupees(text.trim());
    return paise > 0 ? paise : null;
  } catch {
    return null;
  }
};

export default function ReceivePaymentPanel({ customer, onClose }: ReceivePaymentPanelProps) {
  const { role } = useSession();
  const walkIn = customer.id === WALK_IN_ID;
  const [kind, setKind] = useState<Kind>('Amount');
  // the walk-in's dues are many strangers' dues: it names its bill, so nothing is filled in for it
  const [amount, setAmount] = useState(() => (walkIn ? '' : startingText(customer.outstanding, 2)));
  const [mode, setMode] = useState<string>('UPI');
  const [grams, setGrams] = useState(() =>
    walkIn ? '' : startingText(customer.outstandingSilverFine ?? 0, 3)
  );
  const [rate, setRate] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [billId, setBillId] = useState('');
  const [cashReason, setCashReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PaymentFailure | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // C6: a second click before the first answer is ignored. The ref answers at once, before the button has been drawn disabled.
  const inFlight = useRef(false);

  // memory changes with every poll and every answer: draw again (the bills, the customer's V2)
  useRowCacheVersion('bills', 'bill-summary', 'customer-balances');

  // the panel being closed ends the user action: a payment that could not be confirmed is not asked for again with its old key
  useEffect(() => forgetPaymentTries, []);

  const books = getCustomerBooks(customer.id);
  const outstandingNow = books
    ? inr(parseRupees(books.outstanding))
    : inr(Math.round(customer.outstanding * 100));
  const advanceNow = books ? inr(parseRupees(books.advance)) : null;
  const fineNow = books
    ? formatGrams(parseGrams(books.fineOutstanding))
    : (customer.outstandingSilverFine ?? 0).toFixed(3);

  const fine = kind !== 'Amount';
  const bills = payableBills(getBillsOfCustomer(customer.id), fine ? 'fine' : 'money');
  const equivalent = kind === 'Fine Cash' ? cashEquivalentPaise(grams, rate) : null;

  const switchKind = (next: Kind) => {
    setKind(next);
    setBillId(''); // the bills with money pending and the bills with silver pending are not the same list
    setFailure(null);
  };

  /** Runs one save: the saving state, the answer shown only when it has come, the plain sentence when it has not. A second call while one is on its way is ignored (C6). */
  const send = async (call: () => Promise<Done>) => {
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      setDone(await call());
    } catch (error) {
      setFailure(paymentSaveFailure(error, { role, walkIn, kind: fine ? 'fine' : 'payment' }));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  // C5 (b): never optimistic. The panel shows a saving state, calls X2 or X3 with an Idempotency-Key for this action (the same key when this is the same payment pressed again after a call
  // that did not end well, C6, L5), and shows the result only from the API's answer. On a failure it says why, in plain words, and changes nothing.
  const handleSave = async () => {
    if (inFlight.current || done) return;
    const cashOverrideReason = role === 'owner' ? cashReason : '';
    if (kind === 'Amount') {
      const built = buildPaymentBody({
        amount,
        mode,
        billId,
        reference,
        notes,
        cashOverrideReason,
      });
      if ('error' in built) return setFailure(refusedOnScreen(built.error));
      await send(async () => ({
        type: 'payment',
        saved: savedPaymentFrom(await savePayment(customer.id, built.body)),
        polls: getPollState().polls,
      }));
    } else {
      const built = buildFineBody({
        grams,
        mode: kind === 'Fine Cash' ? 'Cash' : 'Silver',
        silverRate: rate,
        billId,
        reference,
        notes,
        cashOverrideReason,
      });
      if ('error' in built) return setFailure(refusedOnScreen(built.error));
      await send(async () => ({
        type: 'fine',
        saved: savedFineFrom(await saveFineSettlement(customer.id, built.body)),
        polls: getPollState().polls,
      }));
    }
  };

  const reasonShown = (failure?.cashLimit?.ownerMayGiveReason ?? false) || cashReason !== '';
  const typedPaise = kind === 'Amount' ? rupeesOfText(amount) : null;
  const typedMg = (() => {
    if (!fine) return null;
    try {
      const mg = parseGrams(grams.trim());
      return mg > 0 ? mg : null;
    } catch {
      return null;
    }
  })();

  return (
    <div
      data-testid="payment-panel"
      className="jewel-card p-5 border-2 border-primary/20 bg-gold-subtle slide-up"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-foreground">Receive Payment — {customer.name}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="btn-ghost p-1.5"
        >
          <X size={16} />
        </button>
      </div>

      {done?.type === 'payment' ? (
        <PaymentSaved
          customerId={customer.id}
          customerName={customer.name}
          saved={done.saved}
          polledAt={done.polls}
          onClose={onClose}
        />
      ) : done?.type === 'fine' ? (
        <FineSaved customerName={customer.name} saved={done.saved} onClose={onClose} />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
          className="space-y-4"
        >
          <fieldset disabled={saving} className="space-y-4 min-w-0">
            <p data-testid="payment-books" className="text-xs text-muted-foreground">
              Outstanding {outstandingNow}
              {advanceNow !== null && ` · Advance held ${advanceNow}`}
              {` · Silver fine due ${fineNow} g`}
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="sm:col-span-2">
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Settlement Type
                  <select
                    data-testid="payment-type"
                    value={kind}
                    onChange={(event) => switchKind(event.target.value as Kind)}
                    className="input-field mt-1.5 font-normal"
                  >
                    <option value="Amount">Amount Payment</option>
                    <option value="Fine Silver">Silver Fine Received</option>
                    <option value="Fine Cash">Silver Fine Settled by Cash Rate</option>
                  </select>
                </label>
              </div>

              {kind === 'Amount' ? (
                <>
                  <div>
                    <label className="text-xs font-semibold text-foreground block mb-1.5">
                      Amount (₹) <span className="text-red-500">*</span>
                      <input
                        data-testid="payment-amount"
                        type="text"
                        inputMode="decimal"
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        className="input-field mt-1.5 font-tabular text-lg font-bold"
                      />
                    </label>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-foreground block mb-1.5">
                      Payment Mode <span className="text-red-500">*</span>
                      <select
                        data-testid="payment-mode"
                        value={mode}
                        onChange={(event) => setMode(event.target.value)}
                        className="input-field mt-1.5 font-normal"
                      >
                        {PAYMENT_MODES.map((m) => (
                          <option key={`pmmode-${m}`} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <label className="text-xs font-semibold text-foreground block mb-1.5">
                      Fine Grams <span className="text-red-500">*</span>
                      <input
                        data-testid="fine-grams"
                        type="text"
                        inputMode="decimal"
                        value={grams}
                        onChange={(event) => setGrams(event.target.value)}
                        className="input-field mt-1.5 font-tabular text-lg font-bold"
                      />
                    </label>
                  </div>

                  {kind === 'Fine Cash' && (
                    <div>
                      <label className="text-xs font-semibold text-foreground block mb-1.5">
                        Silver Rate / g <span className="text-red-500">*</span>
                        <input
                          data-testid="fine-rate"
                          type="text"
                          inputMode="decimal"
                          value={rate}
                          onChange={(event) => setRate(event.target.value)}
                          className="input-field mt-1.5 font-tabular text-lg font-bold"
                        />
                      </label>
                      {equivalent !== null && equivalent <= LIMITS.maxAmountPaise && (
                        <p
                          data-testid="fine-cash-equivalent"
                          className="text-xs text-muted-foreground mt-1"
                        >
                          Cash equivalent: {inr(equivalent)}
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Reference / UTR
                  <input
                    data-testid="payment-reference"
                    type="text"
                    value={reference}
                    onChange={(event) => setReference(event.target.value)}
                    placeholder="e.g. UPI-9923411"
                    className="input-field mt-1.5 font-mono font-normal"
                  />
                </label>
                <p className="text-xs text-muted-foreground mt-1">
                  UPI transaction ID, cheque number, etc.
                </p>
              </div>

              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Against Invoice
                  <select
                    data-testid="payment-bill"
                    value={billId}
                    onChange={(event) => setBillId(event.target.value)}
                    className="input-field mt-1.5 font-normal"
                  >
                    <option value="">
                      {walkIn ? '— Choose the bill —' : '— Apply to oldest outstanding —'}
                    </option>
                    {bills.map((bill) => (
                      <option key={bill.id} value={bill.id}>
                        {billOptionLabel(bill, fine ? 'fine' : 'money')}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="text-xs text-muted-foreground mt-1">
                  {walkIn
                    ? 'The walk-in customer must name the bill.'
                    : 'Leave blank to apply to oldest outstanding'}
                </p>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-foreground block mb-1.5">
                Notes
                <textarea
                  data-testid="payment-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  rows={2}
                  placeholder="Additional notes..."
                  className="input-field resize-none text-sm mt-1.5 font-normal"
                />
              </label>
            </div>

            {/* Z1: the owner may give a reason for cash over the limit; a biller cannot, the owner enters that payment */}
            {reasonShown && (
              <div>
                <label className="text-xs font-semibold text-foreground block mb-1.5">
                  Reason for cash over the limit (owner)
                  <textarea
                    data-testid="cash-reason"
                    value={cashReason}
                    onChange={(event) => setCashReason(event.target.value)}
                    placeholder="At least 10 characters"
                    rows={2}
                    className="input-field resize-none text-sm mt-1.5 font-normal"
                  />
                </label>
              </div>
            )}
          </fieldset>

          {failure && (
            <div
              role="alert"
              data-testid="payment-error"
              className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
            >
              {failure.message}
            </div>
          )}

          <div className="flex gap-3">
            <SaveButton
              type="submit"
              data-testid="save-payment"
              disabled={saving}
              className="btn-primary flex-1 justify-center py-2.5"
            >
              {saving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Recording...
                </>
              ) : (
                <>
                  <CheckCircle size={15} />
                  {kind === 'Amount'
                    ? `Record Payment${typedPaise !== null ? ` · ${inr(typedPaise, typedPaise % 100 !== 0)}` : ''}`
                    : `Settle Fine${typedMg !== null ? ` · ${formatGrams(typedMg)} g` : ''}`}
                </>
              )}
            </SaveButton>
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="btn-secondary py-2.5"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
