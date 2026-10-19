// WEB17 (PLAN.md P3-T2, the part that is cut first; spec D4, R2, R14; plan test PT-W17): the rate card holds a Gold rate for each purity (24K, 22K, 20K, 18K) and a new bill takes the rate
// of its piece's material and purity, and the line can still be edited. Billing is correct without this (the rate is typed or edited on every line); this is the convenience, and the
// place where it must never be wrong: a 22K rate on an 18K piece is a bill that is wrong by thousands of rupees.
//
// The weight of the proof is in tests/e2e/rates-purity.spec.ts (a real browser, the real API, the list price the API took for each purity). Here: the pure rules of src/lib/billing.ts and
// the card drawn over the real stores.
//   - each piece takes the rate of ITS purity; no purity takes another's; a back-dated bill takes the latest rate dated on or before its own day, purity by purity
//   - a line still on its default FOLLOWS the daily rates when they change (a rate another browser brought with the poll, or "Confirm today's rates"); a rate the person typed is left alone
//   - the line stays editable: what is typed is the rate priced, whatever the card said
//   - the card has one field for each of the four Gold purities, each with its own label
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newBillingItem,
  previewBill,
  withBillDate,
  withRates,
  type BillingItem,
  type LineContext,
} from '@/lib/billing';
import type { Sku } from '@/lib/mockData';
import { categoryRow, rateRow, settingRow, uuid } from './support/rows';

const TODAY = '2026-10-19';

let counter = 0;
function sku(purity: Sku['purity'], over: Partial<Sku> = {}): Sku {
  counter += 1;
  return {
    id: uuid(2000 + counter),
    skuNumber: `RING-00017-${String(counter).padStart(3, '0')}`,
    designId: uuid(317),
    designNumber: 'RING-00017',
    grossWeight: 1.2,
    originalNetWeight: 0,
    customerNetWeight: 10,
    stones: 0,
    stoneWeight: 0,
    kundan: 0,
    kundanWeight: 0,
    piroi: 0,
    labour: 300,
    retailLabour: 300,
    semiWholesaleLabour: 280,
    wholesaleLabour: 260,
    status: 'In Stock',
    location: 'Main Showroom',
    barcode: `BC17-${counter}`,
    createdAt: '2026-10-19T09:00:00.000Z',
    createdBy: '',
    notes: '',
    sellingMethod: 'By Weight',
    purity,
    material: 'Gold',
    category: 'Ring',
    subcategory: '',
    ...over,
  };
}

const rate = (material: string, purity: string, ratePerGram: string, rateDate: string) => ({
  material,
  purity,
  ratePerGram,
  rateDate,
});

/** Four Gold rates of today, each different, so that a rate taken for the wrong purity shows at once. */
const CARD = [
  rate('Gold', '24K', '7500.00', TODAY),
  rate('Gold', '22K', '6920.00', TODAY),
  rate('Gold', '20K', '6300.00', TODAY),
  rate('Gold', '18K', '5700.00', TODAY),
  rate('Silver', '925', '88.00', TODAY),
];
const context = (rates = CARD, billDate = TODAY): LineContext => ({
  saleType: 'Retail',
  billDate,
  rates,
});
const PURITIES = ['24K', '22K', '20K', '18K'] as const;
const RATE_OF = { '24K': '7500.00', '22K': '6920.00', '20K': '6300.00', '18K': '5700.00' };

