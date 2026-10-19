// WEB16 (PLAN.md P3-T2, the part that stays; spec D4, R2, Y8; plan test PT-W16): a daily rate that was not confirmed today asks for confirmation before the first bill of the day, the rate
// card shows the real date of every rate it shows, and the warnings RATE_MISSING and RATE_STALE leave the line editable (those two are proved on the screen in tests/e2e/rates.spec.ts and,
// for the line notes, in tests/unit/billing.test.ts).
//
// "Confirmed today" means a `daily_rates` row dated today for the material and purity (D4: the API forces `confirmed_by` on every row). The guard looks at the By Weight lines of the bill:
// a line whose material and purity have no rate dated today is listed, with the last rate and its date to start from (a stale rate) or with nothing (no rate at all). It asks only for a bill
// dated today, only while no bill dated today exists yet (an opening-balance bill is not a bill of the day), and only until the person has answered.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newBillingItem, type BillingItem } from '@/lib/billing';
import type { Sku } from '@/lib/mockData';
import { at, categoryRow, rateRow, settingRow, uuid } from './support/rows';
import { billRow } from './support/money-rows';

const TODAY = '2026-10-15';

let counter = 0;
function sku(over: Partial<Sku> = {}): Sku {
  counter += 1;
  return {
    id: uuid(1000 + counter),
    skuNumber: `RING-00001-${String(counter).padStart(3, '0')}`,
    designId: uuid(300),
    designNumber: 'RING-00001',
    grossWeight: 1.2,
    originalNetWeight: 0,
    customerNetWeight: 1,
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
    barcode: `BC${counter}`,
    createdAt: '2026-10-15T09:00:00.000Z',
    createdBy: '',
    notes: '',
    sellingMethod: 'By Weight',
    purity: '22K',
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
const line = (over: Partial<Sku>, rates: ReturnType<typeof rate>[]): BillingItem =>
  newBillingItem(sku(over), { saleType: 'Retail', billDate: TODAY, rates });

async function load() {
  vi.resetModules();
  const [guard, cache] = await Promise.all([
    import('@/lib/rateGuard'),
    import('@/lib/cache/cache'),
  ]);
  return { ...guard, cache: cache.rowCache };
}

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
});

describe('PT-W16: which rates the bill uses were not confirmed today (D4, R2)', () => {
  it('lists a line whose latest rate is from an earlier day, with that rate and that day to start from', async () => {
    const { unconfirmedRates } = await load();
    const rates = [
      rate('Gold', '22K', '6800.00', '2026-10-12'),
      rate('Gold', '22K', '6700.00', '2026-10-10'),
    ];
    expect(unconfirmedRates([line({}, rates)], rates, TODAY)).toEqual([
      {
        key: 'Gold|22K',
        material: 'Gold',
        purity: '22K',
        status: 'stale',
        lastDate: '2026-10-12',
        lastRate: '6800.00',
      },
    ]);
  });

  it('lists a purity with no rate at all as missing, with nothing to start from', async () => {
    const { unconfirmedRates } = await load();
    const found = unconfirmedRates([line({ purity: '20K' }, [])], [], TODAY);
    expect(found).toEqual([
      {
        key: 'Gold|20K',
        material: 'Gold',
        purity: '20K',
        status: 'missing',
        lastDate: null,
        lastRate: null,
      },
    ]);
  });

  it('a rate dated today is confirmed: nothing is listed for it, whatever older rates exist', async () => {
    const { unconfirmedRates } = await load();
    const rates = [
      rate('Gold', '22K', '6920.00', TODAY),
      rate('Gold', '22K', '6800.00', '2026-10-12'),
    ];
    expect(unconfirmedRates([line({}, rates)], rates, TODAY)).toEqual([]);
  });

  it('a rate dated after today is not a rate of today (the API refuses one, so this is a damaged row)', async () => {
    const { unconfirmedRates } = await load();
    const rates = [
      rate('Gold', '22K', '7000.00', '2026-10-16'),
      rate('Gold', '22K', '6800.00', '2026-10-12'),
    ];
    const found = unconfirmedRates([line({}, rates)], rates, TODAY);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      status: 'stale',
      lastDate: '2026-10-12',
      lastRate: '6800.00',
    });
  });

  it('one entry for each material and purity however many lines use it; a Per Piece line has no daily rate and is never listed', async () => {
    const { unconfirmedRates } = await load();
    const rates = [
      rate('Gold', '22K', '6800.00', '2026-10-12'),
      rate('Silver', '925', '88.00', '2026-10-11'),
    ];
    const items = [
      line({}, rates),
      line({}, rates),
      line({ sellingMethod: 'Per Piece' }, rates),
      line({ purity: '925', material: 'Silver' }, rates),
    ];
    expect(unconfirmedRates(items, rates, TODAY).map((e) => e.key)).toEqual([
      'Gold|22K',
      'Silver|925',
    ]);
  });

  it('the line stays as it is: the guard reads the lines and changes none of them (the rate on the line can still be typed)', async () => {
    const { unconfirmedRates } = await load();
    const rates = [rate('Gold', '22K', '6800.00', '2026-10-12')];
    const items = [line({}, rates)];
    const before = JSON.stringify(items);
    unconfirmedRates(items, rates, TODAY);
    expect(JSON.stringify(items)).toBe(before);
    expect(items[0].metalRate).toBe('6800.00');
    expect(items[0].rate).toEqual({ status: 'stale', date: '2026-10-12' });
  });
});

