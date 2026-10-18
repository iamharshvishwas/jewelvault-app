'use client';

import type {
  CreateDesignResponse,
  DesignRow,
  SetSkuStatusResponse,
  SkuRow,
} from '@/lib/api/types';
import { rowCache, savingNotAvailable } from './cache/cache';
import {
  SaveError,
  beginEdits,
  decimalText,
  sameDecimal,
  sendEdits,
  type EditSpec,
  type EditableResource,
} from './cache/edit';
import { sendCreateDesign, sendSkuStatus } from './cache/stock';
import { stampMicros } from './cache/stamp';
import { PHOTO_RULES, photoUrl, uploadPhoto, type PhotoToUpload } from './photos';
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
//     changed, with only the fields that changed and the exact `updated_at` text of the row the person started from (src/lib/cache/edit.ts);
//   - a NEW design (`createDesign`, WEB06, X8) uploads its photos first and then makes one call with the ids and the person's own entries: nothing is shown until the API has
//     answered, with ITS design number, piece numbers and barcodes (L3, C11); a change of status (`setSkuStatus`, WEB06, X9) is one call for the pieces asked, shown the same
//     way. A removal, and the Sold of the billing screen (WEB08), still say they cannot be saved yet and change nothing;
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

/**
 * The pictures of a design from the photo ids it holds (P4): the gallery gets the full pictures, a list the 320 px thumbnail of the primary photo, all on the API's origin. The
 * primary photo comes first. A design with no photo shows the placeholder.
 */
function photosOf(row: DesignRow): Pick<Design, 'images' | 'thumbs' | 'primaryImage'> {
  const ids = Array.isArray(row.photo_ids) ? row.photo_ids : [];
  if (ids.length === 0) return { images: [NO_IMAGE], thumbs: [NO_IMAGE], primaryImage: NO_IMAGE };
  const primary =
    row.primary_photo_id && ids.includes(row.primary_photo_id) ? row.primary_photo_id : ids[0];
  const ordered = [primary, ...ids.filter((id) => id !== primary)];
  return {
    images: ordered.map((id) => photoUrl(id, 'full')),
    thumbs: ordered.map((id) => photoUrl(id, 'thumb')),
    primaryImage: photoUrl(primary, 'thumb'),
  };
}

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
      ...photosOf(row),
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

// ── a new design (WEB06, X8) ─────────────────────────────────────────────────────────────────────

/** What the person typed for one group of identical pieces on the Add Design screen: text as typed, `pieces` as a whole number. */
export interface PieceGroupInput {
  pieces: number;
  grossWeight: string;
  /** The owner's own weight (D9). Only the owner's screen has the field; the API refuses it from anybody else. */
  originalNetWeight: string;
  customerNetWeight: string;
  stones: string;
  stoneWeight: string;
  kundan: string;
  kundanWeight: string;
  piroi: string;
  retailLabour: string;
  semiWholesaleLabour: string;
  wholesaleLabour: string;
  notes: string;
}

export interface NewDesignInput {
  /** Made by the page before the first upload (P2): the photos are stored under it. */
  designId: string;
  designName: string;
  category: string;
  subcategory: string;
  material: string;
  purity: string;
  sellingMethod: string;
  description: string;
  tags: string[];
  notes: string;
  /** In the order they are attached. Each was given its id by the page. */
  photos: PhotoToUpload[];
  primaryPhotoId: string | null;
  groups: PieceGroupInput[];
}

/** What the API made, for the screen to show: ITS numbers (L3, C11). */
export interface CreatedDesign {
  designId: string;
  designNumber: string;
  pieces: Array<{ id: string; skuNumber: string; barcode: string }>;
}

const MAX_PIECES_PER_GROUP = 100;
const MAX_PIECES_PER_CALL = 500;

const refused = (message: string) => new SaveError(new Error(message));

/** A blank is absent; otherwise plain decimal text with the scale of the column. A number with more decimals than the column has is refused, never rounded (S3). */
function decimalField(text: string, scale: number, label: string): string | undefined {
  const clean = text.trim();
  if (clean === '') return undefined;
  const match = /^(\d*)(?:\.(\d+))?$/.exec(clean);
  if (!match || (match[1] === '' && match[2] === undefined))
    throw refused(`${label} must be a number such as 12.5. Nothing was changed.`);
  const fraction = match[2] ?? '';
  if (fraction.length > scale)
    throw refused(`${label} can have at most ${scale} decimals. Nothing was changed.`);
  return `${match[1] || '0'}.${fraction.padEnd(scale, '0')}`;
}

function countField(text: string, label: string): number | undefined {
  const clean = text.trim();
  if (clean === '') return undefined;
  if (!/^\d+$/.test(clean)) throw refused(`${label} must be a whole number. Nothing was changed.`);
  return Number(clean);
}