describe("PT-W17: a new bill takes the rate of its piece's purity (24K, 22K, 20K, 18K)", () => {
  it("each purity takes its own rate, whatever order the pieces are scanned in, and no purity takes another purity's", () => {
    for (const order of [PURITIES, [...PURITIES].reverse()]) {
      const lines = order.map((purity) => newBillingItem(sku(purity), context()));
      for (const [n, purity] of order.entries()) {
        expect(lines[n].metalRate, purity).toBe(RATE_OF[purity]);
        expect(lines[n].rate, purity).toEqual({ status: 'ok', date: TODAY });
      }
      expect(new Set(lines.map((l) => l.metalRate)).size).toBe(4);
    }
  });

  it('a Silver piece takes the Silver rate of its purity, not a Gold rate; a purity with no rate has no default (it is not borrowed from another purity)', () => {
    const silver = newBillingItem(sku('925', { material: 'Silver' }), context());
    expect(silver.metalRate).toBe('88.00');
    const noRate = [rate('Gold', '22K', '6920.00', TODAY), rate('Gold', '24K', '7500.00', TODAY)];
    const eighteen = newBillingItem(sku('18K'), context(noRate));
    expect(eighteen.metalRate).toBe('');
    expect(eighteen.rate).toEqual({ status: 'missing', date: null });
    expect(newBillingItem(sku('20K'), context(noRate)).metalRate).toBe('');
  });

  it("the rate of a purity is the latest one dated on or before the bill's day, purity by purity: a back-dated bill gets the rate of its own day", () => {
    const rates = [
      ...CARD,
      rate('Gold', '22K', '6800.00', '2026-10-16'),
      rate('Gold', '22K', '6700.00', '2026-10-12'),
      rate('Gold', '18K', '5500.00', '2026-10-12'),
    ];
    const on16 = context(rates, '2026-10-16');
    expect(newBillingItem(sku('22K'), on16)).toMatchObject({
      metalRate: '6800.00',
      rate: { status: 'ok', date: '2026-10-16' },
    });
    // the 18K rate of the 12th is the latest not after the 16th, and it says that it is older
    expect(newBillingItem(sku('18K'), on16)).toMatchObject({
      metalRate: '5500.00',
      rate: { status: 'stale', date: '2026-10-12' },
    });
    // a day before any 18K rate: none
    expect(newBillingItem(sku('18K'), context(rates, '2026-10-11')).rate.status).toBe('missing');
    // a later rate is never used for an earlier bill
    expect(newBillingItem(sku('24K'), on16).rate.status).toBe('missing');
  });

  it("moving the bill's date moves every line that is still on its default to the rate of its own purity on the new day", () => {
    const rates = [
      ...CARD,
      rate('Gold', '22K', '6800.00', '2026-10-16'),
      rate('Gold', '18K', '5500.00', '2026-10-16'),
    ];
    const lines = PURITIES.map((purity) => newBillingItem(sku(purity), context(rates)));
    const moved = withBillDate(lines, context(rates, '2026-10-16'));
    expect(moved.map((l) => l.metalRate)).toEqual(['', '6800.00', '', '5500.00']);
    expect(moved.map((l) => l.rate.status)).toEqual(['missing', 'ok', 'missing', 'ok']);
  });
});

describe('PT-W17: the line can still be edited', () => {
  it("what is typed on a line is the rate that is priced, not the card's", () => {
    const line: BillingItem = { ...newBillingItem(sku('18K'), context()), metalRate: '5650' };
    const shown = previewBill({
      items: [line],
      saleType: 'Retail',
      discount: '',
      additionalCharges: '',
      roundOffSetting: false,
    });
    expect(shown.error).toBeNull();
    // 10 g at 5,650 + labour 300 a gram
    expect(shown.lines[0].priced?.metalAmountPaise).toBe(5650000);
    expect(shown.lines[0].priced?.itemTotalPaise).toBe(5650000 + 300000);
  });

  it('a rate that was typed is left alone when the date or the daily rates change; a line that was only defaulted follows', () => {
    const typed: BillingItem = { ...newBillingItem(sku('22K'), context()), metalRate: '6900' };
    const defaulted = newBillingItem(sku('22K'), context());
    const next = [rate('Gold', '22K', '6950.00', TODAY), ...CARD.slice(2)];
    const [a, b] = withRates([typed, defaulted], context(next));
    expect(a.metalRate).toBe('6900');
    expect(a).toBe(typed);
    expect(b.metalRate).toBe('6950.00');
    expect(b.rateDefault).toBe('6950.00');
  });
});

