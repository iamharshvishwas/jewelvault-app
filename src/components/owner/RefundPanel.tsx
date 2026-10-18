'use client';
import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle, Loader2, X } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { forgetOwnerTries, getCustomerBooks, saveRefund } from '@/lib/appStore';
import { PAYMENT_MODES, inr } from '@/lib/billing';
import { getPollState } from '@/lib/cache/poll';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  buildRefundBody,
  ownerActionFailure,
  savedRefundFrom,
  type ActionFailure,
  type SavedRefund,
} from '@/lib/ownerActions';
import { parseRupees } from '@/lib/pricing';
import { FiguresNote } from './ReasonDialog';

// The refund form (X11; spec Y1, Y10, V2, V3, V4; task WEB11): money handed back to a customer out of the advance they hold. The amount cannot be more than the advance (the API decides on
// the books as they stand after the customer is locked); the date is today; silver cannot be handed back in M1 (O24). This form is the only part of the screens that goes if X11 leaves
// M1 for lack of calendar. The panel is drawn for the owner only (the card decides).

interface RefundPanelProps {
  customerId: string;
  customerName: string;
  walkIn: boolean;
  onClose: () => void;
}

const money = (paise: number) => inr(paise, paise % 100 !== 0);

/** The starting amount: the whole advance, as text; blank when the customer holds none. */
function startingAmount(advance: string | undefined): string {
  if (!advance) return '';
  try {
    const paise = parseRupees(advance);
    return paise > 0 ? `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, '0')}` : '';
  } catch {
    return '';
  }
}

export default function RefundPanel({
  customerId,
  customerName,
  walkIn,
  onClose,
}: RefundPanelProps) {
  useRowCacheVersion('customer-balances');
  const books = getCustomerBooks(customerId);
  const [amount, setAmount] = useState(() => startingAmount(books?.advance));
  const [mode, setMode] = useState<string>('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [done, setDone] = useState<{ saved: SavedRefund; polledAt: number } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => forgetOwnerTries, []);

  const held = books ? parseRupees(books.advance) : null;

  const handleSave = async () => {
    if (inFlight.current || done) return;
    const built = buildRefundBody({ amount, mode, reference, notes });
    if ('error' in built) {
      setFailure({ message: built.error, unconfirmed: false });
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const answer = await saveRefund(customerId, built.body);
      setDone({ saved: savedRefundFrom(answer), polledAt: getPollState().polls });
    } catch (error) {
      setFailure(ownerActionFailure(error, { action: 'refund', walkIn }));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <div
      data-testid="refund-panel"
      className="jewel-card p-5 border-2 border-primary/20 bg-gold-subtle slide-up"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-foreground">Hand money back — {customerName}</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close panel"
          className="btn-ghost p-1.5"
        >
          <X size={16} />
        </button>
      </div>

      {done ? (
        <div data-testid="refund-done" className="text-center py-4">
          <CheckCircle size={24} className="text-emerald-600 mx-auto mb-2" />
          <p className="font-semibold text-foreground">Refund recorded</p>
          <p data-testid="refund-result" className="text-xs text-muted-foreground mt-1">
            {money(done.saved.amountPaise)} handed back to {customerName}
            {done.saved.mode ? ` by ${done.saved.mode}` : ''}. The customer still holds{' '}
            {money(done.saved.advanceLeftPaise)} in advance.
          </p>
          <FiguresNote polledAt={done.polledAt} />
          <button type="button" onClick={onClose} className="btn-secondary mt-3 py-2 text-xs">
            Close
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void handleSave();
          }}
          className="space-y-4"
        >
          <fieldset disabled={saving} className="space-y-4 min-w-0">
            <p data-testid="refund-books" className="text-xs text-muted-foreground">
              {held === null
                ? 'The customer’s books are loading.'
                : held > 0
                  ? `Advance held ${money(held)}: at most that can be handed back.`
                  : 'This customer holds no advance, so there is nothing to hand back.'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="text-xs font-semibold text-foreground block">
                Amount handed back (₹)
                <input
                  data-testid="refund-amount"
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  className="input-field mt-1.5 font-normal font-tabular"
                />
              </label>
              <label className="text-xs font-semibold text-foreground block">
                Mode
                <select
                  data-testid="refund-mode"
                  value={mode}
                  onChange={(event) => setMode(event.target.value)}
                  className="input-field mt-1.5 font-normal"
                >
                  {PAYMENT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-semibold text-foreground block">
                Reference
                <input
                  data-testid="refund-reference"
                  type="text"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  className="input-field mt-1.5 font-normal"
                />
              </label>
              <label className="text-xs font-semibold text-foreground block">
                Notes
                <input
                  data-testid="refund-notes"
                  type="text"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  className="input-field mt-1.5 font-normal"
                />
              </label>
            </div>
            <p className="text-[11px] text-muted-foreground">
              The refund is dated today. Silver cannot be handed back from here.
            </p>
          </fieldset>
          {failure && (
            <p
              role="alert"
              data-testid="refund-error"
              data-unconfirmed={failure.unconfirmed ? 'true' : 'false'}
              className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
            >
              {failure.message}
            </p>
          )}
          <div className="flex gap-3">
            <SaveButton
              type="submit"
              data-testid="refund-save"
              disabled={saving}
              className="btn-primary flex-1 justify-center py-2.5"
            >
              {saving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Saving…
                </>
              ) : (
                'Hand money back'
              )}
            </SaveButton>
            <button type="button" onClick={onClose} className="btn-secondary py-2.5">
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
