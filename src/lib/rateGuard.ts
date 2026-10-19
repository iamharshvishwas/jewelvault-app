// The stale-rate guard (task WEB16; PLAN.md P3-T2, the part that stays; spec D4, R2, Y8): a daily rate that was not confirmed today asks for confirmation before the first bill of the day.
//
// "Confirmed today" is a `daily_rates` row dated today for the material and purity (D4: the API forces `confirmed_by` on every row, so a row is a person's yes). The guard looks at the By
// Weight lines of the bill, because only they take a daily rate (R2; a Per Piece line has the piece price): a line whose material and purity have no rate dated today is listed, with the last
// rate and its day to start from (a stale rate, which the API would warn RATE_STALE for) or with nothing (no rate at all, RATE_MISSING). It asks
//   - only for a bill dated today (a back-dated bill takes the rate of its own day, and the API warns RATE_STALE on the saved bill),
//   - only while no bill dated today exists yet (an opening-balance bill is dues brought forward, not a bill of the day), and
//   - only until the person has answered for the day, either by confirming (which writes today's rate, so the rate is dated today and the question is gone) or by billing with the rates as
//     they are (the saved bill carries RATE_STALE or RATE_MISSING as the API says).
// Nothing here changes a line: the rate on every line stays editable whatever the answer is. Everything is in memory (C8).
import { defaultMetalRate, formatRupees, type DailyRateLike } from '@/lib/pricing';
import type { BillingItem } from './billing';
import { rowCache } from './cache/cache';
import { PREVIEW_MODE } from './previewMode';
import type { RateInput, RateMaterial } from './settingsStore';

/** `2026-10-12` as `12 Oct 2026`: a business date written the way the rate card and the guard show it. */
export const dayLabel = (date: string): string =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** One purity of one material that the bill uses and that has no rate dated today. */
export interface UnconfirmedRate {
  /** `Gold|22K`: the key of the purity in the panel's fields. */
  key: string;
  material: RateMaterial;
  purity: string;
  /** 'stale': there is an older rate to start from. 'missing': no rate at all. */
  status: 'stale' | 'missing';
  /** The day of the last rate and the rate itself (two-decimal text), for 'stale'. */
  lastDate: string | null;
  lastRate: string | null;
}

/** The purities the By Weight lines of the bill use that have no rate dated today (or, for a bill of another day, dated that day), in the order Gold before Silver, then by purity. */
export function unconfirmedRates(
  items: readonly BillingItem[],
  rates: readonly DailyRateLike[],
  today: string
): UnconfirmedRate[] {
  const found = new Map<string, UnconfirmedRate>();
  for (const { sku } of items) {
    if (sku.sellingMethod !== 'By Weight') continue;
    const key = `${sku.material}|${sku.purity}`;
    if (found.has(key)) continue;
    // R2: the rate a line takes is the latest dated on or before the day; it is confirmed when that day is today
    const best = defaultMetalRate(rates, sku.material, sku.purity, today);
    if (best.status === 'ok') continue;
    found.set(key, {
      key,
      material: sku.material,
      purity: sku.purity,
      status: best.status,
      lastDate: best.rateDate,
      lastRate: best.ratePaise === null ? null : formatRupees(best.ratePaise),
    });
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Is this the first bill of the day? True while no bill dated `today` exists in memory (a cancelled bill is a bill that was made; dues brought forward are not a bill of the day). A bill
 * another browser made arrives with the poll. A preview build has a sample rate dated today and nothing to ask.
 */
export function isFirstBillOfTheDay(today: string): boolean {
  if (PREVIEW_MODE) return false;
  return !rowCache
    .rows('bills')
    .some((b) => b.bill_date === today && b.doc_type !== 'opening_balance');
}

export interface RateQuestion {
  items: readonly BillingItem[];
  rates: readonly DailyRateLike[];
  /** The date of the bill on the screen. */
  billDate: string;
  today: string;
  firstBill: boolean;
  /** The day the person last answered the question for (confirmed, or billed with the rates as they are), or null. */
  answeredFor: string | null;
}

/** The rates to ask about before this bill is saved; empty when nothing is to be asked. */
export function rateConfirmationNeeded(q: RateQuestion): UnconfirmedRate[] {
  if (q.billDate !== q.today || !q.firstBill || q.answeredFor === q.today) return [];
  return unconfirmedRates(q.items, q.rates, q.today);
}

/** What the fields of the panel start with: the last rate of a purity that has one, nothing for a purity that has none. */
export function startingValues(entries: readonly UnconfirmedRate[]): Record<string, string> {
  return Object.fromEntries(entries.map((e) => [e.key, e.lastRate ?? '']));
}

/** The rates "Confirm today's rates" writes: every purity with something in its field, as typed (the store checks the amount). */
export function confirmationInputs(
  entries: readonly UnconfirmedRate[],
  values: Readonly<Record<string, string>>
): RateInput[] {
  const inputs: RateInput[] = [];
  for (const entry of entries) {
    const rate = (values[entry.key] ?? '').trim();
    if (rate !== '') inputs.push({ material: entry.material, purity: entry.purity, rate });
  }
  return inputs;
}
