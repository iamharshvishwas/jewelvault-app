'use client';

import React, { useState } from 'react';
import { Save, TrendingUp } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { useSession } from '@/lib/authStore';
import { sameDecimal } from '@/lib/cache/edit';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { dayLabel } from '@/lib/rateGuard';
import {
  businessToday,
  getRateSheet,
  saveDailyRates,
  type RateEntry,
  type RateInput,
} from '@/lib/settingsStore';

// The daily metal rates (spec D4, R2, Y8; task WEB05). A rate is one row for a day, a material and a purity. The owner may enter the rates of any day up to today and correct
// today's; a biller enters today's, once for each purity, and cannot correct it. The API decides (this card only does not offer what it would refuse). A rate that is typed is
// sent, a rate that is only shown (the last one, to start from) is not: nothing is saved that the person did not type. Memory shows a correction at once; a new rate is shown
// when the server has made its row. WEB16: every purity says which day its rate is from (the prototype's "Last updated" always said today), and a rate that is not from today says that it
// is not confirmed today: the billing screen asks before the first bill of the day (src/lib/rateGuard.ts).

const keyOf = (entry: Pick<RateEntry, 'material' | 'purity'>) =>
  `${entry.material}|${entry.purity}`;
const idOf = (entry: Pick<RateEntry, 'material' | 'purity'>) =>
  `rate-${entry.material}-${entry.purity}`.toLowerCase();

export default function DashboardRateCard() {
  const { role } = useSession();
  // the card is drawn again when a poll or a save changes a rate or the list of purities
  useRowCacheVersion('daily-rates', 'settings');
  const [today] = useState(businessToday);
  const [pickedDate, setPickedDate] = useState(today);
  const [typed, setTyped] = useState<{ date: string; values: Record<string, string> }>({
    date: today,
    values: {},
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState('');

  if (role !== 'owner' && role !== 'biller') return null;
  const isOwner = role === 'owner';
  // a biller has today only (Y8)
  const date = isOwner ? pickedDate : today;
  const values = typed.date === date ? typed.values : {};
  const sheet = getRateSheet(date);

  const lastDate = sheet.reduce<string | null>((latest, entry) => {
    const shown = (entry.row ?? entry.suggestion)?.rate_date ?? null;
    return shown !== null && (latest === null || shown > latest) ? shown : latest;
  }, null);

  /** Why a purity that has a rate for the day cannot be changed here, or null. */
  const lockedReason = (entry: RateEntry): string | null => {
    if (!entry.row) return null;
    if (!isOwner) return 'Already set for today. Only the owner can correct it.';
    if (date !== today) return 'The rate of an earlier day cannot be corrected.';
    return null;
  };

  /** Which day the rate shown for a purity is from: a rate of this day, the last rate before it (to start from), or none. */
  const dateNote = (
    entry: RateEntry
  ): { text: string; state: 'today' | 'day' | 'stale' | 'missing' } => {
    if (entry.row) {
      return date === today
        ? { text: 'Set today', state: 'today' }
        : { text: `Set on ${dayLabel(entry.row.rate_date)}`, state: 'day' };
    }
    if (entry.suggestion) {
      return {
        text: `Last set ${dayLabel(entry.suggestion.rate_date)}${
          date === today ? ' · not confirmed today' : ' · no rate for this day'
        }`,
        state: 'stale',
      };
    }
    return { text: 'No rate yet', state: 'missing' };
  };

  const shownValue = (entry: RateEntry): string =>
    values[keyOf(entry)] ?? entry.row?.rate_per_gram ?? entry.suggestion?.rate_per_gram ?? '';

  const type = (entry: RateEntry, text: string) => {
    setSaved(false);
    setProblem('');
    setTyped({ date, values: { ...values, [keyOf(entry)]: text } });
  };

  const rateInputs = (): RateInput[] =>
    sheet
      .filter((entry) => {
        const text = values[keyOf(entry)];
        if (text === undefined || text.trim() === '' || lockedReason(entry) !== null) return false;
        return !(entry.row && sameDecimal(entry.row.rate_per_gram, text.trim()));
      })
      .map((entry) => ({
        material: entry.material,
        purity: entry.purity,
        rate: values[keyOf(entry)],
      }));

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setProblem('');
    try {
      const wanted = rateInputs();
      if (wanted.length === 0) {
        setProblem('Type a rate first.');
        return;
      }
      await saveDailyRates(date, wanted);
      setTyped({ date, values: {} });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'Unable to save the rates.');
    } finally {
      setSaving(false);
    }
  };

  const groups = (['Gold', 'Silver'] as const)
    .map((material) => ({ material, entries: sheet.filter((e) => e.material === material) }))
    .filter((group) => group.entries.length > 0);

  return (
    <section className="jewel-card p-4">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-sm bg-gold-subtle text-primary flex items-center justify-center">
            <TrendingUp size={17} />
          </span>
          <div>
            <h2 className="text-sm font-bold text-foreground">Daily Metal Rates</h2>
            <p className="text-xs text-muted-foreground">
              Used automatically while making estimates
            </p>
          </div>
        </div>

        <div className="flex items-end gap-3">
          {isOwner ? (
            <label className="text-xs font-semibold text-muted-foreground">
              Rates for
              <input
                type="date"
                value={date}
                max={today}
                onChange={(event) => event.target.value && setPickedDate(event.target.value)}
                className="input-field mt-1 py-2 font-tabular"
              />
            </label>
          ) : (
            <p className="text-xs font-semibold text-muted-foreground">
              Rates for today, {dayLabel(date)}
            </p>
          )}
          {/* C6, C7: off while a save runs, and while the banner "Offline: changes cannot be saved" or "Waking up…" shows */}
          <SaveButton
            onClick={save}
            disabled={saving}
            className="btn-primary py-2 self-end justify-center"
          >
            <Save size={15} />
            Save Rates
          </SaveButton>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {groups.map(({ material, entries }) => (
          <div key={material} className="flex flex-wrap items-end gap-3">
            <span className="w-14 pb-2 text-xs font-bold text-foreground">{material}</span>
            {entries.map((entry) => {
              const locked = lockedReason(entry);
              const note = dateNote(entry);
              return (
                <label
                  key={keyOf(entry)}
                  className="text-xs font-semibold text-muted-foreground"
                  title={locked ?? undefined}
                >
                  {entry.purity} (per gram)
                  <div className="relative mt-1">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      ₹
                    </span>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`${material} ${entry.purity} rate (per gram)`}
                      data-testid={idOf(entry)}
                      value={shownValue(entry)}
                      disabled={locked !== null}
                      onChange={(event) => type(entry, event.target.value)}
                      className="input-field w-32 pl-7 py-2 font-tabular"
                    />
                  </div>
                  <p
                    data-testid={`rate-date-${idOf(entry).slice('rate-'.length)}`}
                    data-state={note.state}
                    className={`mt-1 text-[10px] font-semibold ${
                      note.state === 'stale'
                        ? 'text-amber-700'
                        : note.state === 'missing'
                          ? 'text-red-600'
                          : 'text-muted-foreground'
                    }`}
                  >
                    {note.text}
                  </p>
                </label>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <p className="text-muted-foreground">
          Last updated: {lastDate ? dayLabel(lastDate) : '-'}
          {!isOwner && ' · a biller enters the rate of today only'}
        </p>
        {saved && (
          <p role="status" className="font-semibold text-emerald-600">
            Rates saved
          </p>
        )}
      </div>
      {problem && (
        <p role="alert" className="mt-2 text-xs font-semibold text-red-600">
          {problem}
        </p>
      )}
    </section>
  );
}
