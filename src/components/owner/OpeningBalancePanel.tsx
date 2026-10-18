'use client';
import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle, Loader2, X } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { forgetOwnerTries, saveOpeningBalance } from '@/lib/appStore';
import { inr } from '@/lib/billing';
import { getPollState } from '@/lib/cache/poll';
import {
  buildOpeningBody,
  ownerActionFailure,
  savedOpeningFrom,
  type ActionFailure,
  type SavedOpening,
} from '@/lib/ownerActions';
import { formatGrams } from '@/lib/pricing';
import { businessToday } from '@/lib/settingsStore';
import { FiguresNote } from './ReasonDialog';

// The opening-balance form (X12; spec D15, IM5, Y8, K5; task WEB11): what a customer owed on the first day (dues, and silver due) and what they had paid in advance (money, and silver),
// dated by the owner (any day up to today). Used for the corrections after the import and for customers created later. Dues make an opening bill (OB-nnnn) that is not a sale; an advance is a
// receipt; an advance and dues of one customer net off. The walk-in customer holds no advance (K5): its form takes dues only. The panel is drawn for the owner only (the card decides).

interface OpeningBalancePanelProps {
  customerId: string;
  customerName: string;
  walkIn: boolean;
  onClose: () => void;
}

const money = (paise: number) => inr(paise, paise % 100 !== 0);

export default function OpeningBalancePanel({
  customerId,
  customerName,
  walkIn,
  onClose,
}: OpeningBalancePanelProps) {
  const today = businessToday();
  const [dues, setDues] = useState('');
  const [fineDue, setFineDue] = useState('');
  const [advance, setAdvance] = useState('');
  const [fineAdvance, setFineAdvance] = useState('');
  const [asOf, setAsOf] = useState(today);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ActionFailure | null>(null);
  const [done, setDone] = useState<{ saved: SavedOpening; polledAt: number } | null>(null);
  const inFlight = useRef(false);

  useEffect(() => forgetOwnerTries, []);

  const handleSave = async () => {
    if (inFlight.current || done) return;
    const built = buildOpeningBody({ dues, fineDue, advance, fineAdvance, asOf, walkIn });
    if ('error' in built) {
      setFailure({ message: built.error, unconfirmed: false });
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setFailure(null);
    try {
      const answer = await saveOpeningBalance(customerId, built.body);
      setDone({ saved: savedOpeningFrom(answer), polledAt: getPollState().polls });
    } catch (error) {
      setFailure(ownerActionFailure(error, { action: 'opening', walkIn }));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  const field = (
    testId: string,
    label: string,
    value: string,
    set: (text: string) => void,
    disabled = false
  ) => (
    <label className="text-xs font-semibold text-foreground block">
      {label}
      <input
        data-testid={testId}
        type="text"
        inputMode="decimal"
        value={value}
        disabled={disabled}
        onChange={(event) => set(event.target.value)}
        className="input-field mt-1.5 font-normal font-tabular"
      />
    </label>
  );

  return (
    <div
      data-testid="opening-panel"
      className="jewel-card p-5 border-2 border-primary/20 bg-gold-subtle slide-up"
    >
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-foreground">Opening balance — {customerName}</h3>
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
        <div data-testid="opening-done" className="text-center py-4">
          <CheckCircle size={24} className="text-emerald-600 mx-auto mb-2" />
          <p className="font-semibold text-foreground">Opening balance recorded</p>
          <ul data-testid="opening-result" className="mt-2 space-y-0.5 text-xs text-foreground">
            {done.saved.billNo && (
              <li>
                {done.saved.billNo}: {money(done.saved.duesPaise)} dues
                {done.saved.fineDueMg > 0 &&
                  ` and ${formatGrams(done.saved.fineDueMg)} g silver`}{' '}
                brought forward
              </li>
            )}
            {done.saved.advancePaise > 0 && <li>{money(done.saved.advancePaise)} advance</li>}
            {done.saved.fineAdvanceMg > 0 && (
              <li>{formatGrams(done.saved.fineAdvanceMg)} g silver advance</li>
            )}
            {(done.saved.nettedPaise > 0 || done.saved.nettedFineMg > 0) && (
              <li>
                Netted off against the dues
                {done.saved.nettedPaise > 0 && `: ${money(done.saved.nettedPaise)}`}
                {done.saved.nettedFineMg > 0 &&
                  `, ${formatGrams(done.saved.nettedFineMg)} g silver`}
              </li>
            )}
          </ul>
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
            <p className="text-xs text-muted-foreground">
              What {customerName} owed, or had paid in advance, on the day. Leave a figure blank
              when there is none. Dues make an opening bill; an advance and dues net off.
              {walkIn &&
                ' The walk-in customer stands for many people and holds no advance: enter dues only.'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {field('opening-dues', 'Dues (₹)', dues, setDues)}
              {field('opening-fine-due', 'Silver due (g)', fineDue, setFineDue)}
              {field('opening-advance', 'Advance paid (₹)', advance, setAdvance, walkIn)}
              {field(
                'opening-fine-advance',
                'Silver advance (g)',
                fineAdvance,
                setFineAdvance,
                walkIn
              )}
              <label className="text-xs font-semibold text-foreground block">
                Dated
                <input
                  data-testid="opening-date"
                  type="date"
                  value={asOf}
                  max={today}
                  onChange={(event) => setAsOf(event.target.value)}
                  className="input-field mt-1.5 font-normal"
                />
              </label>
            </div>
          </fieldset>
          {failure && (
            <p
              role="alert"
              data-testid="opening-error"
              data-unconfirmed={failure.unconfirmed ? 'true' : 'false'}
              className="rounded-sm border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700"
            >
              {failure.message}
            </p>
          )}
          <div className="flex gap-3">
            <SaveButton
              type="submit"
              data-testid="opening-save"
              disabled={saving}
              className="btn-primary flex-1 justify-center py-2.5"
            >
              {saving ? (
                <>
                  <Loader2 size={15} className="animate-spin" />
                  Saving…
                </>
              ) : (
                'Add opening balance'
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
