'use client';

import { rowCache, savingNotAvailable } from './cache/cache';
import { editRow, insertRow } from './cache/edit';
import { PREVIEW_MODE } from './previewMode';

// The categories and sub-categories of the stock.
//   - In a real build (spec C2, C8, C9) they are the rows the hydrate put in memory: `getCategories()` and `getSubcategories()` answer from memory after the loading
//     gate, read no browser storage and never fall back to the prototype's lists; before the gate opens, or after a logout, they are empty.
//   - Task WEB05 (C5 (a), C11) puts the changes on the API. A NEW category or sub-category is not shown until the server has answered, with the id it gave it
//     (`createCategory`, `createSubcategory`); a rename and a removal are ordinary edits, shown at once and written with the exact stamp of the row. A removal is `active = false`
//     (nothing is deleted, S7), and adding a name that was removed brings that row back, because the name is still taken. A category's prefix is written once, when it is made:
//     the design numbers carry it (L3).
//   - `addCategory` and `addSubcategory` (synchronous, used by the Add Design screen) cannot be saved from there yet: that screen is WEB06's, and until it moves to
//     `createCategory` and `createSubcategory` they say so and change nothing in a real build.
//   - In a preview build (until WEB15) the store is the prototype's, in this page only. The DEFAULT_* lists stay: the preview and the prototype's settings use them, and a real
//     build never does. Nothing is kept in browser storage in either.

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

const copyLists = (lists: Record<string, string[]>): Record<string, string[]> =>
  Object.fromEntries(Object.entries(lists).map(([name, list]) => [name, [...list]]));

// the preview's own lists, in this page only
let categories: string[] = PREVIEW_MODE ? [...DEFAULT_CATEGORIES] : DEFAULT_CATEGORIES;
let subcategories: Record<string, string[]> = PREVIEW_MODE
  ? copyLists(DEFAULT_SUBCATEGORIES)
  : DEFAULT_SUBCATEGORIES;

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

/** A real build cannot save this change from here yet: say so, change nothing. A preview changes its own lists. */
function assertWritable(what: string): void {
  if (!PREVIEW_MODE) throw savingNotAvailable(what);
}

export function getCategories(): string[] {
  return PREVIEW_MODE ? categories : currentView().names;
}

const sortedNames = (list: string[]) => [...list].sort((a, b) => a.localeCompare(b));

function previewAddCategory(clean: string): string {
  const existing = categories.find((category) => category.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  categories = sortedNames([...categories, clean]);
  subcategories = { ...subcategories, [clean]: subcategories[clean] || DEFAULT_SUBCATEGORY_LIST };
  return clean;
}

function previewAddSubcategory(category: string, clean: string): string {
  const current = getSubcategories(category);
  const existing = current.find((item) => item.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  subcategories = { ...subcategories, [category]: sortedNames([...current, clean]) };
  return clean;
}

/** The synchronous add of the prototype. Add Design (WEB06) calls it; a real build cannot save from there yet. */
export function addCategory(name: string): string {
  assertWritable('A new category');
  const clean = name.trim();
  if (!clean) throw new Error('Category name is required.');
  return previewAddCategory(clean);
}

/** The prefix a category gets when the person gives none: the first letters of its name. A starting point for the field, which the person may change. */
export function suggestCategoryPrefix(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 4)
    .toUpperCase();
}

/**
 * A new category (C11): nothing is shown until the server has made it, with its own id. The name is trimmed; the prefix (2 to 6 capital letters or digits, written once)
 * is checked by the API. A name that is in use is not made again: an active one is returned as it is, one that was removed is brought back. Throws a SaveError.
 */
export async function createCategory(name: string, prefix: string): Promise<string> {
  const clean = name.trim();
  if (!clean) throw new Error('Category name is required.');
  if (PREVIEW_MODE) return previewAddCategory(clean);
  const existing = rowCache
    .rows('categories')
    .find((category) => category.name.toLowerCase() === clean.toLowerCase());
  if (existing) {
    if (!existing.active)
      await editRow({ resource: 'categories', id: existing.id, changes: { active: true } });
    return existing.name;
  }
  await insertRow('categories', { name: clean, prefix: prefix.trim().toUpperCase() });
  return clean;
}

export function getSubcategories(category: string): string[] {
  if (!PREVIEW_MODE) return currentView().subcategories.get(category) ?? [];
  return subcategories[category] || DEFAULT_SUBCATEGORY_LIST;
}

/** The synchronous add of the prototype. Add Design (WEB06) calls it; a real build cannot save from there yet. */
export function addSubcategory(category: string, name: string): string {
  assertWritable('A new sub-category');
  const clean = name.trim();
  if (!category) throw new Error('Select a category first.');
  if (!clean) throw new Error('Subcategory name is required.');
  return previewAddSubcategory(category, clean);
}

function categoryRowOf(category: string) {
  const row = rowCache.rows('categories').find((item) => item.name === category);
  if (!row) throw new Error(`"${category}" is not a category.`);
  return row;
}

function subcategoryRowOf(category: string, name: string) {
  const categoryId = categoryRowOf(category).id;
  const row = rowCache
    .rows('subcategories')
    .find((item) => item.category_id === categoryId && item.name === name && item.active);
  if (!row) throw new Error(`"${name}" is not a sub-category of ${category}.`);
  return row;
}

/** A new sub-category of a category (C11), as `createCategory`. Throws a SaveError. */
export async function createSubcategory(category: string, name: string): Promise<string> {
  const clean = name.trim();
  if (!category) throw new Error('Select a category first.');
  if (!clean) throw new Error('Subcategory name is required.');
  if (PREVIEW_MODE) return previewAddSubcategory(category, clean);
  const categoryId = categoryRowOf(category).id;
  const existing = rowCache
    .rows('subcategories')
    .find(
      (sub) => sub.category_id === categoryId && sub.name.toLowerCase() === clean.toLowerCase()
    );
  if (existing) {
    if (!existing.active)
      await editRow({ resource: 'subcategories', id: existing.id, changes: { active: true } });
    return existing.name;
  }
  await insertRow('subcategories', { category_id: categoryId, name: clean });
  return clean;
}

/** A new name for a sub-category: an ordinary edit, shown at once. Throws a SaveError. */
export async function renameSubcategory(
  category: string,
  oldName: string,
  newName: string
): Promise<string> {
  const clean = newName.trim();
  if (!category || !oldName) throw new Error('Subcategory is required.');
  if (!clean) throw new Error('Subcategory name is required.');
  if (PREVIEW_MODE) {
    subcategories = {
      ...subcategories,
      [category]: sortedNames(
        getSubcategories(category).map((item) => (item === oldName ? clean : item))
      ),
    };
    return clean;
  }
  const row = subcategoryRowOf(category, oldName);
  await editRow({
    resource: 'subcategories',
    id: row.id,
    changes: clean === row.name ? {} : { name: clean },
  });
  return clean;
}

/** Takes a sub-category out of the lists: `active = false`, an ordinary edit, shown at once. The row stays (S7). Throws a SaveError. */
export async function removeSubcategory(category: string, name: string): Promise<void> {
  if (PREVIEW_MODE) {
    subcategories = {
      ...subcategories,
      [category]: getSubcategories(category).filter((item) => item !== name),
    };
    return;
  }
  const row = subcategoryRowOf(category, name);
  await editRow({ resource: 'subcategories', id: row.id, changes: { active: false } });
}

export function clearAllSubcategories(): void {
  assertWritable('Clearing the sub-categories');
  subcategories = Object.fromEntries(getCategories().map((category) => [category, []]));
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
