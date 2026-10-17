'use client';

import type { DesignRow, SkuRow } from '@/lib/api/types';
import { rowCache, savingNotAvailable } from './cache/cache';
import {
  beginEdits,
  decimalText,
  sameDecimal,
  sendEdits,
  type EditSpec,
  type EditableResource,
} from './cache/edit';
import { stampMicros } from './cache/stamp';
import {
  MOCK_DESIGNS,
  type Design,
  type Material,
  type Purity,
  type SellingMethod,
  type Sku,
  type SkuStatus,
} from './mockData';
import { PREVIEW_MODE } from './previewMode';

// The design store keeps its names and its synchronous reads. Where the data comes from, and where a change goes:
//   - in a real build (spec C2, C8, C9) the designs and their pieces are made from the rows the hydrate put in memory (src/lib/cache): `getDesigns()` answers
//     from memory after the loading gate, the list is the same array until a row it is made of changes, and nothing is read from or written to browser storage.
//     Before the gate has opened, or after a logout, memory is empty and so is the list: there is never sample data (D20);
//   - the ordinary edit of a design and its pieces (`upsertDesign`, WEB05, C5 (a)) is shown in memory at once and written to the API: one write for each row that
//     changed, with only the fields that changed and the exact `updated_at` text of the row the person started from (src/lib/cache/edit.ts). A new design, a change of
//     status and a removal are the functions of WEB06 (X8, X9): until then those say they cannot be saved yet and change nothing;
//   - in a preview build (src/lib/previewMode.ts, until WEB15) the store is the prototype's: sample data, in this page only. Nothing is kept in browser storage in either.
// The shapes are the prototype's (src/lib/mockData.ts): weights and amounts are numbers made from the API's text, for display; money is never worked out from them.

/** The prototype's sample designs, with the three labour rates and no picture that only existed in one browser. A preview shows these; a real build never does. */
function normalizeLabourRates(designs: Design[]): Design[] {
  return designs.map((design) => {
    const images = design.images.filter((image) => !image.startsWith('blob:'));
    const primaryImage = design.primaryImage.startsWith('blob:')
      ? images[0] || '/assets/images/no_image.png'
      : design.primaryImage;

    const skus = design.skus.map((sku) => {
      let nextSku = sku;
      if (sku.sellingMethod === 'By Weight' && sku.labour > 5000 && sku.customerNetWeight > 0) {
        nextSku = { ...sku, labour: Math.round((sku.labour / sku.customerNetWeight) * 100) / 100 };
      }
      if (
        nextSku.retailLabour === undefined ||
        nextSku.semiWholesaleLabour === undefined ||
        nextSku.wholesaleLabour === undefined
      ) {
        const retail = nextSku.retailLabour ?? nextSku.labour;
        const wholesale = nextSku.wholesaleLabour ?? nextSku.labour;
        nextSku = {
          ...nextSku,
          retailLabour: retail,
          semiWholesaleLabour:
            nextSku.semiWholesaleLabour ?? Math.round(((retail + wholesale) / 2) * 100) / 100,
          wholesaleLabour: wholesale,
        };
      }
      return nextSku;
    });
    const firstSkuRate = skus.find((sku) => sku.labour > 0)?.labour || design.labour;
    const labour =
      design.sellingMethod === 'By Weight' && design.labour > 5000 ? firstSkuRate : design.labour;
    const retail = design.retailLabour ?? labour;
    const wholesale = design.wholesaleLabour ?? labour;
    return {
      ...design,
      images,
      primaryImage,
      labour,
      retailLabour: retail,
      semiWholesaleLabour:
        design.semiWholesaleLabour ?? Math.round(((retail + wholesale) / 2) * 100) / 100,
      wholesaleLabour: wholesale,
      skus,
    };
  });
}

// the preview's own sample data, in this page only; a real build keeps its designs in the cache
let _designs: Design[] = PREVIEW_MODE ? normalizeLabourRates([...MOCK_DESIGNS]) : [];