/** One group of the screen as the API takes it (X8 `pieces[]`): only what was typed, so a blank rate is absent and the API fills it (R1). */
function pieceGroupBody(
  group: PieceGroupInput,
  at: number,
  rateWord: string
): Record<string, unknown> {
  const where = `Group ${at + 1}, `;
  if (!Number.isInteger(group.pieces) || group.pieces < 1)
    throw refused(
      `${where}pieces must be a whole number from 1 to ${MAX_PIECES_PER_GROUP}. Nothing was changed.`
    );
  if (group.pieces > MAX_PIECES_PER_GROUP)
    throw refused(`${where}pieces can be at most ${MAX_PIECES_PER_GROUP}. Nothing was changed.`);
  const body: Record<string, unknown> = { pieces: group.pieces };
  const set = (name: string, value: unknown) => {
    if (value !== undefined) body[name] = value;
  };
  set('gross_weight', decimalField(group.grossWeight, 3, `${where}gross weight`));
  set(
    'original_net_weight',
    decimalField(group.originalNetWeight, 3, `${where}original net weight`)
  );
  set(
    'customer_net_weight',
    decimalField(group.customerNetWeight, 3, `${where}customer net weight`)
  );
  set('stones', countField(group.stones, `${where}stones`));
  set('stone_weight', decimalField(group.stoneWeight, 3, `${where}stone weight`));
  set('kundan', countField(group.kundan, `${where}kundan`));
  set('kundan_weight', decimalField(group.kundanWeight, 3, `${where}kundan weight`));
  set('piroi', decimalField(group.piroi, 2, `${where}piroi`));
  set('labour_retail', decimalField(group.retailLabour, 2, `${where}retail ${rateWord}`));
  set(
    'labour_semi',
    decimalField(group.semiWholesaleLabour, 2, `${where}semi-wholesale ${rateWord}`)
  );
  set('labour_wholesale', decimalField(group.wholesaleLabour, 2, `${where}wholesale ${rateWord}`));
  const notes = group.notes.trim();
  if (notes !== '') body.notes = notes;
  return body;
}

/**
 * The body of X8 from what the person typed. It holds the ids the page made (the design's and its photos'), the entries, and nothing the API makes: no design number, piece
 * number, barcode, status, location, stamp or person (L3, C11); no image text, only photo ids (P4). Throws a SaveError for text that is not a number, before any call.
 */
export function createDesignBody(input: NewDesignInput): Record<string, unknown> {
  if (input.groups.length === 0) throw refused('Add at least one piece. Nothing was changed.');
  if (input.photos.length > PHOTO_RULES.maxPerDesign)
    throw refused(
      `A design can have at most ${PHOTO_RULES.maxPerDesign} photos. Nothing was changed.`
    );
  const total = input.groups.reduce((sum, group) => sum + group.pieces, 0);
  if (total > MAX_PIECES_PER_CALL)
    throw refused(
      `At most ${MAX_PIECES_PER_CALL} pieces can be made at once. Nothing was changed.`
    );
  const rateWord = input.sellingMethod === 'Per Piece' ? 'rate' : 'labour';
  const pieces = input.groups.map((group, at) => pieceGroupBody(group, at, rateWord));

  const design: Record<string, unknown> = {
    category_id: categoryIdOf(input.category),
    material: input.material,
    purity: input.purity.trim(),
    selling_method: input.sellingMethod,
  };
  const subcategory = subcategoryIdOf(input.category, input.subcategory);
  if (subcategory !== null) design.subcategory_id = subcategory;
  const name = trimmedOrNull(input.designName);
  if (name !== null) design.name = name;
  const description = trimmedOrNull(input.description);
  if (description !== null) design.description = description;
  const notes = trimmedOrNull(input.notes);
  if (notes !== null) design.notes = notes;
  if (input.tags.length > 0) design.tags = input.tags;
  if (input.photos.length > 0) {
    design.photo_ids = input.photos.map((photo) => photo.photoId);
    design.primary_photo_id = input.primaryPhotoId ?? input.photos[0].photoId;
  }
  return { design_id: input.designId, design, pieces };
}

/**
 * Makes a design with its pieces (X8). The photos go up first, one after another (the full picture, then the thumbnail, under the design's id: P2); a photo already stored for
 * this design id is not sent again, so a second Save sends only what is missing. Then ONE call carries the ids and the entries with an Idempotency-Key. Nothing is shown until
 * the API has answered; then its design, pieces and (for the owner) their weights go into memory. `idempotencyKey` is the key of an earlier try of the SAME save that could not
 * be confirmed (`ApiError.idempotencyKey`): the answer that was lost comes back, and one design is made. Throws a SaveError.
 */
