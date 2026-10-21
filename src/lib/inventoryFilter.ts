import type { Design, Sku } from './mockData';

// The filter panel of the Inventory screen, as one pure function the grid, the table and the header all use (so they cannot disagree). The panel's ticks, its search box and its
// weight boxes are `InventoryFilter`; where they are kept between the panel and the screens is src/lib/inventoryFilterStore.ts.
//
// The rules:
//   - inside one section the ticks are OR, across sections (and the search and the weight range) they are AND;
//   - material, category and purity are the DESIGN's own (spec D6: they live on the design and only there; D7: a piece has none of its own);
//   - status, location and the weight range are the PIECE's, and ONE piece has to satisfy every one of these that is set: a design with an In Stock piece in the Vault and a Sold
//     piece in the Workshop is not "In Stock in the Workshop". A design with no pieces has no status, no place and no weight, so it is left out as soon as one of them is set;
//   - Sold and Archived are statuses like the others (D8, ten of them): a design whose pieces are all Sold is listed with no filter and under Sold, and not under In Stock;
//   - the search matches the design number, the design name, a piece number or a barcode, in any case, as part of the text;
//   - the weight is the GROSS weight of a piece, the one weight every role may read and the one the list shows ("GW", "Gross Wt."), both ends included. A gross weight of 0 is a
//     weight nobody recorded (O37 allows it), so such a piece matches no range, however wide.

/** The five sections of ticks. Their order is the order of the panel. */
export const FILTER_SECTIONS = ['material', 'category', 'purity', 'status', 'location'] as const;
export type FilterSection = (typeof FILTER_SECTIONS)[number];

export interface InventoryFilter {
  /** The search box, as typed. */
  search: string;
  material: readonly string[];
  category: readonly string[];
  purity: readonly string[];
  status: readonly string[];
  location: readonly string[];
  /** The two weight boxes as typed, in grams: text, so that a half-typed "1." stays in the box. A box that is not a weight is the same as an empty one. */
  weightMin: string;
  weightMax: string;
}

/** Nothing set. The store hands out exactly this object when nothing is set, so a screen can compare by identity. */
export const NO_FILTER: InventoryFilter = {
  search: '',
  material: [],
  category: [],
  purity: [],
  status: [],
  location: [],
  weightMin: '',
  weightMax: '',
};

/** A weight box as a number of grams, or null for an empty box or text that is not a weight (a negative number is not one either). */
function weightBound(text: string): number | null {
  const clean = text.trim();
  if (clean === '') return null;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const searchText = (filter: InventoryFilter): string => filter.search.trim().toLowerCase();

/** How many things are set: every tick, the search as one and the weight range as one. This is the n of "Clear (n)". */
export function countActiveFilters(filter: InventoryFilter): number {
  const ticks = FILTER_SECTIONS.reduce((total, section) => total + filter[section].length, 0);
  const search = searchText(filter) === '' ? 0 : 1;
  const weight =
    weightBound(filter.weightMin) === null && weightBound(filter.weightMax) === null ? 0 : 1;
  return ticks + search + weight;
}

export function isFilterActive(filter: InventoryFilter): boolean {
  return countActiveFilters(filter) > 0;
}

function matchesSearch(design: Design, needle: string): boolean {
  const has = (text: string) => text.toLowerCase().includes(needle);
  return (
    has(design.designNumber) ||
    has(design.designName) ||
    design.skus.some((sku) => has(sku.skuNumber) || has(sku.barcode))
  );
}

/** The designs the filter lets through, in their order. With nothing set it is the list it was given (the same array). */
export function filterDesigns(designs: Design[], filter: InventoryFilter): Design[] {
  if (!isFilterActive(filter)) return designs;

  const needle = searchText(filter);
  const min = weightBound(filter.weightMin);
  const max = weightBound(filter.weightMax);
  const pieceRules =
    filter.status.length > 0 || filter.location.length > 0 || min !== null || max !== null;

  const pieceMatches = (sku: Sku): boolean => {
    if (filter.status.length > 0 && !filter.status.includes(sku.status)) return false;
    if (filter.location.length > 0 && !filter.location.includes(sku.location)) return false;
    if (min !== null || max !== null) {
      if (!(sku.grossWeight > 0)) return false;
      if (min !== null && sku.grossWeight < min) return false;
      if (max !== null && sku.grossWeight > max) return false;
    }
    return true;
  };

  return designs.filter((design) => {
    if (filter.material.length > 0 && !filter.material.includes(design.material)) return false;
    if (filter.category.length > 0 && !filter.category.includes(design.category)) return false;
    if (filter.purity.length > 0 && !filter.purity.includes(design.purity)) return false;
    if (needle !== '' && !matchesSearch(design, needle)) return false;
    if (pieceRules && !design.skus.some(pieceMatches)) return false;
    return true;
  });
}

/** The figures of the header line: the designs, all the pieces of those designs and the pieces in stock. */
export function inventoryStats(designs: Design[]): {
  designs: number;
  skus: number;
  inStock: number;
} {
  let skus = 0;
  let inStock = 0;
  for (const design of designs) {
    skus += design.skus.length;
    inStock += design.skus.filter((sku) => sku.status === 'In Stock').length;
  }
  return { designs: designs.length, skus, inStock };
}

/**
 * The places the panel offers: the shop's own list first, in its order (the setting `locations`), then any place a piece has that the list does not, so that no piece is out of
 * reach of the filter (a role that does not read the setting gets an empty list, and an old piece may sit in a place that was taken off the list).
 */
export function locationOptions(designs: Design[], known: readonly string[]): string[] {
  const options = [...known];
  const seen = new Set(options);
  for (const design of designs) {
    for (const sku of design.skus) {
      if (sku.location !== '' && !seen.has(sku.location)) {
        seen.add(sku.location);
        options.push(sku.location);
      }
    }
  }
  return options;
}