function assertUniqueDesign(design: Design, existingDesigns: Design[]) {
  if (existingDesigns.some((d) => d.id !== design.id && d.designNumber === design.designNumber)) {
    throw new Error(`Design Number already exists: ${design.designNumber}`);
  }

  const usedSkus = new Set<string>();
  const usedBarcodes = new Set<string>();
  for (const existing of existingDesigns) {
    if (existing.id === design.id) continue;
    for (const sku of existing.skus) {
      usedSkus.add(sku.skuNumber);
      usedBarcodes.add(sku.barcode);
    }
  }

  for (const sku of design.skus) {
    if (usedSkus.has(sku.skuNumber)) throw new Error(`SKU already exists: ${sku.skuNumber}`);
    if (usedBarcodes.has(sku.barcode)) throw new Error(`Barcode already exists: ${sku.barcode}`);
  }
}

// ── the designs made from memory (a real build) ───────────────────────────────

const NO_IMAGE = '/assets/images/no_image.png';
/** What the view is made from: when one of these resources changes, the view is made again. */
const VIEW_RESOURCES = [
  'designs',
  'skus',
  'categories',
  'subcategories',
  'users',
  'sku-private',
] as const;

interface StockView {
  designs: Design[];
  /** Lower-case piece number or barcode to the piece and its design. */
  byCode: Map<string, { design: Design; sku: Sku }>;
}

let cachedView: { version: string; value: StockView } | null = null;

/**
 * The exact `updated_at` text of the row each design and each piece of the view was made from. A screen that edits a design keeps the view it started from and its own copy of
 * it; the stamp of the START is what the write sends (A5), whatever a poll has brought into memory meanwhile. It is kept beside the objects and not in them, so the shapes of
 * the prototype stay what they were and a copy made with structuredClone carries nothing it should not.
 */
const revisions = new WeakMap<object, string>();

const toNumber = (text: string | null | undefined): number => {
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
};
/** The stamp as the millisecond ISO text the screens' `new Date(...)` reads everywhere; the exact text stays in the cache. */
const toIso = (stamp: string): string =>
  /^.{19}\.\d{6}Z$/.test(stamp) ? `${stamp.slice(0, 23)}Z` : stamp;
const stampOrZero = (stamp: string): number => {
  try {
    return stampMicros(stamp);
  } catch {
    return 0;
  }
};

function makeSku(
  row: SkuRow,
  design: DesignRow,
  category: string,
  subcategory: string,
  people: Map<string, string>,
  original: Map<string, number>
): Sku {
  const retail = toNumber(row.labour_retail);
  const sku: Sku = {
    id: row.id,
    skuNumber: row.sku_no,
    designId: row.design_id,
    designNumber: design.design_no,
    grossWeight: toNumber(row.gross_weight),
    // the owner's weight comes from sku-private, which only the owner reads; for everybody else it is 0 and the screens show a dash
    originalNetWeight: original.get(row.id) ?? 0,
    customerNetWeight: toNumber(row.customer_net_weight),
    stones: row.stones,
    stoneWeight: toNumber(row.stone_weight),
    kundan: row.kundan,
    kundanWeight: toNumber(row.kundan_weight),
    piroi: toNumber(row.piroi),
    labour: retail,
    retailLabour: retail,
    semiWholesaleLabour: toNumber(row.labour_semi),
    wholesaleLabour: toNumber(row.labour_wholesale),
    status: row.status,
    location: row.location ?? '',
    barcode: row.barcode,
    createdAt: toIso(row.created_at),
    createdBy: (row.created_by && people.get(row.created_by)) || '',
    notes: row.notes ?? '',
    sellingMethod: design.selling_method as SellingMethod,
    purity: design.purity as Purity,
    material: design.material as Material,
    category,
    subcategory,
  };
  revisions.set(sku, row.updated_at);
  return sku;
}

