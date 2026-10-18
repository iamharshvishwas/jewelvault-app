'use client';

import React, { useState } from 'react';
import { Save, TrendingUp } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { useSession } from '@/lib/authStore';
import { sameDecimal } from '@/lib/cache/edit';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import {
  businessToday,
  getRateSheet,
  rateEntryFor,
  saveDailyRates,
  type RateEntry,
  type RateInput,
  type RateMaterial,
} from '@/lib/settingsStore';

// The daily metal rates (spec D4, R2, Y8; task WEB05). A rate is one row for a day, a material and a purity. The owner may enter the rates of any day up to today and correct
// today's; a biller enters today's, once for each purity, and cannot correct it. The API decides (this card only does not offer what it would refuse). A rate that is typed is
// sent, a rate that is only shown (the last one, to start from) is not: nothing is saved that the person did not type. Memory shows a correction at once; a new rate is shown
// when the server has made its row.
//
// Task WEB16 (P3-T2): every purity says what its rate is - "Confirmed today" for a row dated the day shown, else the real date of the last rate and that it is not confirmed (the
// prototype's "Last updated" said today whatever the data). The same card is the question the billing screen asks before the first bill of the day (`confirmToday`): only the
// purities of the bill, for today, and its one button is a person saying that the rates shown are right - those are then written as the rates of today, a row each, by the same
// calls (`saveDailyRates`), as the person who confirmed them (`confirmed_by` is the API's, S6).

const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

const keyOf = (entry: Pick<RateEntry, 'material' | 'purity'>) =>
  `${entry.material}|${entry.purity}`;
const idOf = (entry: Pick<RateEntry, 'material' | 'purity'>) =>
  `rate-${entry.material}-${entry.purity}`.toLowerCase();

export interface RateCardProps {
  /**
   * The billing screen's question (WEB16): only these purities are shown, for today even to the owner, each starting from its last rate (else from `onBill`, what the line carries),
   * and the button confirms what is shown instead of saving only what was typed.
   */
  confirmToday?: ReadonlyArray<{ material: RateMaterial; purity: string; onBill?: string }>;
}

/** What a purity's rate is, for the person: the real date of the rate shown and whether it is confirmed for the day. */
function stateOf(entry: RateEntry, date: string, today: string): { text: string; tone: string } {
  if (entry.row)
    return {
      text: date === today ? 'Confirmed today' : `Rate of ${dayLabel(entry.row.rate_date)}`,
      tone: 'text-emerald-700',
    };
  if (entry.suggestion)
    return {
      text:
        date === today
          ? `Rate of ${dayLabel(entry.suggestion.rate_date)}, not confirmed today`
          : `Last rate: ${dayLabel(entry.suggestion.rate_date)}, none for this day`,
      tone: 'text-amber-700',
    };
  return { text: 'No rate yet', tone: 'text-red-600' };
}