export async function createDesign(
  input: NewDesignInput,
  options: { idempotencyKey?: string; onProgress?: (message: string) => void } = {}
): Promise<CreatedDesign> {
  if (PREVIEW_MODE) throw savingNotAvailable('A new design');
  const body = createDesignBody(input); // everything that can be refused is refused before anything goes out
  const session = rowCache.generation();
  for (const [at, photo] of input.photos.entries()) {
    options.onProgress?.(`Uploading photo ${at + 1} of ${input.photos.length}…`);
    try {
      await uploadPhoto(input.designId, photo);
    } catch (error) {
      throw new SaveError(error, { label: input.photos.length > 1 ? `Photo ${at + 1}` : null });
    }
  }
  options.onProgress?.('Saving the design…');
  const answer: CreateDesignResponse = await sendCreateDesign(body, options.idempotencyKey);
  if (rowCache.generation() === session) {
    rowCache.merge('designs', [answer.design]);
    rowCache.merge('skus', answer.skus);
    if (answer.sku_private && answer.sku_private.length > 0)
      rowCache.merge('sku-private', answer.sku_private);
  }
  return {
    designId: answer.design.id,
    designNumber: answer.design.design_no,
    pieces: answer.skus.map((sku) => ({ id: sku.id, skuNumber: sku.sku_no, barcode: sku.barcode })),
  };
}

const DESIGN_FIELD_LABEL: Readonly<Record<string, string>> = {
  gross_weight: 'gross weight',
  original_net_weight: 'original net weight',
  customer_net_weight: 'customer net weight',
  stones: 'stones',
  stone_weight: 'stone weight',
  kundan: 'kundan',
  kundan_weight: 'kundan weight',
  piroi: 'piroi',
  labour_retail: 'retail labour or rate',
  labour_semi: 'semi-wholesale labour or rate',
  labour_wholesale: 'wholesale labour or rate',
  pieces: 'pieces',
  notes: 'remarks',
};

/** The words for a design that could not be saved (C13): the API's own sentence with its field names turned into the names the screen shows, and a plain line for the two refusals that need one. */
export function designSaveMessage(error: unknown): string {
  if (!(error instanceof SaveError))
    return error instanceof Error ? error.message : 'Unable to save this design.';
  if (error.field === 'design_id')
    return 'This design was already saved. Look for it in the inventory. Nothing more was changed.';
  if (error.code === 'JV_FORBIDDEN' && error.field?.endsWith('original_net_weight'))
    return 'Only the owner can enter the original net weight. Nothing was changed.';
  if (error.field === 'design.photo_ids')
    return 'The photos could not be attached to the design. Remove them, add them again and save. Nothing was changed.';
  return error.message
    .replace(
      /pieces\[(\d+)\]\.([a-z_]+)/g,
      (_all, at: string, name: string) =>
        `Group ${Number(at) + 1}, ${DESIGN_FIELD_LABEL[name] ?? name}`
    )
    .replace(
      /\bdesign\.(name|category_id|subcategory_id|selling_method|purity|material|description|notes|tags)\b/g,
      (_all, name: string) => name.replace(/_id$/, '').replace(/_/g, ' ')
    );
}

// ── a change of status (WEB06, X9) ───────────────────────────────────────────────────────────────

/**
 * Sets the status of pieces (X9): one call for the pieces asked, any status except Sold (a piece becomes Sold when a bill is saved, WEB08). Nothing is shown before the API has
 * answered, because it can refuse (a Sold piece cannot be changed, and nothing in the call is then); then the rows it returned, with their new stamps, go into memory. Archived
 * sets `archived_at` and leaving Archived clears it, on the API's side (D8). `idempotencyKey` is the key of an earlier try of the same change that could not be confirmed.
 * Resolves with the rows. Throws a SaveError.
 */
export async function setSkuStatus(
  skuIds: readonly string[],
  status: SkuStatus,
  options: { note?: string; idempotencyKey?: string } = {}
): Promise<SkuRow[]> {
  if (PREVIEW_MODE) throw savingNotAvailable('A change of status');
  if (status === 'Sold')
    throw refused('A piece becomes Sold when a bill is saved, not here. Nothing was changed.');
  if (skuIds.length === 0) throw refused('No piece was chosen. Nothing was changed.');
  if (skuIds.length > MAX_PIECES_PER_CALL)
    throw refused(
      `At most ${MAX_PIECES_PER_CALL} pieces can be changed at once. Nothing was changed.`
    );
  const session = rowCache.generation();
  const note = options.note?.trim();
  const answer: SetSkuStatusResponse = await sendSkuStatus(
    { sku_ids: [...skuIds], status, ...(note ? { note } : {}) },
    options.idempotencyKey
  );
  if (rowCache.generation() === session) rowCache.merge('skus', answer.skus);
  return answer.skus;
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