function buildView(): StockView {
  const categories = new Map(rowCache.rows('categories').map((c) => [c.id, c.name]));
  const subcategories = new Map(rowCache.rows('subcategories').map((s) => [s.id, s.name]));
  const people = new Map(rowCache.rows('users').map((u) => [u.id, u.full_name]));
  const original = new Map(
    rowCache.rows('sku-private').map((p) => [p.sku_id, toNumber(p.original_net_weight)])
  );
  const piecesOf = new Map<string, SkuRow[]>();
  for (const sku of rowCache.rows('skus')) {
    const list = piecesOf.get(sku.design_id);
    if (list) list.push(sku);
    else piecesOf.set(sku.design_id, [sku]);
  }

  const made = rowCache.rows('designs').map((row) => {
    const category = categories.get(row.category_id) ?? '';
    const subcategory = (row.subcategory_id && subcategories.get(row.subcategory_id)) || '';
    const skus = (piecesOf.get(row.id) ?? [])
      .slice()
      .sort((a, b) => a.sku_no.localeCompare(b.sku_no))
      .map((sku) => makeSku(sku, row, category, subcategory, people, original));
    // a design has no rate of its own on the API: the screens that show one take the first piece's, as the prototype's store did
    const first = skus.find((sku) => sku.labour > 0) ?? skus[0];
    const design: Design = {
      id: row.id,
      designNumber: row.design_no,
      designName: row.name ?? '',
      category,
      subcategory,
      material: row.material as Material,
      purity: row.purity as Purity,
      sellingMethod: row.selling_method as SellingMethod,
      description: row.description ?? '',
      notes: row.notes ?? '',
      tags: Array.isArray(row.tags) ? row.tags : [],
      // photos are WEB06's: until then every design shows the placeholder image
      images: [NO_IMAGE],
      primaryImage: NO_IMAGE,
      skus,
      createdAt: toIso(row.created_at),
      createdBy: (row.created_by && people.get(row.created_by)) || '',
      labour: first?.labour ?? 0,
      retailLabour: first?.retailLabour ?? 0,
      semiWholesaleLabour: first?.semiWholesaleLabour ?? 0,
      wholesaleLabour: first?.wholesaleLabour ?? 0,
      piroi: first?.piroi ?? 0,
    };
    revisions.set(design, row.updated_at);
    return { design, created: stampOrZero(row.created_at) };
  });
  // the newest first: the prototype put a new design at the front of its list
  made.sort(
    (a, b) =>
      b.created - a.created ||
      a.design.designNumber.localeCompare(b.design.designNumber) ||
      a.design.id.localeCompare(b.design.id)
  );
  const designs = made.map((m) => m.design);

  const byCode = new Map<string, { design: Design; sku: Sku }>();
  for (const design of designs) {
    for (const sku of design.skus) {
      for (const code of [sku.skuNumber, sku.barcode]) {
        const key = code.toLowerCase();
        if (!byCode.has(key)) byCode.set(key, { design, sku });
      }
    }
  }
  return { designs, byCode };
}

function currentView(): StockView {
  const version = rowCache.versionOf(...VIEW_RESOURCES);
  if (cachedView && cachedView.version === version) return cachedView.value;
  const value = buildView();
  cachedView = { version, value };
  return value;
}

/** A real build cannot save a change to the stock yet: say so, change nothing. A preview changes its own sample data. */
function assertWritable(what: string): void {
  if (!PREVIEW_MODE) throw savingNotAvailable(what);
}

export function getDesigns(): Design[] {
  return PREVIEW_MODE ? _designs : currentView().designs;
}

export function addDesign(design: Design): void {
  assertWritable('A new design');
  assertUniqueDesign(design, _designs);
  _designs = [design, ..._designs];
}

// ── the ordinary edit of a design and its pieces (WEB05, C5 (a)) ─────────────────────────────────

const trimmedOrNull = (text: string | null | undefined): string | null => {
  const clean = (text ?? '').trim();
  return clean === '' ? null : clean;
};

/** Sets `field` when the number was changed. The text keeps every decimal the person typed; the API refuses a number with more than the column holds (nothing is rounded here). */
function setDecimal(
  changes: Record<string, unknown>,
  field: string,
  from: number,
  to: number,
  decimals: number
): void {
  const wanted = decimalText(to, decimals);
  if (!sameDecimal(decimalText(from, decimals), wanted)) changes[field] = wanted;
}

function categoryIdOf(name: string): string {
  const row = rowCache.rows('categories').find((category) => category.name === name);
  if (!row) throw new Error(`"${name}" is not a category.`);
  return row.id;
}

function subcategoryIdOf(categoryName: string, name: string): string | null {
  if (name === '') return null;
  const categoryId = categoryIdOf(categoryName);
  const row = rowCache
    .rows('subcategories')
    .find((sub) => sub.category_id === categoryId && sub.name === name);
  if (!row) throw new Error(`"${name}" is not a sub-category of ${categoryName}.`);
  return row.id;
}

