/**
 * Unit tests for src/lib/inventoryFilter.ts and src/lib/inventoryFilterStore.ts: the filter panel of the Inventory screen.
 *
 * The panel used to keep its ticks to itself and the grid never read them (found on staging, 21 Oct 2026). These tests fix the rules the grid, the table and the
 * header now share:
 *   - inside one section the ticks are OR, across sections they are AND;
 *   - material, category and purity are the DESIGN's (spec D6: they live on the design and only there; D7: a piece has none of its own);
 *   - status, location and the weight range are the PIECE's, and one piece has to satisfy all of the ones that are set (a design with an In Stock piece in the Main Showroom and
 *     a Sold piece in the Workshop is not "In Stock in the Workshop");
 *   - Sold and Archived are statuses like the others (D8): a design whose pieces are all Sold is listed with no filter and under Sold, not under In Stock;
 *   - the search box matches design number, design name, piece number and barcode, in any case;
 *   - the weight is the gross weight of a piece, both ends included; a gross weight of 0 is a weight nobody recorded (O37) and never matches a weight range.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  NO_FILTER,
  countActiveFilters,
  filterDesigns,
  inventoryStats,
  isFilterActive,
  locationOptions,
  type InventoryFilter,
} from '@/lib/inventoryFilter';
import {
  clearInventoryFilter,
  getInventoryFilter,
  setInventoryWeight,
  setInventorySearch,
  subscribeInventoryFilter,
  toggleInventoryOption,
} from '@/lib/inventoryFilterStore';
import type { Design, Sku, SkuStatus } from '@/lib/mockData';

// ------------------------------------------------------------------------------------------------ fixture

function sku(skuNumber: string, over: Partial<Sku> = {}): Sku {
  return {
    id: `id-${skuNumber}`,
    skuNumber,
    designId: '',
    designNumber: '',
    grossWeight: 10,
    originalNetWeight: 0,
    customerNetWeight: 9,
    stones: 0,
    stoneWeight: 0,
    kundan: 0,
    kundanWeight: 0,
    piroi: 0,
    labour: 0,
    status: 'In Stock',
    location: 'Main Showroom',
    barcode: `BC-${skuNumber}`,
    createdAt: '',
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

function design(designNumber: string, over: Partial<Design> = {}): Design {
  return {
    id: `id-${designNumber}`,
    designNumber,
    designName: '',
    category: 'Ring',
    subcategory: '',
    material: 'Gold',
    purity: '22K',
    sellingMethod: 'By Weight',
    description: '',
    notes: '',
    tags: [],
    images: [],
    primaryImage: '',
    skus: [],
    createdAt: '',
    createdBy: '',
    labour: 0,
    piroi: 0,
    ...over,
  };
}

const filter = (over: Partial<InventoryFilter> = {}): InventoryFilter => ({
  ...NO_FILTER,
  ...over,
});
const numbers = (list: Design[]) => list.map((d) => d.designNumber);

// the stock every test filters: eight designs, each there for one reason
const GOLD_RING = design('R-001', {
  designName: 'Lotus Ring',
  skus: [sku('R-001-1', { grossWeight: 5, barcode: 'JV0001' })],
});
const GOLD_RING_2 = design('R-002', {
  designName: 'Peacock Ring',
  purity: '18K',
  skus: [sku('R-002-1', { grossWeight: 12.5, status: 'Reserved', location: 'Workshop' })],
});
const GOLD_CHAIN = design('C-001', {
  designName: 'Rope Chain',
  category: 'Chain',
  skus: [
    sku('C-001-1', { grossWeight: 30, location: 'Jaishri Vault' }),
    sku('C-001-2', { grossWeight: 8, status: 'Sold', location: 'Workshop' }),
  ],
});
const SILVER_RING = design('R-003', {
  designName: 'Moon Ring',
  material: 'Silver',
  purity: '925',
  skus: [sku('R-003-1', { grossWeight: 20, material: 'Silver', purity: '925' })],
});
const SILVER_ANKLET = design('A-001', {
  designName: 'Payal Classic',
  material: 'Silver',
  purity: '925',
  category: 'Anklet',
  skus: [sku('A-001-1', { grossWeight: 45, status: 'Archived', location: 'Exhibition' })],
});
const ALL_SOLD = design('K-001', {
  designName: 'Sold Out Kada',
  category: 'Kada',
  skus: [
    sku('K-001-1', { grossWeight: 60, status: 'Sold' }),
    sku('K-001-2', { grossWeight: 62, status: 'Sold' }),
  ],
});
const NO_PIECES = design('N-001', { designName: 'Sketch only', category: 'Pendant', skus: [] });
const UNWEIGHED = design('U-001', {
  designName: 'Unweighed Ring',
  skus: [sku('U-001-1', { grossWeight: 0 })],
});

const STOCK = [
  GOLD_RING,
  GOLD_RING_2,
  GOLD_CHAIN,
  SILVER_RING,
  SILVER_ANKLET,
  ALL_SOLD,
  NO_PIECES,
  UNWEIGHED,
];

// ------------------------------------------------------------------------------------------------ no filter

describe('filterDesigns with nothing set', () => {
  it('returns the list it was given, the same array, so a screen that shows it re-renders for nothing', () => {
    expect(filterDesigns(STOCK, NO_FILTER)).toBe(STOCK);
  });

  it('treats a blank or spaces-only search and blank weight boxes as nothing set', () => {
    expect(filterDesigns(STOCK, filter({ search: '   ', weightMin: ' ', weightMax: '' }))).toBe(
      STOCK
    );
  });

  it('keeps a design that has no pieces and one that is entirely Sold', () => {
    const shown = numbers(filterDesigns(STOCK, NO_FILTER));
    expect(shown).toContain('N-001');
    expect(shown).toContain('K-001');
  });
});

// ------------------------------------------------------------------------------------------------ the five sections

describe('material, category and purity (the design’s own)', () => {
  it('Gold alone shows the gold designs', () => {
    expect(numbers(filterDesigns(STOCK, filter({ material: ['Gold'] })))).toEqual([
      'R-001',
      'R-002',
      'C-001',
      'K-001',
      'N-001',
      'U-001',
    ]);
  });

  it('two ticks in one section are OR: Gold or Silver is everything', () => {
    expect(filterDesigns(STOCK, filter({ material: ['Gold', 'Silver'] }))).toHaveLength(
      STOCK.length
    );
  });

  it('two sections are AND: Gold and Ring', () => {
    expect(
      numbers(filterDesigns(STOCK, filter({ material: ['Gold'], category: ['Ring'] })))
    ).toEqual(['R-001', 'R-002', 'U-001']);
  });

  it('two categories are OR: Ring or Chain, in Gold', () => {
    expect(
      numbers(filterDesigns(STOCK, filter({ material: ['Gold'], category: ['Ring', 'Chain'] })))
    ).toEqual(['R-001', 'R-002', 'C-001', 'U-001']);
  });

  it('purity is the design’s, so a design with no pieces still has one', () => {
    const sketch = design('N-002', { purity: '24K', skus: [] });
    expect(numbers(filterDesigns([GOLD_RING, sketch], filter({ purity: ['24K'] })))).toEqual([
      'N-002',
    ]);
  });

  it('purity 18K or 925', () => {
    expect(numbers(filterDesigns(STOCK, filter({ purity: ['18K', '925'] })))).toEqual([
      'R-002',
      'R-003',
      'A-001',
    ]);
  });

  it('a tick that matches nothing leaves nothing', () => {
    expect(filterDesigns(STOCK, filter({ category: ['Brooch'] }))).toEqual([]);
  });
});

describe('status (the pieces’)', () => {
  it('a design matches when at least one of its pieces has the status', () => {
    expect(numbers(filterDesigns(STOCK, filter({ status: ['Sold'] })))).toEqual(['C-001', 'K-001']);
  });

  it('In Stock leaves out a design whose pieces are all Sold, and keeps one that has a piece in stock', () => {
    const shown = numbers(filterDesigns(STOCK, filter({ status: ['In Stock'] })));
    expect(shown).not.toContain('K-001');
    expect(shown).toContain('C-001');
  });

  it('Sold and Archived are the pieces’ statuses and nothing more: Archived shows the design with an archived piece', () => {
    expect(numbers(filterDesigns(STOCK, filter({ status: ['Archived'] })))).toEqual(['A-001']);
  });

  it('two statuses are OR', () => {
    expect(numbers(filterDesigns(STOCK, filter({ status: ['Reserved', 'Archived'] })))).toEqual([
      'R-002',
      'A-001',
    ]);
  });

  it('a design with no pieces has no status, so any status tick leaves it out', () => {
    const every: SkuStatus[] = ['In Stock', 'Sold', 'Archived', 'Returned'];
    for (const status of every) {
      expect(numbers(filterDesigns([NO_PIECES], filter({ status: [status] })))).toEqual([]);
    }
  });
});

describe('location (the pieces’)', () => {
  it('a design matches when at least one piece is there', () => {
    expect(numbers(filterDesigns(STOCK, filter({ location: ['Workshop'] })))).toEqual([
      'R-002',
      'C-001',
    ]);
  });

  it('two locations are OR', () => {
    expect(
      numbers(filterDesigns(STOCK, filter({ location: ['Jaishri Vault', 'Exhibition'] })))
    ).toEqual(['C-001', 'A-001']);
  });
});

describe('the piece-level sections together are about ONE piece', () => {
  it('In Stock and Workshop is not a design whose in-stock piece is elsewhere and whose Workshop piece is Sold', () => {
    // C-001 has an In Stock piece in the Vault and a Sold piece in the Workshop
    const shown = numbers(
      filterDesigns(STOCK, filter({ status: ['In Stock'], location: ['Workshop'] }))
    );
    expect(shown).not.toContain('C-001');
  });

  it('Sold and Workshop is that same design, because its Sold piece is in the Workshop', () => {
    expect(
      numbers(filterDesigns(STOCK, filter({ status: ['Sold'], location: ['Workshop'] })))
    ).toEqual(['C-001']);
  });

  it('a piece-level section and a design-level section are AND: Silver and Archived', () => {
    expect(
      numbers(filterDesigns(STOCK, filter({ material: ['Silver'], status: ['Archived'] })))
    ).toEqual(['A-001']);
    expect(filterDesigns(STOCK, filter({ material: ['Gold'], status: ['Archived'] }))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the search box

describe('search', () => {
  it('finds a design by its number, in any case, with spaces around it', () => {
    expect(numbers(filterDesigns(STOCK, filter({ search: '  r-001 ' })))).toEqual(['R-001']);
  });

  it('finds a design by a piece of its name', () => {
    expect(numbers(filterDesigns(STOCK, filter({ search: 'peacock' })))).toEqual(['R-002']);
  });

  it('finds the design of a piece by the piece’s number', () => {
    expect(numbers(filterDesigns(STOCK, filter({ search: 'c-001-2' })))).toEqual(['C-001']);
  });

  it('finds the design of a piece by its barcode, in any case', () => {
    expect(numbers(filterDesigns(STOCK, filter({ search: 'jv0001' })))).toEqual(['R-001']);
  });

  it('matches part of a word, not only the start', () => {
    expect(numbers(filterDesigns(STOCK, filter({ search: 'ring' })))).toEqual([
      'R-001',
      'R-002',
      'R-003',
      'U-001',
    ]);
  });

  it('finds nothing for text that is in none of the four', () => {
    expect(filterDesigns(STOCK, filter({ search: 'zzz' }))).toEqual([]);
  });

  it('is AND with the sections', () => {
    expect(numbers(filterDesigns(STOCK, filter({ search: 'ring', material: ['Silver'] })))).toEqual(
      ['R-003']
    );
  });

  it('does not search the category, the notes or the tags', () => {
    const tagged = design('T-001', { tags: ['festive'], notes: 'festive', description: 'festive' });
    expect(filterDesigns([tagged], filter({ search: 'festive' }))).toEqual([]);
    expect(
      filterDesigns([design('X-1', { category: 'Brooch' })], filter({ search: 'brooch' }))
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the weight range

describe('weight range (the gross weight of a piece, in grams)', () => {
  it('both ends are included', () => {
    expect(
      numbers(
        filterDesigns(
          [GOLD_RING, GOLD_RING_2, SILVER_RING],
          filter({ weightMin: '5', weightMax: '12.5' })
        )
      )
    ).toEqual(['R-001', 'R-002']);
  });

  it('a minimum alone', () => {
    expect(numbers(filterDesigns(STOCK, filter({ weightMin: '45' })))).toEqual(['A-001', 'K-001']);
  });

  it('a maximum alone', () => {
    expect(numbers(filterDesigns(STOCK, filter({ weightMax: '8' })))).toEqual(['R-001', 'C-001']);
  });

  it('a design matches when ONE of its pieces is in the range, not when they add up to it', () => {
    // C-001 has pieces of 30 g and 8 g (38 g together)
    expect(
      numbers(filterDesigns([GOLD_CHAIN], filter({ weightMin: '7', weightMax: '9' })))
    ).toEqual(['C-001']);
    expect(filterDesigns([GOLD_CHAIN], filter({ weightMin: '36', weightMax: '40' }))).toEqual([]);
  });

  it('a gross weight of 0 was never recorded and matches no range, however wide', () => {
    expect(filterDesigns([UNWEIGHED], filter({ weightMax: '1000' }))).toEqual([]);
    expect(filterDesigns([UNWEIGHED], filter({ weightMin: '0', weightMax: '1000' }))).toEqual([]);
  });

  it('a design with no pieces matches no range', () => {
    expect(filterDesigns([NO_PIECES], filter({ weightMin: '0' }))).toEqual([]);
  });

  it('is about the same piece as the status: In Stock between 7 and 9 g is not the Sold piece of 8 g', () => {
    // C-001: In Stock piece 30 g, Sold piece 8 g
    expect(
      filterDesigns([GOLD_CHAIN], filter({ status: ['In Stock'], weightMin: '7', weightMax: '9' }))
    ).toEqual([]);
    expect(
      numbers(
        filterDesigns([GOLD_CHAIN], filter({ status: ['Sold'], weightMin: '7', weightMax: '9' }))
      )
    ).toEqual(['C-001']);
  });

  it('ignores a box that holds something that is not a weight', () => {
    expect(filterDesigns(STOCK, filter({ weightMin: 'abc' }))).toBe(STOCK);
    expect(filterDesigns(STOCK, filter({ weightMax: '-3' }))).toBe(STOCK);
    expect(filterDesigns(STOCK, filter({ weightMin: 'abc', weightMax: '8' }))).toHaveLength(2);
  });

  it('a minimum above the maximum matches nothing', () => {
    expect(filterDesigns(STOCK, filter({ weightMin: '50', weightMax: '10' }))).toEqual([]);
  });

  it('reads a weight with three decimals exactly', () => {
    const fine = design('F-001', { skus: [sku('F-001-1', { grossWeight: 12.345 })] });
    expect(
      numbers(filterDesigns([fine], filter({ weightMin: '12.345', weightMax: '12.345' })))
    ).toEqual(['F-001']);
    expect(filterDesigns([fine], filter({ weightMin: '12.346' }))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the count on "Clear (n)"

describe('countActiveFilters and isFilterActive', () => {
  it('is 0 for nothing', () => {
    expect(countActiveFilters(NO_FILTER)).toBe(0);
    expect(isFilterActive(NO_FILTER)).toBe(false);
  });

  it('counts every tick, the search as one and the weight range as one', () => {
    const f = filter({
      material: ['Gold'],
      category: ['Ring', 'Chain'],
      status: ['Sold'],
      search: 'ring',
      weightMin: '5',
      weightMax: '9',
    });
    expect(countActiveFilters(f)).toBe(1 + 2 + 1 + 1 + 1);
    expect(isFilterActive(f)).toBe(true);
  });

  it('does not count blanks, spaces or a box that is not a weight', () => {
    expect(countActiveFilters(filter({ search: '  ', weightMin: 'x', weightMax: '' }))).toBe(0);
    expect(isFilterActive(filter({ search: '  ', weightMin: 'x', weightMax: '' }))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------ the header line

describe('inventoryStats', () => {
  it('counts the designs, all the pieces of those designs and the pieces in stock', () => {
    expect(inventoryStats(STOCK)).toEqual({ designs: 8, skus: 9, inStock: 4 });
  });

  it('counts the whole of a design that was found by one of its pieces', () => {
    const found = filterDesigns(STOCK, filter({ status: ['Sold'] })); // C-001 (two pieces) and K-001 (two pieces)
    expect(inventoryStats(found)).toEqual({ designs: 2, skus: 4, inStock: 1 });
  });

  it('is zero for nothing', () => {
    expect(inventoryStats([])).toEqual({ designs: 0, skus: 0, inStock: 0 });
  });
});

// ------------------------------------------------------------------------------------------------ the location options

describe('locationOptions', () => {
  it('is the shop’s places first, in its order, then the ones only the pieces have, then nothing twice', () => {
    expect(locationOptions(STOCK, ['Jaishri Vault', 'Main Showroom'])).toEqual([
      'Jaishri Vault',
      'Main Showroom',
      'Workshop',
      'Exhibition',
    ]);
  });

  it('takes the pieces’ places when the shop’s list is empty (a role that does not read the settings)', () => {
    expect(locationOptions(STOCK, [])).toEqual([
      'Main Showroom',
      'Workshop',
      'Jaishri Vault',
      'Exhibition',
    ]);
  });

  it('leaves out a piece with no place', () => {
    const lost = design('L-1', { skus: [sku('L-1-1', { location: '' })] });
    expect(locationOptions([lost], [])).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ the store

describe('the filter store', () => {
  beforeEach(() => clearInventoryFilter());

  it('starts with nothing set', () => {
    expect(getInventoryFilter()).toBe(NO_FILTER);
  });

  it('a tick adds the option and the same tick again takes it away', () => {
    toggleInventoryOption('material', 'Gold');
    expect(getInventoryFilter().material).toEqual(['Gold']);
    toggleInventoryOption('material', 'Silver');
    expect(getInventoryFilter().material).toEqual(['Gold', 'Silver']);
    toggleInventoryOption('material', 'Gold');
    expect(getInventoryFilter().material).toEqual(['Silver']);
  });

  it('every change makes a new object, which is how a screen knows to go back to page 1', () => {
    const before = getInventoryFilter();
    toggleInventoryOption('status', 'Sold');
    const afterTick = getInventoryFilter();
    expect(afterTick).not.toBe(before);
    setInventorySearch('ring');
    expect(getInventoryFilter()).not.toBe(afterTick);
    expect(getInventoryFilter().search).toBe('ring');
  });

  it('a change of the weight boxes sets one end at a time', () => {
    setInventoryWeight('min', '5');
    setInventoryWeight('max', '9.5');
    expect(getInventoryFilter()).toMatchObject({ weightMin: '5', weightMax: '9.5' });
    setInventoryWeight('min', '');
    expect(getInventoryFilter()).toMatchObject({ weightMin: '', weightMax: '9.5' });
  });

  it('clear resets every part and is the very object a fresh start has', () => {
    toggleInventoryOption('category', 'Ring');
    setInventorySearch('x');
    setInventoryWeight('min', '1');
    clearInventoryFilter();
    expect(getInventoryFilter()).toBe(NO_FILTER);
  });

  it('clear when nothing is set does not tell anybody', () => {
    let calls = 0;
    const off = subscribeInventoryFilter(() => {
      calls += 1;
    });
    clearInventoryFilter();
    off();
    expect(calls).toBe(0);
  });

  it('tells a subscriber on a change and stops after it unsubscribes', () => {
    let calls = 0;
    const off = subscribeInventoryFilter(() => {
      calls += 1;
    });
    toggleInventoryOption('purity', '22K');
    setInventorySearch('a');
    expect(calls).toBe(2);
    off();
    toggleInventoryOption('purity', '24K');
    expect(calls).toBe(2);
  });
});
