'use client';

import { MOCK_DESIGNS, type Design, type SkuStatus } from './mockData';

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
    if (images.length !== design.images.length || primaryImage !== design.primaryImage) changed = true;

    const skus = design.skus.map((sku) => {
      let nextSku = sku;
      if (sku.sellingMethod === 'By Weight' && sku.labour > 5000 && sku.customerNetWeight > 0) {
        changed = true;
        nextSku = { ...sku, labour: Math.round((sku.labour / sku.customerNetWeight) * 100) / 100 };
      }
      if (nextSku.retailLabour === undefined || nextSku.semiWholesaleLabour === undefined || nextSku.wholesaleLabour === undefined) {
        changed = true;
        const retail = nextSku.retailLabour ?? nextSku.labour;
        const wholesale = nextSku.wholesaleLabour ?? nextSku.labour;
        nextSku = {
          ...nextSku,
          retailLabour: retail,
          semiWholesaleLabour: nextSku.semiWholesaleLabour ?? Math.round(((retail + wholesale) / 2) * 100) / 100,
          wholesaleLabour: wholesale,
        };
      }
      return nextSku;
    });
    const firstSkuRate = skus.find((sku) => sku.labour > 0)?.labour || design.labour;
    const labour = design.sellingMethod === 'By Weight' && design.labour > 5000 ? firstSkuRate : design.labour;
    if (labour !== design.labour || design.retailLabour === undefined || design.semiWholesaleLabour === undefined || design.wholesaleLabour === undefined) changed = true;
    const retail = design.retailLabour ?? labour;
    const wholesale = design.wholesaleLabour ?? labour;
    return {
      ...design,
      images,
      primaryImage,
      labour,
      retailLabour: retail,
      semiWholesaleLabour: design.semiWholesaleLabour ?? Math.round(((retail + wholesale) / 2) * 100) / 100,
      wholesaleLabour: wholesale,
      skus,
    };
  });
  if (changed && canUseStorage()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

let _designs: Design[] = readInitialDesigns();

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

export function getDesigns(): Design[] {
  return _designs;
}

export function addDesign(design: Design): void {
  assertUniqueDesign(design, _designs);
  _designs = [design, ..._designs];
  persistDesigns();
}

export function upsertDesign(design: Design): void {
  assertUniqueDesign(design, _designs);
  const exists = _designs.some((d) => d.id === design.id);
  _designs = exists ? _designs.map((d) => (d.id === design.id ? design : d)) : [design, ..._designs];
  persistDesigns();
}

export function removeDesign(id: string): void {
  _designs = _designs.filter((d) => d.id !== id);
  persistDesigns();
}

export function removeDesigns(ids: Set<string>): void {
  _designs = _designs.filter((d) => !ids.has(d.id));
  persistDesigns();
}

export function clearInventory(): void {
  _designs = [];
  persistDesigns();
}

export function removeSku(skuId: string): { removed: boolean; removedDesignId?: string } {
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
  for (const design of _designs) {
    const sku = design.skus.find(
      (s) => s.skuNumber.toLowerCase() === normalized || s.barcode.toLowerCase() === normalized
    );
    if (sku) return { design, sku };
  }
  return null;
}

export function updateSkuStatus(skuId: string, status: SkuStatus): void {
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
  const used = _designs
    .filter((d) => d.category === category && d.designNumber.startsWith(`${prefix}-`))
    .map((d) => Number(d.designNumber.split('-').at(-1)))
    .filter((n) => Number.isFinite(n));
  const next = Math.max(0, ...used) + 1;
  return `${prefix}-${String(next).padStart(5, '0')}`;
}

export function resetLocalDesignData(): void {
  _designs = [...MOCK_DESIGNS];
  persistDesigns();
}
