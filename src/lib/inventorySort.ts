import type { Design } from './mockData';

// The sort box of the Inventory screen, as one pure function the grid and the table (which gets its page from the grid) share.
//   - Newest First and Oldest First: the design's created_at (`createdAt`). A design with no readable time counts as the oldest.
//   - Design Number: the design number, numbers inside it in number order (R-2 before R-10), upper and lower case alike.
//   - Category: the category name, upper and lower case alike.
//   - Weight (High-Low): the gross weight of the design's pieces added together (skus.gross_weight, spec D7), the figure the card shows as "GW" and the table as "Gross Wt.".
//     It is added in whole milligrams, so that 0.1 g and 0.2 g are exactly 0.3 g and not a hair more. A design with no pieces, or none with a weight, comes last.
// Every tie ends in the design number and then the id, so the order depends on the designs and the choice and on nothing else: not on the order they arrive in, and not on
// the filter, which only takes designs out of it.

export const SORT_OPTIONS = [
  { id: 'sort-newest', label: 'Newest First' },
  { id: 'sort-oldest', label: 'Oldest First' },
  { id: 'sort-design', label: 'Design Number' },
  { id: 'sort-category', label: 'Category' },
  { id: 'sort-weight', label: 'Weight (High–Low)' },
] as const;

export type SortId = (typeof SORT_OPTIONS)[number]['id'];

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** The gross weight of all the pieces of a design, in whole milligrams. */
export function totalGrossMilligrams(design: Design): number {
  return design.skus.reduce((total, sku) => total + Math.round(sku.grossWeight * 1000), 0);
}

/** When the design was made, in milliseconds; an unreadable or empty time is the oldest there is. */
function madeAt(design: Design): number {
  const time = Date.parse(design.createdAt);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

const byNumber = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

/** The last two keys of every order: the design number, then the id. */
function byDesignThenId(a: Design, b: Design): number {
  return (
    collator.compare(a.designNumber, b.designNumber) || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1)
  );
}

/** The designs in the order of the sort box. A new list; the one it was given is not changed. */
export function sortDesigns(designs: Design[], sort: SortId): Design[] {
  const compare = (a: Design, b: Design): number => {
    switch (sort) {
      case 'sort-newest':
        return byNumber(madeAt(b), madeAt(a)) || byDesignThenId(a, b);
      case 'sort-oldest':
        return byNumber(madeAt(a), madeAt(b)) || byDesignThenId(a, b);
      case 'sort-design':
        return byDesignThenId(a, b);
      case 'sort-category':
        return collator.compare(a.category, b.category) || byDesignThenId(a, b);
      case 'sort-weight':
        return byNumber(totalGrossMilligrams(b), totalGrossMilligrams(a)) || byDesignThenId(a, b);
    }
  };
  return [...designs].sort(compare);
}
