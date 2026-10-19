// WEB11 (PT-W11, unit half; spec K1, K6, X10, A4): the billing screen in re-issue mode starts from the bill it corrects (src/lib/reissue.ts).
//
//   - the lines of the old bill come over exactly as they were saved (the rate, the labour, the piroi, the other charges and the quantity as TEXT), on the same pieces, with the bill's own
//     sale type, date, discount, additional charges and notes; the pieces of the old bill (Sold) are the ones the cancel frees, so they may be scanned again;
//   - the customer is the old bill's and is locked (the walk-in stays the walk-in);
//   - only the owner re-issues, and only a live estimate: a cancelled or already re-issued bill (with the bill that replaced it), an opening balance, an unknown bill, a piece that is not in
//     memory and an archived customer each give a sentence instead of a form.
//
// The stores are the real ones over a cache with the books in it (the role is the one thing passed in).
//
// Run: npm test -- tests/unit/reissue-setup.test.ts      (or: npm test -- -t PT-W11)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './support/rows';
import { billRow, customerRow, id, itemRow, summaryRow } from './support/money-rows';
import { categoryRow, designRow, rateRow, settingRow, skuRow } from './support/rows';

async function world() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  const [{ rowCache }, reissue] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/reissue'),
  ]);
  rowCache.merge('categories', [categoryRow(1, 'Ring', 'RING')]);
  rowCache.merge('settings', [
    settingRow('materials', [
      { name: 'Gold', purities: ['22K'] },
      { name: 'Silver', purities: ['925'] },
    ]),
  ]);
  rowCache.merge('daily-rates', [rateRow(1, {})]);
  rowCache.merge('designs', [
    designRow(1),
    designRow(2, { selling_method: 'Per Piece', material: 'Silver', purity: '925' }),
  ]);
  // piece 1 and 2 are sold on the bill being corrected; piece 3 is in stock
  rowCache.merge('skus', [
    skuRow(1, 1, { status: 'Sold' }),
    skuRow(2, 2, { status: 'Sold' }),
    skuRow(3, 1, { status: 'In Stock' }),
  ]);
  rowCache.merge('customers', [
    customerRow(id.priya, { customer_type: 'Wholesale', mobile: '9876543210' }),
    customerRow(id.walkin, { name: 'Walk-in Customer', is_walkin: true, mobile: null }),
    customerRow(id.gone, { name: 'Gone', archived_at: at(5) }),
  ]);
  return { rowCache, reissue };
}

const WALK_IN = '00000000-0000-4000-8000-000000000001';

/** An estimate of Priya: two lines (a By Weight piece and a Per Piece piece) as saved. */
function estimate(over: Parameters<typeof billRow>[2] = {}) {
  const bill = billRow(41, id.priya, {
    bill_no: 'JV-0041',
    sale_type: 'Wholesale',
    bill_date: '2026-10-12',
    discount: '50.00',
    additional_charges: '0.00',
    notes: 'for the wedding',
    grand_total: '1000.00',
    ...over,
  });
  const lines = [
    itemRow(bill, 1, {
      sku_id: skuRow(1, 1).id,
      sku_no: skuRow(1, 1).sku_no,
      metal_rate: '6900.00',
      labour_rate: '300.00',
      piroi: '25.00',
      other_charges: '10.50',
      quantity: 1,
    }),
    itemRow(bill, 2, {
      sku_id: skuRow(2, 2).id,
      sku_no: skuRow(2, 2).sku_no,
      selling_method: 'Per Piece',
      material: 'Silver',
      purity: '925',
      metal_rate: '1200.00',
      labour_rate: '0.00',
      piroi: '0.00',
      other_charges: '0.00',
      quantity: 3,
    }),
  ];
  return { bill, lines };
}

afterEach(() => vi.unstubAllEnvs());

