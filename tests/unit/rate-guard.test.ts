// WEB16 (PT-W16; spec D4, R2, T-A17, plan P3-T2, the part that stays): the stale-rate guard without the screen, `src/lib/rateGuard.ts`.
//
//   PT-W16  a rate that is not confirmed today (no `daily_rates` row dated today for the material and purity) is asked about before the first bill of the day; the bill can still be made
//           at the old rate (the API warns RATE_STALE or RATE_MISSING and saves, T-A17), and the line stays editable.
//   The rule, in numbers: the guard looks only at a bill dated today, only at a By Weight line (a Per Piece price is not a daily rate), and gives each material and purity once.
import { describe, expect, it } from 'vitest';
import { newBillingItem, type BillingItem, type LineContext } from '@/lib/billing';
import { ratesToConfirm, withRates } from '@/lib/rateGuard';
import type { Sku } from '@/lib/mockData';
import { uuid } from './support/rows';

const TODAY = '2026-10-19';

let counter = 0;
function sku(over: Partial<Sku> = {}): Sku {
  counter += 1;
  return {
    id: uuid(2000 + counter),
    skuNumber: `RING-00001-${String(counter).padStart(3, '0')}`,
    designId: uuid(300),
    designNumber: 'RING-00001',
    grossWeight: 5,
    originalNetWeight: 0,
    customerNetWeight: 4.5,
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
const context = (rates: LineContext['rates'], billDate = TODAY): LineContext => ({
  saleType: 'Retail',
  billDate,
  rates,
});
const line = (over: Partial<Sku>, rates: LineContext['rates'], billDate = TODAY): BillingItem =>
  newBillingItem(sku(over), context(rates, billDate));

describe('PT-W16 which rates the first bill of the day must ask about (D4, R2)', () => {
  it('a purity that has a row dated today is confirmed: nothing to ask', () => {
    const rates = [
      rate('Gold', '22K', '7000.00', TODAY),
      rate('Gold', '22K', '6900.00', '2026-10-17'),
    ];
    const items = [line({}, rates)];
    expect(ratesToConfirm({ items, billDate: TODAY, today: TODAY, rates })).toEqual([]);
  });

  it('a purity whose latest row is older than today is asked about, with that rate and its date', () => {
    const rates = [
      rate('Gold', '22K', '6900.00', '2026-10-17'),
      rate('Gold', '22K', '6800.00', '2026-10-12'),
    ];
    const items = [line({}, rates)];
    expect(ratesToConfirm({ items, billDate: TODAY, today: TODAY, rates })).toEqual([
      {
        material: 'Gold',
        purity: '22K',
        last: { rate: '6900.00', date: '2026-10-17' },
        onBill: '6900.00',
      },
    ]);
  });

  it('a purity that never had a rate is asked about with nothing to start from, and what the line carries is offered', () => {
    const items = [line({ purity: '20K' }, [])];
    items[0] = { ...items[0], metalRate: '6000' }; // the person typed the rate on the line
    expect(ratesToConfirm({ items, billDate: TODAY, today: TODAY, rates: [] })).toEqual([
      { material: 'Gold', purity: '20K', last: null, onBill: '6000' },
    ]);
  });

  it('a purity is asked about once however many lines it has; Gold comes before Silver, each in the order of the bill', () => {
    const rates = [
      rate('Gold', '22K', '6900.00', '2026-10-17'),
      rate('Gold', '24K', '7500.00', '2026-10-15'),
      rate('Silver', '925', '88.00', '2026-10-17'),
    ];
    const items = [
      line({ material: 'Silver', purity: '925' }, rates),
      line({ purity: '24K' }, rates),
      line({ purity: '22K' }, rates),
      line({ purity: '24K' }, rates),
    ];
    const asked = ratesToConfirm({ items, billDate: TODAY, today: TODAY, rates });
    expect(asked.map((r) => `${r.material} ${r.purity}`)).toEqual([
      'Gold 24K',
      'Gold 22K',
      'Silver 925',
    ]);
  });

  it('a Per Piece line is not asked about: its price is the piece price, not a daily rate (R2)', () => {
    const items = [line({ sellingMethod: 'Per Piece' }, [])];
    expect(ratesToConfirm({ items, billDate: TODAY, today: TODAY, rates: [] })).toEqual([]);
  });

  it('a bill dated before today is not asked: the rate that matters is the one of its own date, and the line says if that is old', () => {
    const rates = [rate('Gold', '22K', '6900.00', '2026-10-17')];
    const items = [line({}, rates, '2026-10-18')];
    expect(ratesToConfirm({ items, billDate: '2026-10-18', today: TODAY, rates })).toEqual([]);
  });

  it('an empty bill asks nothing', () => {
    expect(ratesToConfirm({ items: [], billDate: TODAY, today: TODAY, rates: [] })).toEqual([]);
  });

  it('a row of another purity or material does not confirm this one', () => {
    const rates = [rate('Gold', '24K', '7500.00', TODAY), rate('Silver', '22K', '90.00', TODAY)];
    const items = [line({}, rates)];
    const asked = ratesToConfirm({ items, billDate: TODAY, today: TODAY, rates });
    expect(asked.map((r) => `${r.material} ${r.purity}`)).toEqual(['Gold 22K']);
  });
});

describe('PT-W16 a line on its default follows the rates when they change; what the person typed stays (R2)', () => {
  it('a rate confirmed meanwhile replaces the old default and the line stops being stale', () => {
    const old = [rate('Gold', '22K', '6900.00', '2026-10-17')];
    const [first] = [line({}, old)];
    expect(first.rate.status).toBe('stale');
    const now = [...old, rate('Gold', '22K', '7000.00', TODAY)];
    const [after] = withRates([first], context(now));
    expect(after.metalRate).toBe('7000.00');
    expect(after.rateDefault).toBe('7000.00');
    expect(after.rate).toEqual({ status: 'ok', date: TODAY });
  });

  it('a line with no rate gets the one that was confirmed', () => {
    const [first] = [line({ purity: '20K' }, [])];
    expect(first.metalRate).toBe('');
    const [after] = withRates([first], context([rate('Gold', '20K', '6100.00', TODAY)]));
    expect(after.metalRate).toBe('6100.00');
    expect(after.rate.status).toBe('ok');
  });

  it('a rate the person typed is left alone', () => {
    const old = [rate('Gold', '22K', '6900.00', '2026-10-17')];
    const [first] = [line({}, old)];
    const typed = { ...first, metalRate: '7123' };
    const now = [...old, rate('Gold', '22K', '7000.00', TODAY)];
    const [after] = withRates([typed], context(now));
    expect(after.metalRate).toBe('7123');
    expect(after.rateDefault).toBe('6900.00');
  });

  it('answers the same array when nothing changed (so a screen that calls it on every poll does not redraw)', () => {
    const rates = [rate('Gold', '22K', '6900.00', '2026-10-17')];
    const items = [line({}, rates), line({ sellingMethod: 'Per Piece' }, rates)];
    expect(withRates(items, context(rates))).toBe(items);
  });
});
