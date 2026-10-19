'use client';
import React, { useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import {
  confirmationInputs,
  dayLabel,
  startingValues,
  type UnconfirmedRate,
} from '@/lib/rateGuard';
import { saveDailyRates } from '@/lib/settingsStore';

// WEB16 (PLAN.md P3-T2, spec D4, R2): the question before the first bill of the day. The rates this bill uses were not confirmed today: each purity shows the last rate and the day it
// comes from, in a field to confirm or change. "Confirm today's rates" writes a rate dated today for every purity with something in its field (the owner or a biller may, Y8), which makes
// them confirmed; "Bill with the rates as they are" answers the question without writing anything, and the bill then carries RATE_STALE or RATE_MISSING as the API says. Neither touches a
// line: the rate of every line stays editable.

interface RateGuardPanelProps {
  entries: readonly UnconfirmedRate[];
  today: string;
  /** Today's rates were written: the lines that still follow the default take them. */
  onConfirmed: () => void;
  /** The person billed with the rates as they are: do not ask again today. */
  onAcknowledged: () => void;
}

const rupees = (text: string): string =>
  `₹${Number(text).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const idOf = (entry: UnconfirmedRate) => `${entry.material}-${entry.purity}`.toLowerCase();

export default function RateGuardPanel({
  entries,
  today,
  onConfirmed,
  onAcknowledged,
}: RateGuardPanelProps) {
  // what the person typed over the starting values, by purity; a purity that was not touched shows its last rate
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState('');
  const busy = useRef(false); // C6: a second click before the first answer is ignored
  const values = { ...startingValues(entries), ...typed };

  const confirm = async () => {
    if (busy.current) return;
    const inputs = confirmationInputs(entries, values);
    if (inputs.length === 0) {
      setProblem('Type a rate first.');
      return;
    }
    busy.current = true;
    setSaving(true);
    setProblem('');
    try {
      await saveDailyRates(today, inputs);
      onConfirmed();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The rates could not be saved.');
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  return (
    <section
      data-testid="rate-guard"
      aria-label="Confirm today's rates"
      className="jewel-card border border-amber-300 bg-amber-50 p-4"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 flex-shrink-0 text-amber-600" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-bold text-foreground">
            Confirm today&apos;s rates before the first bill of the day
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            No rate dated today ({dayLabel(today)}) is set for what is on this bill. Check the rate
            of each purity and confirm it, or bill with the rates as they are. The rate on every
            line can still be changed.
          </p>

          <div className="mt-3 space-y-2">
            {entries.map((entry) => (
              <div
                key={entry.key}
                data-testid={`rate-guard-row-${idOf(entry)}`}
                className="flex flex-wrap items-end gap-3"
              >
                <label className="text-xs font-semibold text-foreground">
                  {entry.material} {entry.purity}
                  <div className="relative mt-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      ₹
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`${entry.material} ${entry.purity} rate today (per gram)`}
                      data-testid={`rate-guard-${idOf(entry)}`}
                      value={values[entry.key] ?? ''}
                      onChange={(event) => {
                        setProblem('');
                        setTyped((before) => ({ ...before, [entry.key]: event.target.value }));
                      }}
                      className="input-field w-32 py-2 pl-7 font-tabular"
                    />
                  </div>
                </label>
                <p className="pb-2 text-xs text-amber-800">
                  {entry.status === 'stale' && entry.lastDate && entry.lastRate
                    ? `last set ${dayLabel(entry.lastDate)} at ${rupees(entry.lastRate)}`
                    : 'No rate has been set yet: type one, or type it on the line'}
                </p>
              </div>
            ))}
          </div>

          {problem && (
            <p
              role="alert"
              data-testid="rate-guard-error"
              className="mt-2 text-xs font-semibold text-red-600"
            >
              {problem}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* C6, C7: off while a save runs, and while the banner "Offline: changes cannot be saved" or "Waking up…" shows */}
            <SaveButton
              type="button"
              data-testid="rate-guard-confirm"
              onClick={confirm}
              disabled={saving}
              className="btn-primary py-2 text-xs"
            >
              {saving ? 'Saving…' : "Confirm today's rates"}
            </SaveButton>
            <button
              type="button"
              data-testid="rate-guard-skip"
              onClick={onAcknowledged}
              disabled={saving}
              className="btn-secondary py-2 text-xs"
            >
              Bill with the rates as they are
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
