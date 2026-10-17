'use client';

import { rowCache, savingNotAvailable } from './cache/cache';
import { PREVIEW_MODE } from './previewMode';

// Task WEB03. In a real build (spec C2, C8, C9) the categories and sub-categories are the rows the hydrate put in memory: `getCategories()` and
// `getSubcategories()` answer from memory after the loading gate, read no browser storage and never fall back to the prototype's lists; before the gate
// opens, or after a logout, they are empty. A change cannot be saved yet (WEB05 puts categories on the API), so the writing functions say so and change
// nothing. In a preview build (until WEB15) the store is the prototype's, kept in this browser only. The DEFAULT_* lists stay: the preview and the
// prototype's settings use them, and a real build never does.

const CATEGORY_KEY = 'jaishri.categories.v1';
const SUBCATEGORY_KEY = 'jaishri.subcategories.v2';
const DEFAULT_SUBCATEGORY_LIST = ['Kundan', 'Casting', 'Jadau', 'Handmade'];

export const DEFAULT_CATEGORIES = [
  'Necklace Set',
  'Pendant Set',
  'Ring',
  'Earrings',
  'Bangles',
  'Bracelet',
  'Chain',
  'Pendant',
  'Kada',
  'Anklet',
  'Payal',
  'Mangalsutra',
  'Nose Pin',
  'Brooch',
  'Other',
];

export const DEFAULT_SUBCATEGORIES: Record<string, string[]> = {
  ...(Object.fromEntries(
    DEFAULT_CATEGORIES.map((category) => [category, DEFAULT_SUBCATEGORY_LIST])
  ) as Record<string, string[]>),
};

