'use client';

import type { DesignRow, SkuRow } from '@/lib/api/types';
import { rowCache, savingNotAvailable } from './cache/cache';
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

// The design store keeps its names and its synchronous reads. Task WEB03 changes where the data comes from:
//   - in a real build (spec C2, C8, C9) the designs and their pieces are made from the rows the hydrate put in memory (src/lib/cache): `getDesigns()` answers
//     from memory after the loading gate, the list is the same array until a row it is made of changes, and nothing is read from or written to browser storage.
//     Before the gate has opened, or after a logout, memory is empty and so is the list: there is never sample data (D20). A change cannot be saved yet (WEB05, WEB06
//     and WEB08 put each kind of save on the API), so every writing function says so and changes nothing, rather than show a change that is not saved;
//   - in a preview build (src/lib/previewMode.ts, until WEB15) the store is the prototype's: sample data, kept in this browser only.
// The shapes are the prototype's (src/lib/mockData.ts): weights and amounts are numbers made from the API's text, for display; money is never worked out from them.

const STORAGE_KEY = 'jaishri.designs.v1';

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readInitialDesigns(): Design[] {
  if (!canUseStorage()) return normalizeLabourRates([...MOCK_DESIGNS]);
  const saved = window.localStorage.getItem(STORAGE_KEY);
  if (!saved) return normalizeLabourRates([...MOCK_DESIGNS]);
  try {
    const parsed = JSON.parse(saved) as Design[];
    return normalizeLabourRates(Array.isArray(parsed) ? parsed : [...MOCK_DESIGNS]);
  } catch {
    return normalizeLabourRates([...MOCK_DESIGNS]);
  }
}

function normalizeLabourRates(designs: Design[]): Design[] {
  let changed = false;
  const normalized = designs.map((design) => {
    const images = design.images.filter((image) => !image.startsWith('blob:'));
    const primaryImage = design.primaryImage.startsWith('blob:')
      ? images[0] || '/assets/images/no_image.png'
      : design.primaryImage;
    if (images.length !== design.images.length || primaryImage !== design.primaryImage)
      changed = true;

    const skus = design.skus.map((sku) => {
      let nextSku = sku;
      if (sku.sellingMethod === 'By Weight' && sku.labour > 5000 && sku.customerNetWeight > 0) {
        changed = true;
        nextSku = { ...sku, labour: Math.round((sku.labour / sku.customerNetWeight) * 100) / 100 };
      }
      if (
        nextSku.retailLabour === undefined ||
        nextSku.semiWholesaleLabour === undefined ||
        nextSku.wholesaleLabour === undefined
      ) {
        changed = true;
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
    if (
      labour !== design.labour ||
      design.retailLabour === undefined ||
      design.semiWholesaleLabour === undefined ||
      design.wholesaleLabour === undefined
    )
      changed = true;
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
  if (changed && canUseStorage())
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

// the preview's own sample data; a real build keeps its designs in the cache and reads no browser storage
let _designs: Design[] = PREVIEW_MODE ? readInitialDesigns() : [];

function persistDesigns() {
  if (canUseStorage()) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(_designs));
  }
}

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
  return {
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
  persistDesigns();
}

export function upsertDesign(design: Design): void {
  assertWritable('A change to a design');
  assertUniqueDesign(design, _designs);
  const exists = _designs.some((d) => d.id === design.id);
  _designs = exists
    ? _designs.map((d) => (d.id === design.id ? design : d))
    : [design, ..._designs];
  persistDesigns();
}

export function removeDesign(id: string): void {
  assertWritable('Removing a design');
  _designs = _designs.filter((d) => d.id !== id);
  persistDesigns();
}

export function removeDesigns(ids: Set<string>): void {
  assertWritable('Removing designs');
  _designs = _designs.filter((d) => !ids.has(d.id));
  persistDesigns();
}

export function clearInventory(): void {
  assertWritable('Clearing the inventory');
  _designs = [];
  persistDesigns();
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

  if (removed) persistDesigns();
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
  if (changed) persistDesigns();
}

export function reserveNextDesignNumber(category: string, prefix: string): string {
  const used = getDesigns()
    .filter((d) => d.category === category && d.designNumber.startsWith(`${prefix}-`))
    .map((d) => Number(d.designNumber.split('-').at(-1)))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(0, ...used) + 1;
  return `${prefix}-${String(next).padStart(5, '0')}`;
}

export function resetLocalDesignData(): void {
  assertWritable('Resetting the stock');
  _designs = [...MOCK_DESIGNS];
  persistDesigns();
}