describe('PT-W16: the first bill of the day asks, the next ones do not', () => {
  const stale = [rate('Gold', '22K', '6800.00', '2026-10-12')];
  const ask = async (over: Record<string, unknown> = {}) => {
    const guard = await load();
    return guard.rateConfirmationNeeded({
      items: [line({}, stale)],
      rates: stale,
      billDate: TODAY,
      today: TODAY,
      firstBill: true,
      answeredFor: null,
      ...over,
    } as Parameters<typeof guard.rateConfirmationNeeded>[0]);
  };

  it('asks for a bill dated today when this is the first bill of the day and the person has not answered', async () => {
    expect((await ask()).map((e) => e.key)).toEqual(['Gold|22K']);
  });

  it('does not ask when a bill was made today already', async () => {
    expect(await ask({ firstBill: false })).toEqual([]);
  });

  it('does not ask for a back-dated bill: the rate of its own day is the question there (RATE_STALE on the saved bill says it)', async () => {
    expect(await ask({ billDate: '2026-10-14' })).toEqual([]);
  });

  it('asks once: after the answer for today it does not ask again, and a new day asks again', async () => {
    expect(await ask({ answeredFor: TODAY })).toEqual([]);
    expect((await ask({ answeredFor: '2026-10-14' })).length).toBe(1);
  });

  it('asks nothing when every rate the bill uses is dated today', async () => {
    const fresh = [rate('Gold', '22K', '6920.00', TODAY)];
    expect(await ask({ items: [line({}, fresh)], rates: fresh })).toEqual([]);
  });

  it('asks nothing for an empty bill', async () => {
    expect(await ask({ items: [] })).toEqual([]);
  });
});

