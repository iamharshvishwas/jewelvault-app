// FB-D2 (Siddhi #6): the rows of the ready-stock catalogue. A pure function over the designs the design store holds (src/lib/designStore.ts), so the screen and the tests read the same thing:
// the designs that have at least one piece In Stock, in the chosen categories, sorted by category and then by design number.
//
// A row is what a customer may be shown on paper and no more: the design, its first photo, the purity, how many pieces are In Stock and the range of their GROSS weights (whole milligrams read
// exactly from the weights the store holds, the pieces of the other statuses leave the range alone). A row has no key for the owner's original weight (`originalNetWeight` of a piece), none for the customer's net weight and none for any
// price, labour or rate: the keys are listed, so a field added to a piece does not reach the paper by itself.
import type { Design } from './mockData';
import { parseGrams } from './pricing';

export interface CatalogueRow {
  designNumber: string;
  designName: string;
  category: string;
  purity: string;
  /** The first photo of the design (the primary one), or null when the design has none. */
  photoId: string | null;
  /** How many of its pieces are In Stock. */
  inStock: number;
  /** The lightest and the heaviest gross weight among the pieces In Stock, in whole milligrams. */
  grossMinMg: number;
  grossMaxMg: number;
}

const PHOTO_ADDRESS =
  /\/v1\/photos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:full|thumb)$/i;

/** The id of the first photo of a design: the design store makes its pictures from the photo ids (primary first) on the API's address; the placeholder has none. */
function firstPhotoId(design: Pick<Design, 'images'>): string | null {
  const first = design.images[0];
  return (typeof first === 'string' && PHOTO_ADDRESS.exec(first)?.[1]) || null;
}

const before = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The designs with at least one piece In Stock in the chosen categories (none chosen: no rows), sorted by category and then by design number. */
export function catalogueRows(
  designs: readonly Design[],
  categories: readonly string[]
): CatalogueRow[] {
  const chosen = new Set(categories);
  const rows: CatalogueRow[] = [];
  for (const design of designs) {
    if (!chosen.has(design.category)) continue;
    const weights = design.skus
      .filter((sku) => sku.status === 'In Stock')
      // the store holds the API's text as a number: `parseGrams` reads it back digit by digit (no arithmetic on the float), and refuses noise such as 0.1 + 0.2 instead of rounding it
      .map((sku) => parseGrams(sku.grossWeight, { field: `the gross weight of ${sku.skuNumber}` }));
    if (weights.length === 0) continue;
    rows.push({
      designNumber: design.designNumber,
      designName: design.designName,
      category: design.category,
      purity: design.purity,
      photoId: firstPhotoId(design),
      inStock: weights.length,
      grossMinMg: Math.min(...weights),
      grossMaxMg: Math.max(...weights),
    });
  }
  return rows.sort(
    (a, b) => before(a.category, b.category) || before(a.designNumber, b.designNumber)
  );
}