describe('PT-W17: a line that follows the default follows the daily rates when they change (a rate that arrives after the piece was scanned)', () => {
  it('a rate that arrives for a purity with none fills the line that waited for it, and a stale rate gives way to the rate of today', () => {
    const before = [rate('Gold', '22K', '6800.00', '2026-10-15')];
    const stale = newBillingItem(sku('22K'), context(before));
    const waiting = newBillingItem(sku('18K'), context(before));
    expect(stale.rate).toEqual({ status: 'stale', date: '2026-10-15' });
    expect(waiting.rate.status).toBe('missing');

    const after = [
      ...before,
      rate('Gold', '22K', '6950.00', TODAY),
      rate('Gold', '18K', '5700.00', TODAY),
    ];
    const [a, b] = withRates([stale, waiting], context(after));
    expect(a).toMatchObject({ metalRate: '6950.00', rate: { status: 'ok', date: TODAY } });
    expect(b).toMatchObject({ metalRate: '5700.00', rate: { status: 'ok', date: TODAY } });
  });

  it('a rate of another purity changes nothing on a line, and the very same array comes back when no line changed (so the screen is not drawn again for nothing)', () => {
    const lines = PURITIES.map((purity) => newBillingItem(sku(purity), context()));
    const sameRates = CARD.map((r) => ({ ...r }));
    expect(withRates(lines, context(sameRates))).toBe(lines);
    const moreRates = [...CARD, rate('Gold', '22K', '6000.00', '2026-10-01')];
    expect(withRates(lines, context(moreRates))).toBe(lines);
    const only18 = CARD.map((r) => (r.purity === '18K' ? { ...r, ratePerGram: '5800.00' } : r));
    const changed = withRates(lines, context(only18));
    expect(changed).not.toBe(lines);
    expect(changed.map((l) => l.metalRate)).toEqual(['7500.00', '6920.00', '6300.00', '5800.00']);
    expect(changed[0]).toBe(lines[0]);
  });

  it('a Per Piece line has no daily rate to follow: its piece price is left alone', () => {
    const ring = newBillingItem(
      sku('22K', { sellingMethod: 'Per Piece', retailLabour: 1200 }),
      context()
    );
    expect(ring.metalRate).toBe('1200.00');
    const next = [rate('Gold', '22K', '7777.00', TODAY)];
    expect(withRates([ring], context(next))[0]).toBe(ring);
  });
});

// ------------------------------------------------------------------------------------------------ the card

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
});

async function drawCard(purities: string[]) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => ({ role: 'owner' }),
  }));
  const [{ rowCache }, settings, { default: Card }] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/settingsStore'),
    import('@/app/components/DashboardRateCard'),
  ]);
  rowCache.merge('categories', [categoryRow(1, 'Ring', 'RING')]);
  rowCache.merge('settings', [
    settingRow('materials', [
      { name: 'Gold', purities },
      { name: 'Silver', purities: ['925'] },
    ]),
  ]);
  const today = settings.businessToday();
  rowCache.merge('daily-rates', [
    rateRow(1, { material: 'Gold', purity: '22K', rate_per_gram: '6920.00', rate_date: today }),
  ]);
  return { html: renderToStaticMarkup(React.createElement(Card)), today };
}

describe('PT-W17: the rate card holds a Gold rate for each purity (24K, 22K, 20K, 18K)', () => {
  it('has one labelled field for each of the four Gold purities of the materials setting, each its own, and the rate of a purity sits in its own field', async () => {
    const { html } = await drawCard(['24K', '22K', '20K', '18K']);
    for (const purity of ['24K', '22K', '20K', '18K']) {
      expect(html).toContain(`aria-label="Gold ${purity} rate (per gram)"`);
      expect(html).toContain(`data-testid="rate-gold-${purity.toLowerCase()}"`);
    }
    const input = (purity: string) =>
      new RegExp(`<input[^>]*aria-label="Gold ${purity} rate \\(per gram\\)"[^>]*>`).exec(
        html
      )?.[0] ?? '';
    expect(input('22K')).toContain('value="6920.00"');
    for (const purity of ['24K', '20K', '18K']) expect(input(purity)).toContain('value=""');
  });

  it('the purities on the card are the ones of the setting, so a purity added to the setting appears on the card', async () => {
    const { html } = await drawCard(['24K', '22K', '20K', '18K', '14K']);
    expect(html).toContain('aria-label="Gold 14K rate (per gram)"');
    const three = await drawCard(['22K', '18K']);
    expect(three.html).not.toContain('Gold 24K');
    expect(three.html).not.toContain('Gold 20K');
  });
});