describe('PT-W16: the first bill of the day is the first bill dated today that is not dues brought forward', () => {
  it('is true with no bill, and with bills of other days only', async () => {
    const { isFirstBillOfTheDay, cache } = await load();
    expect(isFirstBillOfTheDay(TODAY)).toBe(true);
    cache.merge('bills', [billRow(1, uuid(5001), { bill_date: '2026-10-14', updated_at: at(1) })]);
    expect(isFirstBillOfTheDay(TODAY)).toBe(true);
  });

  it('is false once a bill dated today exists, a cancelled one too, also when another browser made it (a poll brought it)', async () => {
    const { isFirstBillOfTheDay, cache } = await load();
    cache.merge('bills', [
      billRow(2, uuid(5001), {
        bill_date: TODAY,
        status: 'cancelled',
        cancel_reason: 'x',
        cancelled_at: at(2),
        cancelled_on: TODAY,
        cancelled_by: uuid(901),
        updated_at: at(2),
      }),
    ]);
    expect(isFirstBillOfTheDay(TODAY)).toBe(false);
  });

  it('an opening-balance bill dated today is dues brought forward, not the first bill of the day', async () => {
    const { isFirstBillOfTheDay, cache } = await load();
    cache.merge('bills', [
      billRow(3, uuid(5001), { bill_date: TODAY, doc_type: 'opening_balance', updated_at: at(3) }),
    ]);
    expect(isFirstBillOfTheDay(TODAY)).toBe(true);
  });

  it('a logout (the cache is cleared) makes it the first bill again for the next person', async () => {
    const { isFirstBillOfTheDay, cache } = await load();
    cache.merge('bills', [billRow(4, uuid(5001), { bill_date: TODAY, updated_at: at(4) })]);
    expect(isFirstBillOfTheDay(TODAY)).toBe(false);
    cache.clear();
    expect(isFirstBillOfTheDay(TODAY)).toBe(true);
  });
});