export const DEFAULT_CATEGORY_PREFIXES: Record<string, string> = {
  'Necklace Set': 'SET',
  'Pendant Set': 'PSET',
  Ring: 'RING',
  Earrings: 'ER',
  Bangles: 'BNG',
  Bracelet: 'BRC',
  Chain: 'CHN',
  Pendant: 'PEND',
  Kada: 'KADA',
  Anklet: 'ANK',
  Payal: 'PAY',
  Mangalsutra: 'MNG',
  'Nose Pin': 'NP',
  Brooch: 'BRO',
  Other: 'OTH',
};

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readCategories(): string[] {
  if (!canUseStorage()) return DEFAULT_CATEGORIES;
  const saved = window.localStorage.getItem(CATEGORY_KEY);
  if (!saved) return DEFAULT_CATEGORIES;
  try {
    const parsed = JSON.parse(saved) as string[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

let categories = PREVIEW_MODE ? readCategories() : DEFAULT_CATEGORIES;

function readSubcategories(): Record<string, string[]> {
  if (!canUseStorage()) return DEFAULT_SUBCATEGORIES;
  const saved = window.localStorage.getItem(SUBCATEGORY_KEY);
  if (!saved) return DEFAULT_SUBCATEGORIES;
  try {
    const parsed = JSON.parse(saved) as Record<string, string[]>;
    return { ...DEFAULT_SUBCATEGORIES, ...parsed };
  } catch {
    return DEFAULT_SUBCATEGORIES;
  }
}

let subcategories = PREVIEW_MODE ? readSubcategories() : DEFAULT_SUBCATEGORIES;

function persistSubcategories() {
  if (canUseStorage()) window.localStorage.setItem(SUBCATEGORY_KEY, JSON.stringify(subcategories));
}

// ── the lists made from memory (a real build) ────────────────────────────────

interface CatalogView {
  names: string[];
  prefixes: Map<string, string>;
  subcategories: Map<string, string[]>;
}

let cachedView: { version: string; value: CatalogView } | null = null;

const byName = (a: string, b: string) => a.localeCompare(b);

function currentView(): CatalogView {
  const version = rowCache.versionOf('categories', 'subcategories');
  if (cachedView && cachedView.version === version) return cachedView.value;
  const active = rowCache.rows('categories').filter((category) => category.active);
  const nameOf = new Map(active.map((category) => [category.id, category.name]));
  const subcategories = new Map<string, string[]>();
  for (const sub of rowCache.rows('subcategories')) {
    const category = nameOf.get(sub.category_id);
    if (!sub.active || category === undefined) continue;
    const list = subcategories.get(category);
    if (list) list.push(sub.name);
    else subcategories.set(category, [sub.name]);
  }
  for (const list of subcategories.values()) list.sort(byName);
  const value: CatalogView = {
    names: active.map((category) => category.name).sort(byName),
    prefixes: new Map(
      rowCache.rows('categories').map((category) => [category.name, category.prefix])
    ),
    subcategories,
  };
  cachedView = { version, value };
  return value;
}

/** A real build cannot save a change to the lists yet: say so, change nothing. A preview changes its own lists. */
function assertWritable(what: string): void {
  if (!PREVIEW_MODE) throw savingNotAvailable(what);
}

export function getCategories(): string[] {
  if (!PREVIEW_MODE) return currentView().names;
  categories = readCategories();
  return categories;
}

export function addCategory(name: string): string {
  assertWritable('A new category');
  const clean = name.trim();
  if (!clean) throw new Error('Category name is required.');
  const exists = categories.some((category) => category.toLowerCase() === clean.toLowerCase());
  if (exists)
    return categories.find((category) => category.toLowerCase() === clean.toLowerCase()) || clean;
  categories = [...categories, clean].sort((a, b) => a.localeCompare(b));
  subcategories = { ...subcategories, [clean]: subcategories[clean] || DEFAULT_SUBCATEGORY_LIST };
  if (canUseStorage()) window.localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
  persistSubcategories();
  return clean;
}

export function getSubcategories(category: string): string[] {
  if (!PREVIEW_MODE) return currentView().subcategories.get(category) ?? [];
  subcategories = readSubcategories();
  return subcategories[category] || DEFAULT_SUBCATEGORY_LIST;
}

export function addSubcategory(category: string, name: string): string {
  assertWritable('A new sub-category');
  const clean = name.trim();
  if (!category) throw new Error('Select a category first.');
  if (!clean) throw new Error('Subcategory name is required.');
  const current = getSubcategories(category);
  const existing = current.find((item) => item.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  subcategories = {
    ...subcategories,
    [category]: [...current, clean].sort((a, b) => a.localeCompare(b)),
  };
  persistSubcategories();
  return clean;
}

export function renameSubcategory(category: string, oldName: string, newName: string): string {
  assertWritable('A new name for a sub-category');
  const clean = newName.trim();
  if (!category || !oldName) throw new Error('Subcategory is required.');
  if (!clean) throw new Error('Subcategory name is required.');
  const current = getSubcategories(category);
  subcategories = {
    ...subcategories,
    [category]: current
      .map((item) => (item === oldName ? clean : item))
      .sort((a, b) => a.localeCompare(b)),
  };
  persistSubcategories();
  return clean;
}

export function removeSubcategory(category: string, name: string): void {
  assertWritable('Removing a sub-category');
  const current = getSubcategories(category);
  const next = current.filter((item) => item !== name);
  subcategories = {
    ...subcategories,
    [category]: next,
  };
  persistSubcategories();
}

export function clearAllSubcategories(): void {
  assertWritable('Clearing the sub-categories');
  subcategories = Object.fromEntries(getCategories().map((category) => [category, []]));
  persistSubcategories();
}

export function getCategoryPrefix(category: string): string {
  if (!PREVIEW_MODE) {
    const prefix = currentView().prefixes.get(category);
    if (prefix) return prefix;
  } else if (DEFAULT_CATEGORY_PREFIXES[category]) return DEFAULT_CATEGORY_PREFIXES[category];
  const letters = category
    .replace(/[^a-zA-Z]/g, '')
    .slice(0, 4)
    .toUpperCase();
  return letters || 'DES';
}
