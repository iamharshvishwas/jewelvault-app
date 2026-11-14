// FB-B3 (Siddhi #8): a piece can be picked for the bill without a barcode. `searchPieces(query, limit = 20)` of src/lib/designStore.ts reads the same in-memory view as `findSkuByCode`:
//   - a case-insensitive substring of the design number, the design name, the piece number or the barcode
//   - only pieces that can be billed: In Stock, and Reserved or On Approval (which the billing screen still asks about); never a Sold piece, nor any other status
//   - In Stock first, then by design number (then piece number); at most `limit` (20 unless told)
//   - nothing for an empty query or one character
//
// The store is filled with rows as the hydrate would (tests/unit/support/rows.ts).
//
// Run: npm test -- tests/unit/search-pieces.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryRow, designRow, skuRow, uuid } from './support/rows';

async function world() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const [cache, designs] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/designStore'),
  ]);
  return { cache: cache.rowCache, designs };
}
type World = Awaited<ReturnType<typeof world>>;

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Three designs: RING-00001 "Alpha ring" (four pieces: In Stock, In Stock, Sold, Reserved), CH-00002 "Beta chain" (In Stock, On Approval, Repair, Archived), and BNG-00003 "Gamma bangle"
 * (one In Stock piece whose barcode is BCGAMMA9).
 */
function fillShop(cache: World['cache']) {
  cache.merge('categories', [
    categoryRow(1, 'Ring', 'RING'),
    categoryRow(2, 'Chain', 'CH'),
    categoryRow(3, 'Bangle', 'BNG'),
  ]);
  cache.merge('designs', [
    designRow(1, { design_no: 'RING-00001', name: 'Alpha ring', category_id: uuid(101) }),
    designRow(2, { design_no: 'CH-00002', name: 'Beta chain', category_id: uuid(102) }),
    designRow(3, { design_no: 'BNG-00003', name: 'Gamma bangle', category_id: uuid(103) }),
  ]);
  cache.merge('skus', [
    skuRow(1, 1, { sku_no: 'RING-00001-001', barcode: 'BCALPHA1' }),
    skuRow(2, 1, { sku_no: 'RING-00001-002', barcode: 'BCALPHA2' }),
    skuRow(3, 1, { sku_no: 'RING-00001-003', barcode: 'BCALPHA3', status: 'Sold' }),
    skuRow(4, 1, { sku_no: 'RING-00001-004', barcode: 'BCALPHA4', status: 'Reserved' }),
    skuRow(5, 2, { sku_no: 'CH-00002-001', barcode: 'BCBETA1' }),
    skuRow(6, 2, { sku_no: 'CH-00002-002', barcode: 'BCBETA2', status: 'On Approval' }),
    skuRow(7, 2, { sku_no: 'CH-00002-003', barcode: 'BCBETA3', status: 'Repair' }),
    skuRow(8, 2, { sku_no: 'CH-00002-004', barcode: 'BCBETA4', status: 'Archived' }),
    skuRow(9, 3, { sku_no: 'BNG-00003-001', barcode: 'BCGAMMA9' }),
  ]);
}

const numbers = (found: Array<{ sku: { skuNumber: string } }>) =>
  found.map((match) => match.sku.skuNumber);