export default function DashboardRateCard({ confirmToday }: RateCardProps = {}) {
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
  const confirming = confirmToday !== undefined;
  // a biller has today only (Y8), and so has the question of the billing screen
  const date = isOwner && !confirming ? pickedDate : today;
  const values = typed.date === date ? typed.values : {};
  const sheet = confirmToday
    ? confirmToday.map((wanted) => rateEntryFor(wanted.material, wanted.purity, date))
    : getRateSheet(date);
  const starts = Object.fromEntries(
    (confirmToday ?? []).map((wanted) => [keyOf(wanted), wanted.onBill ?? ''])
  );

  const lastDate = sheet.reduce<string | null>((latest, entry) => {
    const shown = (entry.row ?? entry.suggestion)?.rate_date ?? null;
    return shown !== null && (latest === null || shown > latest) ? shown : latest;
  }, null);

  /** Why a purity that has a rate for the day cannot be changed here, or null. */
  const lockedReason = (entry: RateEntry): string | null => {
    if (!entry.row) return null;
    if (confirming) return 'Already confirmed for today.';
    if (!isOwner) return 'Already set for today. Only the owner can correct it.';
    if (date !== today) return 'The rate of an earlier day cannot be corrected.';
    return null;
  };

  const shownValue = (entry: RateEntry): string =>
    values[keyOf(entry)] ??
    entry.row?.rate_per_gram ??
    entry.suggestion?.rate_per_gram ??
    starts[keyOf(entry)] ??
    '';

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

  /** The question of the billing screen: every purity without a row for today, at the rate shown (typed, else the last one, else the line's). Nothing is sent if one is blank. */
  const confirmInputs = (): RateInput[] | string => {
    const out: RateInput[] = [];
    for (const entry of sheet) {
      if (entry.row) continue;
      const text = shownValue(entry).trim();
      if (text === '') return `Enter the ${entry.material} ${entry.purity} rate first.`;
      out.push({ material: entry.material, purity: entry.purity, rate: text });
    }
    return out;
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setProblem('');
    try {
      const wanted = confirming ? confirmInputs() : rateInputs();
      if (typeof wanted === 'string') {
        setProblem(wanted);
        return;
      }
      if (wanted.length === 0) {
        if (!confirming) setProblem('Type a rate first.');
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

  /** What the card names under its rates when the day shown is today: the purities that have a rate, and an old one, but none for today (a purity that never had one says "No rate yet"). */
  const unconfirmed = sheet.filter((entry) => !entry.row && entry.suggestion !== undefined);

  const groups = (['Gold', 'Silver'] as const)
    .map((material) => ({ material, entries: sheet.filter((e) => e.material === material) }))
    .filter((group) => group.entries.length > 0);

  return (
    <section className="jewel-card p-4" data-testid={confirming ? 'rate-confirm' : 'rate-card'}>
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="w-8 h-8 rounded-sm bg-gold-subtle text-primary flex items-center justify-center">
            <TrendingUp size={17} />
          </span>
          <div>
            <h2 className="text-sm font-bold text-foreground">
              {confirming ? 'Rate per gram' : 'Daily Metal Rates'}
            </h2>
            <p className="text-xs text-muted-foreground">
              {confirming
                ? 'Check each rate and change it if it is not right, then confirm'
                : 'Used automatically while making estimates'}
            </p>
          </div>
        </div>

        <div className="flex items-end gap-3">
          {isOwner && !confirming ? (
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
            {confirming ? "Confirm today's rates" : 'Save Rates'}
          </SaveButton>
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {groups.map(({ material, entries }) => (
          <div key={material} className="flex flex-wrap items-start gap-3">
            <span className="w-14 pt-6 text-xs font-bold text-foreground">{material}</span>
            {entries.map((entry) => {
              const locked = lockedReason(entry);
              const state = stateOf(entry, date, today);
              return (
                <div key={keyOf(entry)} className="text-xs">
                  <label
                    className="font-semibold text-muted-foreground"
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
                        // the global `.input-field` padding wins over `pl-7`, which put the rupee sign over the first digit of the rate
                        style={{ paddingLeft: '1.75rem' }}
                      />
                    </div>
                  </label>
                  <p
                    data-testid={`${idOf(entry)}-state`}
                    className={`mt-1 max-w-[8.5rem] text-[11px] font-semibold ${state.tone}`}
                  >
                    {state.text}
                  </p>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs">
        <div>
          {!confirming && (
            <p className="text-muted-foreground">
              Last updated: {lastDate ? dayLabel(lastDate) : '-'}
              {!isOwner && ' · a biller enters the rate of today only'}
            </p>
          )}
          {!confirming && date === today && unconfirmed.length > 0 && (
            <p data-testid="rate-unconfirmed" className="mt-0.5 font-semibold text-amber-700">
              {`Not confirmed today: ${unconfirmed.map((e) => `${e.material} ${e.purity}`).join(', ')}`}
            </p>
          )}
        </div>
        {saved && (
          <p role="status" className="font-semibold text-emerald-600">
            {confirming ? 'Rates confirmed' : 'Rates saved'}
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