/** The fields of a design (not of its pieces) that the person changed, as the API takes them. */
function designChanges(from: Design, to: Design): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  const name = trimmedOrNull(to.designName);
  if (name !== trimmedOrNull(from.designName)) changes.name = name;
  if (to.category !== from.category || to.subcategory !== from.subcategory) {
    const category = categoryIdOf(to.category);
    const subcategory = subcategoryIdOf(to.category, to.subcategory);
    if (category !== categoryIdOf(from.category)) changes.category_id = category;
    let wasSubcategory: string | null = null;
    try {
      wasSubcategory = subcategoryIdOf(from.category, from.subcategory);
    } catch {
      // a design whose sub-category is not one of its category's (an import may have made one): any choice now is a change
      wasSubcategory = null;
    }
    if (subcategory !== wasSubcategory) changes.subcategory_id = subcategory;
  }
  if (to.material !== from.material) changes.material = to.material;
  if (to.purity !== from.purity) changes.purity = to.purity;
  if (to.sellingMethod !== from.sellingMethod) changes.selling_method = to.sellingMethod;
  const description = trimmedOrNull(to.description);
  if (description !== trimmedOrNull(from.description)) changes.description = description;
  const notes = trimmedOrNull(to.notes);
  if (notes !== trimmedOrNull(from.notes)) changes.notes = notes;
  if (JSON.stringify(to.tags) !== JSON.stringify(from.tags)) changes.tags = to.tags;
  return changes;
}

/** The fields of one piece that the person changed. The status and the owner's weight are not ordinary edits: asking for one is refused before any call. */
function skuChanges(from: Sku, to: Sku): Record<string, unknown> {
  if (to.status !== from.status)
    throw new Error(
      `${to.skuNumber}: a change of status is not saved with the other details. It has its own step.`
    );
  if (to.originalNetWeight !== from.originalNetWeight)
    throw new Error(
      `${to.skuNumber}: the original net weight cannot be changed here. It is entered when the piece is created.`
    );
  const changes: Record<string, unknown> = {};
  setDecimal(changes, 'gross_weight', from.grossWeight, to.grossWeight, 3);
  setDecimal(changes, 'customer_net_weight', from.customerNetWeight, to.customerNetWeight, 3);
  if (to.stones !== from.stones) changes.stones = to.stones;
  setDecimal(changes, 'stone_weight', from.stoneWeight, to.stoneWeight, 3);
  if (to.kundan !== from.kundan) changes.kundan = to.kundan;
  setDecimal(changes, 'kundan_weight', from.kundanWeight, to.kundanWeight, 3);
  setDecimal(changes, 'piroi', from.piroi, to.piroi, 2);
  setDecimal(
    changes,
    'labour_retail',
    from.retailLabour ?? from.labour,
    to.retailLabour ?? to.labour,
    2
  );
  setDecimal(
    changes,
    'labour_semi',
    from.semiWholesaleLabour ?? from.retailLabour ?? from.labour,
    to.semiWholesaleLabour ?? to.retailLabour ?? to.labour,
    2
  );
  setDecimal(
    changes,
    'labour_wholesale',
    from.wholesaleLabour ?? from.labour,
    to.wholesaleLabour ?? to.labour,
    2
  );
  const location = trimmedOrNull(to.location);
  if (location !== trimmedOrNull(from.location)) changes.location = location;
  const notes = trimmedOrNull(to.notes);
  if (notes !== trimmedOrNull(from.notes)) changes.notes = notes;
  return changes;
}

/** The stamp of the row a design or a piece of the view was made from; for an object that is not one of the view's, the row in memory now. */
function stampOf(object: object, resource: EditableResource, id: string): string {
  const known = revisions.get(object);
  if (known) return known;
  const row = rowCache.get(resource as 'designs' | 'skus', id) as
    | { updated_at: string }
    | undefined;
  if (!row) throw new Error('That record is not loaded.');
  return row.updated_at;
}

/**
 * Saves the changes of a design and its pieces (C5 (a)). `base` is the design as the person started from it (a design of `getDesigns()`), `design` is their copy with
 * the changes. Memory shows every changed row at once; then one write for each row that changed goes out, the design first and the pieces in order, each with only its
 * changed fields and the exact stamp of the row at `base`. So a row that somebody else saved meanwhile is answered stale and reloaded, never overwritten. The first failure
 * stops the rest (they are rolled back); the rows already written stay saved. Resolves with how many rows were written; throws a SaveError (src/lib/cache/edit.ts).
 */
