/**
 * Unit tests for src/lib/inventorySort.ts and src/lib/inventoryViewStore.ts: the sort box and the grid/table switch of the Inventory screen.
 *
 * The sort box ("Newest First" and four more) kept its choice and never used it, and the two grid/table switches (one in the header, one above the grid)
 * were two separate bits of state. These tests fix what each choice means:
 *   - Newest First / Oldest First: the design's created_at (`createdAt`);
 *   - Design Number: the design number, numbers inside it in number order (R-2 before R-10), any case;
 *   - Category: the category name, any case;
 *   - Weight (High-Low): the gross weight of the design's pieces added together, the figure the card and the table show as "GW" and "Gross Wt.", worked out in
 *     milligrams so that 0.1 g and 0.2 g are exactly 0.3 g;
 *   - every tie ends in the design number and then the id, so the order never depends on the order the designs were handed in, and a filter only takes designs
 *     out of it without moving the others.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { NO_FILTER, filterDesigns } from '@/lib/inventoryFilter';
import { SORT_OPTIONS, sortDesigns, totalGrossMilligrams, type SortId } from '@/lib/inventorySort';
import {
  getInventoryView,
  resetInventoryView,
  setInventoryView,
  subscribeInventoryView,
} from '@/lib/inventoryViewStore';
import type { Design, Sku } from '@/lib/mockData';

// ------------------------------------------------------------------------------------------------ fixture

function piece(skuNumber: string, grossWeight: number): Sku {
  return {
    id: `id-${skuNumber}`,
    skuNumber,
    designId: '',
    designNumber: '',
    grossWeight,
    originalNetWeight: 0,
    customerNetWeight: 0,
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
  };
}

function design(
  designNumber: string,
  over: Partial<Design> = {},
  weights: number[] = [10]
): Design {
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
    skus: weights.map((w, i) => piece(`${designNumber}-${i + 1}`, w)),
    createdAt: '2026-10-10T10:00:00.000Z',
    createdBy: '',
    labour: 0,
    piroi: 0,
    ...over,
  };
}

const numbers = (list: Design[]) => list.map((d) => d.designNumber);

// ------------------------------------------------------------------------------------------------ the options

describe('SORT_OPTIONS', () => {
  it('are the five of the box, in its order, with the ids the screen has always used', () => {
    expect(SORT_OPTIONS.map((o) => [o.id, o.label])).toEqual([
      ['sort-newest', 'Newest First'],
      ['sort-oldest', 'Oldest First'],
      ['sort-design', 'Design Number'],
      ['sort-category', 'Category'],
      ['sort-weight', 'Weight (High–Low)'],
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ newest and oldest

describe('newest and oldest (the created_at of the design)', () => {
  const A = design('A-1', { createdAt: '2026-10-01T09:00:00.000Z' });
  const B = design('B-1', { createdAt: '2026-10-03T09:00:00.000Z' });
  const C = design('C-1', { createdAt: '2026-10-02T09:00:00.000Z' });

  it('Newest First puts the latest created first', () => {
    expect(numbers(sortDesigns([A, B, C], 'sort-newest'))).toEqual(['B-1', 'C-1', 'A-1']);
  });

  it('Oldest First is the other way round', () => {
    expect(numbers(sortDesigns([A, B, C], 'sort-oldest'))).toEqual(['A-1', 'C-1', 'B-1']);
  });

  it('reads the time, not the text: a later time on the same day is newer, and so is a later year', () => {
    const morning = design('M-1', { createdAt: '2026-10-05T03:00:00.000Z' });
    const evening = design('E-1', { createdAt: '2026-10-05T15:30:00.000Z' });
    const lastYear = design('Y-1', { createdAt: '2025-12-31T23:59:59.000Z' });
    expect(numbers(sortDesigns([morning, lastYear, evening], 'sort-newest'))).toEqual([
      'E-1',
      'M-1',
      'Y-1',
    ]);
  });

  it('a design with no readable creation time counts as the oldest, in either direction', () => {
    const none = design('N-1', { createdAt: '' });
    const odd = design('O-1', { createdAt: 'not a date' });
    expect(numbers(sortDesigns([none, A, odd, B], 'sort-newest'))).toEqual([
      'B-1',
      'A-1',
      'N-1',
      'O-1',
    ]);
    expect(numbers(sortDesigns([B, none, A, odd], 'sort-oldest'))).toEqual([
      'N-1',
      'O-1',
      'A-1',
      'B-1',
    ]);
  });

  it('designs made at the same moment are ordered by design number', () => {
    const same = '2026-10-05T10:00:00.000Z';
    const list = [
      design('R-10', { createdAt: same }),
      design('R-2', { createdAt: same }),
      design('R-1', { createdAt: same }),
    ];
    expect(numbers(sortDesigns(list, 'sort-newest'))).toEqual(['R-1', 'R-2', 'R-10']);
    expect(numbers(sortDesigns(list, 'sort-oldest'))).toEqual(['R-1', 'R-2', 'R-10']);
  });
});

// ------------------------------------------------------------------------------------------------ design number

describe('design number', () => {
  it('puts the numbers inside a design number in number order, in any case', () => {
    const list = [design('R-10'), design('r-2'), design('R-1'), design('A-100'), design('A-20')];
    expect(numbers(sortDesigns(list, 'sort-design'))).toEqual([
      'A-20',
      'A-100',
      'R-1',
      'r-2',
      'R-10',
    ]);
  });

  it('is the same for zero-padded numbers', () => {
    const list = [design('RING-00012'), design('RING-00002'), design('RING-00101')];
    expect(numbers(sortDesigns(list, 'sort-design'))).toEqual([
      'RING-00002',
      'RING-00012',
      'RING-00101',
    ]);
  });
});

// ------------------------------------------------------------------------------------------------ category

describe('category', () => {
  it('is alphabetical, in any case, and designs of one category go by design number', () => {
    const list = [
      design('K-2', { category: 'kada' }),
      design('R-1', { category: 'Ring' }),
      design('K-1', { category: 'Kada' }),
      design('A-1', { category: 'Anklet' }),
    ];
    expect(numbers(sortDesigns(list, 'sort-category'))).toEqual(['A-1', 'K-1', 'K-2', 'R-1']);
  });

  it('a design with no category comes first, not lost', () => {
    const list = [design('R-1', { category: 'Ring' }), design('X-1', { category: '' })];
    expect(numbers(sortDesigns(list, 'sort-category'))).toEqual(['X-1', 'R-1']);
  });
});

// ------------------------------------------------------------------------------------------------ weight

describe('weight (High–Low): the gross weight of all the pieces of a design', () => {
  it('adds the pieces of a design together and puts the heaviest first', () => {
    const light = design('L-1', {}, [5]);
    const heavy = design('H-1', {}, [30, 8]); // 38 g together, though no piece is above 30 g
    const mid = design('M-1', {}, [20, 12]); // 32 g together
    expect(numbers(sortDesigns([light, mid, heavy], 'sort-weight'))).toEqual(['H-1', 'M-1', 'L-1']);
  });

  it('works in milligrams: 0.1 g and 0.2 g are exactly the 0.3 g of another design, a tie that goes by design number', () => {
    const sum = design('B-1', {}, [0.1, 0.2]);
    const whole = design('A-1', {}, [0.3]);
    expect(totalGrossMilligrams(sum)).toBe(300);
    expect(totalGrossMilligrams(whole)).toBe(300);
    expect(numbers(sortDesigns([sum, whole], 'sort-weight'))).toEqual(['A-1', 'B-1']);
  });

  it('a design with no pieces, or with no weight recorded (0), comes last', () => {
    const none = design('N-1', {}, []);
    const unweighed = design('U-1', {}, [0, 0]);
    const some = design('S-1', {}, [0.001]);
    expect(numbers(sortDesigns([none, unweighed, some], 'sort-weight'))).toEqual([
      'S-1',
      'N-1',
      'U-1',
    ]);
    expect(totalGrossMilligrams(none)).toBe(0);
  });

  it('reads three decimals exactly, also where the number is a hair off in the computer (1.005 g is 1,005 mg, not 1,004.9999999999999)', () => {
    expect(totalGrossMilligrams(design('D-1', {}, [12.345, 0.655]))).toBe(13000);
    expect(totalGrossMilligrams(design('D-2', {}, [1.005]))).toBe(1005);
  });
});

// ------------------------------------------------------------------------------------------------ order that does not move

describe('the order is a function of the designs and the choice, nothing else', () => {
  const stock = [
    design('R-1', { category: 'Ring', createdAt: '2026-10-01T00:00:00.000Z' }, [5]),
    design(
      'R-2',
      { category: 'Ring', createdAt: '2026-10-04T00:00:00.000Z', material: 'Silver' },
      [20, 5]
    ),
    design('C-1', { category: 'Chain', createdAt: '2026-10-04T00:00:00.000Z' }, [25]),
    design(
      'C-2',
      { category: 'Chain', createdAt: '2026-10-02T00:00:00.000Z', material: 'Silver' },
      [25]
    ),
    design('K-1', { category: 'Kada', createdAt: '2026-10-03T00:00:00.000Z' }, [60]),
    design('K-2', { category: 'Kada', createdAt: '' }, []),
  ];
  const everySort = SORT_OPTIONS.map((o) => o.id as SortId);

  it('does not depend on the order the designs are handed in', () => {
    const backwards = [...stock].reverse();
    const shuffled = [stock[3], stock[0], stock[5], stock[1], stock[4], stock[2]];
    for (const sort of everySort) {
      const expected = numbers(sortDesigns(stock, sort));
      expect(numbers(sortDesigns(backwards, sort)), sort).toEqual(expected);
      expect(numbers(sortDesigns(shuffled, sort)), sort).toEqual(expected);
    }
  });

  it('a filter takes designs out and moves none of the others', () => {
    const silver = { ...NO_FILTER, material: ['Silver'] };
    for (const sort of everySort) {
      const all = sortDesigns(stock, sort);
      const keptInOrder = all.filter((d) => d.material === 'Silver');
      expect(numbers(sortDesigns(filterDesigns(stock, silver), sort)), sort).toEqual(
        numbers(keptInOrder)
      );
      expect(numbers(filterDesigns(sortDesigns(stock, sort), silver)), sort).toEqual(
        numbers(keptInOrder)
      );
    }
  });

  it('does not change the list it is given, and gives back a new one', () => {
    const copy = [...stock];
    const sorted = sortDesigns(stock, 'sort-weight');
    expect(stock).toEqual(copy);
    expect(sorted).not.toBe(stock);
  });
});

// ------------------------------------------------------------------------------------------------ the grid/table switch

describe('the view store', () => {
  beforeEach(() => resetInventoryView());

  it('starts on the grid', () => {
    expect(getInventoryView()).toBe('grid');
  });

  it('is one choice for the header’s switch and the one above the grid', () => {
    setInventoryView('table');
    expect(getInventoryView()).toBe('table');
    setInventoryView('grid');
    expect(getInventoryView()).toBe('grid');
  });

  it('tells a subscriber once for a change, not for the same choice again, and not after it unsubscribes', () => {
    let calls = 0;
    const off = subscribeInventoryView(() => {
      calls += 1;
    });
    setInventoryView('table');
    setInventoryView('table');
    expect(calls).toBe(1);
    resetInventoryView();
    expect(calls).toBe(2);
    off();
    setInventoryView('table');
    expect(calls).toBe(2);
  });

  it('reset goes back to the grid and tells nobody when it was already there', () => {
    let calls = 0;
    const off = subscribeInventoryView(() => {
      calls += 1;
    });
    resetInventoryView();
    off();
    expect(calls).toBe(0);
  });
});