describe('PT-W11 the billing screen in re-issue mode starts from the bill it corrects (K1, K6, X10)', () => {
  let ctx: Awaited<ReturnType<typeof world>>;
  beforeEach(async () => {
    ctx = await world();
  });

  it('carries the lines over as they were saved: the same pieces, the rate, labour, piroi, other charges and quantity as text', () => {
    const { bill, lines } = estimate();
    ctx.rowCache.merge('bills', [bill]);
    ctx.rowCache.merge('bill-items', lines);
    ctx.rowCache.merge('bill-summary', [
      summaryRow(bill, {
        received: '0.00',
        pending: '1000.00',
        fine_settled: '0.000',
        fine_pending: '0.000',
        payment_status: 'Pending',
        item_count: 2,
      }),
    ]);
    const setup = ctx.reissue.prepareReissue(bill.id, 'owner');
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.billNo).toBe('JV-0041');
    expect(setup.items.map((item) => item.sku.skuNumber)).toEqual([
      lines[0].sku_no,
      lines[1].sku_no,
    ]);
    expect(setup.items[0]).toMatchObject({
      metalRate: '6900.00',
      labour: '300.00',
      piroi: '25.00',
      otherCharges: '10.50',
      quantity: '1',
      heldStatus: null,
    });
    expect(setup.items[1]).toMatchObject({ metalRate: '1200.00', quantity: '3' });
    expect(setup.saleType).toBe('Wholesale');
    expect(setup.billDate).toBe('2026-10-12');
    expect(setup.discount).toBe('50.00');
    expect(setup.additionalCharges).toBe(''); // 0.00 is shown blank, as on a new bill
    expect(setup.notes).toBe('for the wedding');
    expect([...setup.oldPieceIds].sort()).toEqual([skuRow(1, 1).id, skuRow(2, 2).id].sort());
  });

  it("the customer is the old bill's and cannot change; the walk-in stays the walk-in", () => {
    const { bill, lines } = estimate();
    const walkinBill = billRow(42, WALK_IN, { bill_no: 'JV-0042', grand_total: '100.00' });
    ctx.rowCache.merge('bills', [bill, walkinBill]);
    ctx.rowCache.merge('bill-items', [
      ...lines,
      itemRow(walkinBill, 1, { sku_id: skuRow(3, 1).id, sku_no: skuRow(3, 1).sku_no }),
    ]);
    const priya = ctx.reissue.prepareReissue(bill.id, 'owner');
    expect(priya.ok && priya.customer?.id).toBe(id.priya);
    expect(priya.ok && priya.walkIn).toBe(false);
    expect(priya.ok && priya.customerName).toBe('Priya Sharma');
    const walkin = ctx.reissue.prepareReissue(walkinBill.id, 'owner');
    expect(walkin.ok && walkin.customer).toBeNull();
    expect(walkin.ok && walkin.walkIn).toBe(true);
    expect(walkin.ok && walkin.customerName).toBe('Walk-in Customer');
  });

  it('only the owner re-issues: a biller, a staff user and a person not signed in get a sentence, not a form', () => {
    const { bill, lines } = estimate();
    ctx.rowCache.merge('bills', [bill]);
    ctx.rowCache.merge('bill-items', lines);
    for (const role of ['biller', 'staff', null]) {
      const setup = ctx.reissue.prepareReissue(bill.id, role);
      expect(setup.ok, String(role)).toBe(false);
      expect(!setup.ok && setup.message).toMatch(/only the owner/i);
    }
  });

  it('a cancelled bill, and one that was re-issued already (with the bill that replaced it), cannot be re-issued', () => {
    const { bill, lines } = estimate({
      status: 'cancelled',
      cancel_reason: 'wrong rate',
      cancelled_on: '2026-10-13',
    });
    const fresh = billRow(43, id.priya, { bill_no: 'JV-0043', reissue_of: bill.id });
    ctx.rowCache.merge('bills', [bill, fresh]);
    ctx.rowCache.merge('bill-items', lines);
    const setup = ctx.reissue.prepareReissue(bill.id, 'owner');
    expect(setup.ok).toBe(false);
    expect(!setup.ok && setup.message).toMatch(/already cancelled/);
    expect(!setup.ok && setup.message).toContain('JV-0043');
    expect(!setup.ok && setup.link).toBe(fresh.id);
  });

  it('dues brought forward (an opening balance) cannot be re-issued', () => {
    const opening = billRow(44, id.priya, {
      bill_no: 'OB-0001',
      doc_type: 'opening_balance',
      grand_total: '500.00',
    });
    ctx.rowCache.merge('bills', [opening]);
    const setup = ctx.reissue.prepareReissue(opening.id, 'owner');
    expect(setup.ok).toBe(false);
    expect(!setup.ok && setup.message).toMatch(/opening balance/i);
    expect(!setup.ok && setup.message).toMatch(/cancel it and add a new/i);
  });

  it('an unknown bill, a piece that is not in memory and an archived customer each give a sentence', () => {
    expect(
      ctx.reissue.prepareReissue('00000000-0000-4000-8000-0000000000ff', 'owner')
    ).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not found/i),
    });
    const { bill, lines } = estimate();
    ctx.rowCache.merge('bills', [bill]);
    ctx.rowCache.merge('bill-items', [{ ...lines[0], sku_no: 'NOT-IN-MEMORY-001' }]);
    expect(ctx.reissue.prepareReissue(bill.id, 'owner')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/NOT-IN-MEMORY-001/),
    });
    const archivedBill = billRow(45, id.gone, { bill_no: 'JV-0045' });
    ctx.rowCache.merge('bills', [archivedBill]);
    ctx.rowCache.merge('bill-items', [
      itemRow(archivedBill, 1, { sku_id: skuRow(3, 1).id, sku_no: skuRow(3, 1).sku_no }),
    ]);
    expect(ctx.reissue.prepareReissue(archivedBill.id, 'owner')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/archived/i),
    });
  });
});

describe('PT-W11 a piece of the bill being corrected may be scanned again; no other sold piece may', () => {
  it('`canScan` allows a Sold piece only when the old bill sold it', async () => {
    const ctx = await world();
    const { bill, lines } = estimate();
    ctx.rowCache.merge('bills', [bill]);
    ctx.rowCache.merge('bill-items', lines);
    const setup = ctx.reissue.prepareReissue(bill.id, 'owner');
    if (!setup.ok) throw new Error('setup refused');
    expect(ctx.reissue.freedByCancel(setup, { id: skuRow(1, 1).id, status: 'Sold' })).toBe(true);
    expect(ctx.reissue.freedByCancel(setup, { id: skuRow(3, 1).id, status: 'Sold' })).toBe(false);
    expect(ctx.reissue.freedByCancel(setup, { id: skuRow(1, 1).id, status: 'In Stock' })).toBe(
      false
    );
  });
});
