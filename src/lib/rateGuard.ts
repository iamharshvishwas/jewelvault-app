// The stale-rate guard without the screen (spec D4, R2, T-A17; PLAN.md P3-T2, the part that stays; task WEB16).
//
//   A bill is made at a rate. The rate a By Weight line starts from is the daily rate of the piece's material and purity with the latest `rate_date` not after the bill date (R2). A rate
//   that is dated TODAY has been confirmed today: somebody entered it, and the API recorded who (`confirmed_by`, S6). A rate dated before today is only the last one anybody confirmed.
//   The first bill of the day therefore asks, once for each material and purity it uses, whether that rate is still right: `ratesToConfirm` says which. The person confirms (a row dated
//   today is written, and the lines still on their default take it, `withRates`), or bills without confirming: the API then warns RATE_STALE or RATE_MISSING and saves (T-A17), and the
//   line stays editable. Nothing here is a rule of the API: it never refuses a bill for an old rate (O26); this is only what the screen asks first.
//
// This file makes no network call and keeps nothing between calls.
import { withBillDate, type BillingItem, type LineContext } from './billing';
import type { Material } from './mockData';

/** One material and purity of the bill whose rate nobody has confirmed today. */
export interface RateToConfirm {
  material: Material;
  purity: string;
  /** The newest rate before today for this material and purity (to start from), or null when none was ever entered. */
  last: { rate: string; date: string } | null;
  /** The rate the first line of this purity carries now, as typed or defaulted: what the person is about to bill at. */
  onBill: string;
}

/** The key under which the screen remembers an answer for a material and purity. */
export const rateKey = (entry: { material: string; purity: string }): string =>
  `${entry.material}|${entry.purity}`;

export interface RatesToConfirmInput {
  items: readonly BillingItem[];
  billDate: string;
  /** The business date of today (S5). */
  today: string;
  /** The daily rates in memory (`getDailyRates()`). */
  rates: readonly {
    material: string;
    purity: string;
    ratePerGram: number | string;
    rateDate: string;
  }[];
}

/**
 * The materials and purities of a By Weight line of a bill dated today that have no daily rate dated today, Gold before Silver and each in the order the bill has them. A bill dated
 * before today is not asked (the rate of its own date is what counts, and its line says when that is old); a Per Piece line has a piece price and no daily rate (R2).
 */
export function ratesToConfirm({
  items,
  billDate,
  today,
  rates,
}: RatesToConfirmInput): RateToConfirm[] {
  if (billDate !== today) return [];
  const asked = new Map<string, RateToConfirm>();
  const settled = new Set<string>();
  for (const item of items) {
    if (item.sku.sellingMethod !== 'By Weight') continue;
    const { material, purity } = item.sku;
    const key = rateKey({ material, purity });
    if (asked.has(key) || settled.has(key)) continue;
    let last: RateToConfirm['last'] = null;
    let confirmed = false;
    for (const rate of rates) {
      if (rate.material !== material || rate.purity !== purity) continue;
      if (rate.rateDate === today) {
        confirmed = true;
        break;
      }
      if (rate.rateDate < today && (last === null || rate.rateDate > last.date))
        last = { rate: String(rate.ratePerGram), date: rate.rateDate };
    }
    if (confirmed) settled.add(key);
    else asked.set(key, { material, purity, last, onBill: item.metalRate.trim() });
  }
  const all = [...asked.values()];
  return [...all.filter((r) => r.material === 'Gold'), ...all.filter((r) => r.material !== 'Gold')];
}

const sameRateNote = (a: BillingItem, b: BillingItem): boolean =>
  a.metalRate === b.metalRate &&
  a.rateDefault === b.rateDefault &&
  a.rate.status === b.rate.status &&
  a.rate.date === b.rate.date;

/**
 * R2: the daily rates changed (a poll brought somebody else's rate, or this screen confirmed one). A By Weight line that is still on the rate its default put in follows them; a rate
 * the person typed is left alone. The same array comes back when nothing changed, so that a screen can call this on every change of the rates without drawing again.
 */
export function withRates(items: BillingItem[], context: LineContext): BillingItem[] {
  const next = withBillDate(items, context);
  return next.every((item, at) => item === items[at] || sameRateNote(item, items[at]))
    ? items
    : next;
}