export async function upsertDesign(design: Design, base?: Design): Promise<number> {
  if (PREVIEW_MODE) {
    assertUniqueDesign(design, _designs);
    const exists = _designs.some((d) => d.id === design.id);
    _designs = exists
      ? _designs.map((d) => (d.id === design.id ? design : d))
      : [design, ..._designs];
    return 1;
  }
  const from = base ?? currentView().designs.find((d) => d.id === design.id);
  if (!from) throw new Error('That design is not in stock.');
  // everything that can be refused is refused before anything is shown or sent
  const specs: Array<EditSpec<EditableResource>> = [];
  const changes = designChanges(from, design);
  if (Object.keys(changes).length > 0)
    specs.push({
      resource: 'designs',
      id: from.id,
      changes,
      expectedUpdatedAt: stampOf(from, 'designs', from.id),
      label: from.designNumber,
    });
  for (const sku of design.skus) {
    const was = from.skus.find((item) => item.id === sku.id);
    if (!was) throw new Error(`${sku.skuNumber} is not a piece of this design.`);
    const pieceChanges = skuChanges(was, sku);
    if (Object.keys(pieceChanges).length > 0)
      specs.push({
        resource: 'skus',
        id: sku.id,
        changes: pieceChanges,
        expectedUpdatedAt: stampOf(was, 'skus', sku.id),
        label: was.skuNumber,
      });
  }
  return sendEdits(beginEdits(specs));
}

export function removeDesign(id: string): void {
  assertWritable('Removing a design');
  _designs = _designs.filter((d) => d.id !== id);
}

export function removeDesigns(ids: Set<string>): void {
  assertWritable('Removing designs');
  _designs = _designs.filter((d) => !ids.has(d.id));
}

export function clearInventory(): void {
  assertWritable('Clearing the inventory');
  _designs = [];
}

export function removeSku(skuId: string): { removed: boolean; removedDesignId?: string } {
  assertWritable('Removing a piece');
  let removed = false;
  let removedDesignId: string | undefined;

  _designs = _designs
    .map((design) => {
      const skus = design.skus.filter((sku) => sku.id !== skuId);
      if (skus.length !== design.skus.length) {
        removed = true;
        if (skus.length === 0) removedDesignId = design.id;
        return { ...design, skus };
      }
      return design;
    })
    .filter((design) => design.skus.length > 0);

  return { removed, removedDesignId };
}

export function findSkuByCode(code: string) {
  const normalized = code.trim().toLowerCase();
  if (!PREVIEW_MODE) return currentView().byCode.get(normalized) ?? null;
  for (const design of _designs) {
    const sku = design.skus.find(
      (s) => s.skuNumber.toLowerCase() === normalized || s.barcode.toLowerCase() === normalized
    );
    if (sku) return { design, sku };
  }
  return null;
}

export function updateSkuStatus(skuId: string, status: SkuStatus): void {
  assertWritable('A change of status');
  let changed = false;
  _designs = _designs.map((design) => {
    const skus = design.skus.map((sku) => {
      if (sku.id !== skuId) return sku;
      changed = true;
      return { ...sku, status };
    });
    return changed ? { ...design, skus } : design;
  });
}

/** What a screen shows where a number will be, until the server has made it (L3, C11). */
export const NUMBER_ASSIGNED_WHEN_SAVED = 'Number assigned when saved';

/**
 * The design number a screen shows before the design is saved. A real build does not know it: the number is made by the database in the same transaction that creates the
 * design (L3), and the cache never makes up a number (C11), so the screen says that it will be assigned when saved. A preview has no database and counts in its sample data.
 */
export function reserveNextDesignNumber(category: string, prefix: string): string {
  if (!PREVIEW_MODE) return NUMBER_ASSIGNED_WHEN_SAVED;
  const used = _designs
    .filter((d) => d.category === category && d.designNumber.startsWith(`${prefix}-`))
    .map((d) => Number(d.designNumber.split('-').at(-1)))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(0, ...used) + 1;
  return `${prefix}-${String(next).padStart(5, '0')}`;
}

export function resetLocalDesignData(): void {
  assertWritable('Resetting the stock');
  _designs = [...MOCK_DESIGNS];
}