describe('FB-B3 searchPieces', () => {
  it('"ring" finds the pieces of the design by its name and by its number, as the design and the piece', async () => {
    const w = await world();
    fillShop(w.cache);
    const found = w.designs.searchPieces('ring');
    expect(numbers(found)).toEqual(['RING-00001-001', 'RING-00001-002', 'RING-00001-004']);
    for (const match of found) {
      expect(match.design.designNumber).toBe('RING-00001');
      expect(match.design.skus).toContain(match.sku);
    }
    // by number alone, and by name alone
    expect(numbers(w.designs.searchPieces('00002'))).toEqual(['CH-00002-001', 'CH-00002-002']);
    expect(numbers(w.designs.searchPieces('gamma'))).toEqual(['BNG-00003-001']);
  });

  it('is case-insensitive and finds any part of a piece number or a barcode', async () => {
    const w = await world();
    fillShop(w.cache);
    expect(numbers(w.designs.searchPieces('ALPHA RING'))).toHaveLength(3);
    expect(numbers(w.designs.searchPieces('Alpha'))).toEqual(
      numbers(w.designs.searchPieces('aLPHA'))
    );
    expect(numbers(w.designs.searchPieces('ng-00003-0'))).toEqual(['BNG-00003-001']);
    expect(numbers(w.designs.searchPieces('bcgamma'))).toEqual(['BNG-00003-001']);
    expect(numbers(w.designs.searchPieces('GAMMA9'))).toEqual(['BNG-00003-001']);
    expect(numbers(w.designs.searchPieces('nothing like this'))).toEqual([]);
  });

  it('never offers a Sold piece, nor a piece in any status the bill refuses (Repair, Archived)', async () => {
    const w = await world();
    fillShop(w.cache);
    expect(numbers(w.designs.searchPieces('BCALPHA3'))).toEqual([]);
    expect(numbers(w.designs.searchPieces('RING-00001-003'))).toEqual([]);
    expect(numbers(w.designs.searchPieces('BCBETA3'))).toEqual([]);
    expect(numbers(w.designs.searchPieces('BCBETA4'))).toEqual([]);
    const all = w.designs.searchPieces('-00', 100);
    expect(all.map((m) => m.sku.status).sort()).toEqual([
      'In Stock',
      'In Stock',
      'In Stock',
      'In Stock',
      'On Approval',
      'Reserved',
    ]);
  });

  it('offers the Reserved and the On Approval piece (the bill asks about them), after the In Stock ones, each group by design number', async () => {
    const w = await world();
    fillShop(w.cache);
    const found = w.designs.searchPieces('-00', 100);
    expect(numbers(found)).toEqual([
      // In Stock: by design number (BNG, CH, RING), then piece number
      'BNG-00003-001',
      'CH-00002-001',
      'RING-00001-001',
      'RING-00001-002',
      // then the held ones: by design number
      'CH-00002-002',
      'RING-00001-004',
    ]);
    expect(found.slice(4).map((m) => m.sku.status)).toEqual(['On Approval', 'Reserved']);
  });

  it('keeps to the limit (20 unless told), cutting after the sorting', async () => {
    const w = await world();
    fillShop(w.cache);
    w.cache.merge(
      'skus',
      Array.from({ length: 25 }, (_, i) =>
        skuRow(100 + i, 3, {
          sku_no: `BNG-00003-${String(100 + i)}`,
          barcode: `BCMANY${String(100 + i)}`,
        })
      )
    );
    // 26 In Stock pieces of the bangle design, and one held piece of the ring that the sorting puts last
    expect(w.designs.searchPieces('-00')).toHaveLength(20);
    expect(w.designs.searchPieces('-00').every((m) => m.sku.status === 'In Stock')).toBe(true);
    expect(w.designs.searchPieces('-00', 3)).toHaveLength(3);
    expect(w.designs.searchPieces('-00', 1000).length).toBeGreaterThan(20);
  });

  it('an empty query, a blank one or a single character finds nothing', async () => {
    const w = await world();
    fillShop(w.cache);
    expect(w.designs.searchPieces('')).toEqual([]);
    expect(w.designs.searchPieces('   ')).toEqual([]);
    expect(w.designs.searchPieces('r')).toEqual([]);
    expect(w.designs.searchPieces(' r ')).toEqual([]);
    expect(w.designs.searchPieces('ri')).not.toEqual([]);
  });

  it('answers from the same view as findSkuByCode: a piece it returns is the piece a scan of its number finds', async () => {
    const w = await world();
    fillShop(w.cache);
    for (const match of w.designs.searchPieces('-00', 100)) {
      expect(w.designs.findSkuByCode(match.sku.skuNumber)?.sku).toBe(match.sku);
      expect(w.designs.findSkuByCode(match.sku.barcode)?.sku).toBe(match.sku);
    }
  });

  it('before the stock is loaded, or after a logout, there is nothing to find', async () => {
    const w = await world();
    expect(w.designs.searchPieces('ring')).toEqual([]);
  });
});
