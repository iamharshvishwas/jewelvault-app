'use client';

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
  ...Object.fromEntries(DEFAULT_CATEGORIES.map((category) => [category, DEFAULT_SUBCATEGORY_LIST])) as Record<string, string[]>,
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

let categories = readCategories();

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

let subcategories = readSubcategories();

function persistSubcategories() {
  if (canUseStorage()) window.localStorage.setItem(SUBCATEGORY_KEY, JSON.stringify(subcategories));
}

export function getCategories(): string[] {
  categories = readCategories();
  return categories;
}

export function addCategory(name: string): string {
  const clean = name.trim();
  if (!clean) throw new Error('Category name is required.');
  const exists = categories.some((category) => category.toLowerCase() === clean.toLowerCase());
  if (exists) return categories.find((category) => category.toLowerCase() === clean.toLowerCase()) || clean;
  categories = [...categories, clean].sort((a, b) => a.localeCompare(b));
  subcategories = { ...subcategories, [clean]: subcategories[clean] || DEFAULT_SUBCATEGORY_LIST };
  if (canUseStorage()) window.localStorage.setItem(CATEGORY_KEY, JSON.stringify(categories));
  persistSubcategories();
  return clean;
}

export function getSubcategories(category: string): string[] {
  subcategories = readSubcategories();
  return subcategories[category] || DEFAULT_SUBCATEGORY_LIST;
}

export function addSubcategory(category: string, name: string): string {
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
  const clean = newName.trim();
  if (!category || !oldName) throw new Error('Subcategory is required.');
  if (!clean) throw new Error('Subcategory name is required.');
  const current = getSubcategories(category);
  subcategories = {
    ...subcategories,
    [category]: current.map((item) => (item === oldName ? clean : item)).sort((a, b) => a.localeCompare(b)),
  };
  persistSubcategories();
  return clean;
}

export function removeSubcategory(category: string, name: string): void {
  const current = getSubcategories(category);
  const next = current.filter((item) => item !== name);
  subcategories = {
    ...subcategories,
    [category]: next,
  };
  persistSubcategories();
}

export function clearAllSubcategories(): void {
  subcategories = Object.fromEntries(getCategories().map((category) => [category, []]));
  persistSubcategories();
}

export function getCategoryPrefix(category: string): string {
  if (DEFAULT_CATEGORY_PREFIXES[category]) return DEFAULT_CATEGORY_PREFIXES[category];
  const letters = category.replace(/[^a-zA-Z]/g, '').slice(0, 4).toUpperCase();
  return letters || 'DES';
}