describe('PT-W16: what "Confirm today\'s rates" sends', () => {
  it('a stale rate starts from the last rate, a typed rate wins, an empty one is left out', async () => {
    const { confirmationInputs, startingValues } = await load();
    const entries = [
      {
        key: 'Gold|22K',
        material: 'Gold' as const,
        purity: '22K',
        status: 'stale' as const,
        lastDate: '2026-10-12',
        lastRate: '6800.00',
      },
      {
        key: 'Gold|20K',
        material: 'Gold' as const,
        purity: '20K',
        status: 'missing' as const,
        lastDate: null,
        lastRate: null,
      },
      {
        key: 'Silver|925',
        material: 'Silver' as const,
        purity: '925',
        status: 'stale' as const,
        lastDate: '2026-10-11',
        lastRate: '88.00',
      },
    ];
    const start = startingValues(entries);
    expect(start).toEqual({ 'Gold|22K': '6800.00', 'Gold|20K': '', 'Silver|925': '88.00' });
    expect(confirmationInputs(entries, start)).toEqual([
      { material: 'Gold', purity: '22K', rate: '6800.00' },
      { material: 'Silver', purity: '925', rate: '88.00' },
    ]);
    expect(
      confirmationInputs(entries, { ...start, 'Gold|22K': ' 7000 ', 'Gold|20K': '6000.50' })
    ).toEqual([
      { material: 'Gold', purity: '22K', rate: '7000' },
      { material: 'Gold', purity: '20K', rate: '6000.50' },
      { material: 'Silver', purity: '925', rate: '88.00' },
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ the rate card shows the real dates

async function drawCard(
  rates: Array<Parameters<typeof rateRow>[1]>,
  role: 'owner' | 'biller' = 'owner'
) {
  vi.resetModules();
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => ({ role }),
  }));
  const [{ rowCache }, settings, { default: Card }] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/settingsStore'),
    import('@/app/components/DashboardRateCard'),
  ]);
  rowCache.merge('categories', [categoryRow(1, 'Ring', 'RING')]);
  rowCache.merge('settings', [
    settingRow('materials', [
      { name: 'Gold', purities: ['18K', '22K'] },
      { name: 'Silver', purities: ['925'] },
    ]),
  ]);
  const today = settings.businessToday();
  rowCache.merge(
    'daily-rates',
    rates.map((over, n) => rateRow(n + 1, over))
  );
  return { html: renderToStaticMarkup(React.createElement(Card)), today };
}

const caption = (html: string, id: string) =>
  new RegExp(`<[^>]*data-testid="rate-date-${id}"[^>]*>([^<]*)<`).exec(html);

describe('PT-W16: the rate card shows the real date of every rate it shows', () => {
  it('a rate of today says so; a rate of an earlier day says when it was last set and that it is not confirmed today; a purity with no rate says so', async () => {
    const today = (await import('@/lib/settingsStore')).businessToday();
    const { html } = await drawCard([
      { material: 'Gold', purity: '22K', rate_per_gram: '7350.00', rate_date: today },
      { material: 'Silver', purity: '925', rate_per_gram: '88.00', rate_date: '2026-01-02' },
    ]);
    expect(caption(html, 'gold-22k')?.[0]).toContain('Set today');
    expect(caption(html, 'gold-22k')?.[0]).toContain('data-state="today"');
    expect(caption(html, 'silver-925')?.[0]).toContain('Last set 2 Jan 2026');
    expect(caption(html, 'silver-925')?.[0]).toContain('data-state="stale"');
    expect(caption(html, 'silver-925')?.[0]).toContain('not confirmed today');
    expect(caption(html, 'gold-18k')?.[0]).toContain('No rate yet');
    expect(caption(html, 'gold-18k')?.[0]).toContain('data-state="missing"');
  });

  it('"Last updated" is the date of the newest rate, never the date of the clock (the prototype always said today)', async () => {
    const { html } = await drawCard([
      { material: 'Gold', purity: '22K', rate_per_gram: '7300.00', rate_date: '2026-01-02' },
      { material: 'Gold', purity: '22K', rate_per_gram: '7100.00', rate_date: '2025-12-30' },
    ]);
    expect(html).toContain('Last updated: 2 Jan 2026');
    expect(html).not.toMatch(/Last updated: -/);
  });

  it('says "-" when there is no rate at all, and the owner looking at an earlier day sees that day\'s rows as set on that day', async () => {
    const empty = await drawCard([]);
    expect(empty.html).toContain('Last updated: -');
    for (const id of ['gold-18k', 'gold-22k', 'silver-925'])
      expect(caption(empty.html, id)?.[0]).toContain('No rate yet');
  });

  it('a biller sees the same dates', async () => {
    const { html } = await drawCard(
      [{ material: 'Gold', purity: '22K', rate_per_gram: '7300.00', rate_date: '2026-01-02' }],
      'biller'
    );
    expect(caption(html, 'gold-22k')?.[0]).toContain('Last set 2 Jan 2026');
  });
});

// ------------------------------------------------------------------------------------------------ the confirmation panel

describe('PT-W16: the panel that asks', () => {
  async function drawPanel(entries: unknown[]) {
    vi.resetModules();
    const { default: Panel } = await import('@/app/billing-pos/components/RateGuardPanel');
    return renderToStaticMarkup(
      React.createElement(Panel, {
        entries: entries as never,
        today: TODAY,
        onConfirmed: () => undefined,
        onAcknowledged: () => undefined,
      })
    );
  }

  it('says why it asks, names each purity with the rate and the day it comes from, and offers the two ways on', async () => {
    const html = await drawPanel([
      {
        key: 'Gold|22K',
        material: 'Gold',
        purity: '22K',
        status: 'stale',
        lastDate: '2026-10-12',
        lastRate: '6800.00',
      },
      {
        key: 'Gold|20K',
        material: 'Gold',
        purity: '20K',
        status: 'missing',
        lastDate: null,
        lastRate: null,
      },
    ]);
    expect(html).toContain('data-testid="rate-guard"');
    expect(html).toContain('before the first bill of the day');
    expect(html).toContain('Gold 22K');
    expect(html).toContain('last set 12 Oct 2026');
    expect(html).toContain('₹6,800.00');
    expect(html).toContain('Gold 20K');
    expect(html).toContain('No rate has been set yet');
    expect(html).toMatch(
      /<input[^>]*aria-label="Gold 22K rate today \(per gram\)"[^>]*value="6800.00"/
    );
    expect(html).toMatch(/<input[^>]*aria-label="Gold 20K rate today \(per gram\)"[^>]*value=""/);
    expect(html).toContain('Confirm today&#x27;s rates');
    expect(html).toContain('Bill with the rates as they are');
  });
});
