'use client';

import { rowCache } from './cache/cache';
import { editRow, insertRow } from './cache/edit';

// The categories and sub-categories of the stock.
//   - They are the rows the hydrate put in memory (spec C2, C8, C9): `getCategories()` and `getSubcategories()` answer from memory after the loading
//     gate, read no browser storage and never fall back to a list of the prototype's; before the gate opens, or after a logout, they are empty.
//   - Task WEB05 (C5 (a), C11) puts the changes on the API. A NEW category or sub-category is not shown until the server has answered, with the id it gave it
//     (`createCategory`, `createSubcategory`); a rename and a removal are ordinary edits, shown at once and written with the exact stamp of the row. A removal is `active = false`
//     (nothing is deleted, S7), and adding a name that was removed brings that row back, because the name is still taken. A category's prefix is written once, when it is made:
//     the design numbers carry it (L3).

// ── the lists made from memory ───────────────────────────────────────────────

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

export function getCategories(): string[] {
  return currentView().names;
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
  return currentView().subcategories.get(category) ?? [];
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
  const row = subcategoryRowOf(category, name);
  await editRow({ resource: 'subcategories', id: row.id, changes: { active: false } });
}

export function getCategoryPrefix(category: string): string {
  const prefix = currentView().prefixes.get(category);
  if (prefix) return prefix;
  const letters = category
    .replace(/[^a-zA-Z]/g, '')
    .slice(0, 4)
    .toUpperCase();
  return letters || 'DES';
}
