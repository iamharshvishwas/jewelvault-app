'use client';

import {
  BUSINESS_LOCATION,
  BUSINESS_NAME,
  BUSINESS_OWNER_NAME,
  BUSINESS_SHORT_NAME,
  BUSINESS_TAGLINE,
} from '@/lib/businessConfig';
import { DEFAULT_CATEGORIES, DEFAULT_CATEGORY_PREFIXES } from '@/lib/catalogStore';
import type { DailyRateRow, UserRow } from '@/lib/api/types';
import { rowCache, savingNotAvailable } from '@/lib/cache/cache';
import { SaveError, editRow, insertRow, putSettingValue, sameDecimal } from '@/lib/cache/edit';
import { stampMicros } from '@/lib/cache/stamp';
import type { DailyRateLike } from '@/lib/pricing';
import { PREVIEW_MODE } from '@/lib/previewMode';

// The settings of the screens, and the daily rates.
//   - In a real build (spec C2, C8, C9) `getSettings()` is made from the rows the hydrate put in memory: one row per key in `settings`, the people from `users`, the category
//     prefixes from `categories` and the rates from `daily_rates` (D3, D20). It answers from memory after the loading gate, reads no browser storage, and never returns the
//     prototype's DEFAULT_SETTINGS values for a number the shop owns: a rate with no row is 0, not the prototype's 6,920. A role that reads fewer keys (staff read seven, A4)
//     gets the prototype's labels for the sections it does not read.
//   - Task WEB05 (C5 (a)) puts the changes on the API. `saveSettings` writes each section that changed as ONE row, `PUT /v1/settings/<key>` with `{ value }`: the last write wins,
//     so there is no stale check and nothing is reloaded on a conflict; memory shows the new value at once and goes back if the write fails. The people (`users`) are not a
//     setting: logins are made with the admin tool. The rates are not settings either: `saveDailyRates` writes `daily_rates` rows (D4, Y8).
//   - In a preview build (until WEB15) the store is the prototype's, in this page only. Nothing is kept in browser storage in either.

export interface MaterialSetting {
  name: string;
  purities: string[];
}

export interface CustomFieldSetting {
  id: string;
  label: string;
  type: 'Text' | 'Number' | 'Date' | 'Yes/No';
  appliesTo: 'Design' | 'SKU' | 'Customer';
  required: boolean;
}

export interface UserSetting {
  id: string;
  name: string;
  role: 'Owner' | 'Admin' | 'Billing Staff' | 'Inventory Staff';
  canSeeOriginalWeight: boolean;
  canEditStock: boolean;
  active: boolean;
}

export interface AppSettings {
  materials: MaterialSetting[];
  customFields: CustomFieldSetting[];
  tagTemplate: {
    widthMm: number;
    heightMm: number;
    fontSize: number;
    barcodeHeightMm: number;
    showBusinessName: boolean;
    showDesignNumber: boolean;
    showCategory: boolean;
    showMaterial: boolean;
    showCustomerNetWeight: boolean;
    showGrossWeight: boolean;
    showPiroi: boolean;
    copiesPerSku: number;
  };
  estimate: {
    prefix: string;
    defaultGoldRate: number;
    defaultSilverRate: number;
    roundOff: boolean;
    footerNote: string;
  };
  taxes: {
    gstEnabled: boolean;
    gstPercent: number;
    estimateTaxPercent: number;
  };
  users: UserSetting[];
  numbering: {
    designPadding: number;
    skuPadding: number;
    barcodePrefix: string;
    categoryPrefixes: Record<string, string>;
  };
  business: {
    legalName: string;
    displayName: string;
    location: string;
    ownerName: string;
    phone: string;
    address: string;
    gstin: string;
    tagline: string;
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  materials: [
    { name: 'Gold', purities: ['18K', '20K', '22K', '24K'] },
    { name: 'Silver', purities: ['800', '925', '999'] },
  ],
  customFields: [
    { id: 'cf-hallmark', label: 'Hallmark', type: 'Text', appliesTo: 'SKU', required: false },
    { id: 'cf-supplier', label: 'Supplier', type: 'Text', appliesTo: 'Design', required: false },
  ],
  tagTemplate: {
    widthMm: 52,
    heightMm: 28,
    fontSize: 10,
    barcodeHeightMm: 8,
    showBusinessName: true,
    showDesignNumber: true,
    showCategory: true,
    showMaterial: true,
    showCustomerNetWeight: true,
    showGrossWeight: true,
    showPiroi: true,
    copiesPerSku: 1,
  },
  estimate: {
    prefix: 'JV',
    defaultGoldRate: 6920,
    defaultSilverRate: 88,
    roundOff: true,
    footerNote: 'This is an estimate only. GST is not charged on this document.',
  },
  taxes: {
    gstEnabled: false,
    gstPercent: 0,
    estimateTaxPercent: 0,
  },
  users: [
    {
      id: 'user-owner',
      name: BUSINESS_OWNER_NAME,
      role: 'Owner',
      canSeeOriginalWeight: true,
      canEditStock: true,
      active: true,
    },
  ],
  numbering: {
    designPadding: 5,
    skuPadding: 3,
    barcodePrefix: 'BC',
    categoryPrefixes: DEFAULT_CATEGORY_PREFIXES,
  },
  business: {
    legalName: BUSINESS_NAME,
    displayName: BUSINESS_SHORT_NAME,
    location: BUSINESS_LOCATION,
    ownerName: BUSINESS_OWNER_NAME,
    phone: '',
    address: '',
    gstin: '',
    tagline: BUSINESS_TAGLINE,
  },
};

function mergeSettings(saved: Partial<AppSettings>): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    tagTemplate: { ...DEFAULT_SETTINGS.tagTemplate, ...saved.tagTemplate },
    estimate: { ...DEFAULT_SETTINGS.estimate, ...saved.estimate },
    taxes: { ...DEFAULT_SETTINGS.taxes, ...saved.taxes, estimateTaxPercent: 0 },
    numbering: {
      ...DEFAULT_SETTINGS.numbering,
      ...saved.numbering,
      categoryPrefixes: {
        ...DEFAULT_SETTINGS.numbering.categoryPrefixes,
        ...DEFAULT_CATEGORIES.reduce<Record<string, string>>((acc, category) => {
          acc[category] = DEFAULT_CATEGORY_PREFIXES[category] || category.slice(0, 4).toUpperCase();
          return acc;
        }, {}),
        ...saved.numbering?.categoryPrefixes,
      },
    },
    business: { ...DEFAULT_SETTINGS.business, ...saved.business },
    materials: saved.materials?.length ? saved.materials : DEFAULT_SETTINGS.materials,
    customFields: saved.customFields || DEFAULT_SETTINGS.customFields,
    users: saved.users?.length ? saved.users : DEFAULT_SETTINGS.users,
  };
}

// ── the settings made from memory (a real build) ─────────────────────────────

let cachedSettings: { version: string; value: AppSettings } | null = null;

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const setting = (key: string): unknown => rowCache.get('settings', key)?.value;

const ROLE_LABEL: Record<UserRow['role'], UserSetting['role']> = {
  owner: 'Owner',
  biller: 'Billing Staff',
  staff: 'Inventory Staff',
};

const stampOrZero = (stamp: string): number => {
  try {
    return stampMicros(stamp);
  } catch {
    return 0;
  }
};

/**
 * The rate of a material the screens show as "the" rate (the dashboard's rate card, the estimate's default): the row with the latest `rate_date`, and of
 * those the one written last. The rates are really per purity and per day (R2); the screens that choose a purity (WEB05, WEB08) read the rows. 0 when there is none.
 */
function latestRate(material: DailyRateRow['material']): number {
  let best: DailyRateRow | null = null;
  for (const row of rowCache.rows('daily-rates')) {
    if (row.material !== material) continue;
    if (
      best === null ||
      row.rate_date > best.rate_date ||
      (row.rate_date === best.rate_date &&
        (stampOrZero(row.updated_at) > stampOrZero(best.updated_at) ||
          (row.updated_at === best.updated_at && row.purity < best.purity)))
    ) {
      best = row;
    }
  }
  const rate = Number(best?.rate_per_gram);
  return Number.isFinite(rate) ? rate : 0;
}

function buildSettings(): AppSettings {
  const materials = setting('materials');
  const customFields = setting('custom_fields');
  return {
    materials:
      Array.isArray(materials) && materials.length
        ? (materials as MaterialSetting[])
        : DEFAULT_SETTINGS.materials,
    customFields: Array.isArray(customFields)
      ? (customFields as CustomFieldSetting[])
      : DEFAULT_SETTINGS.customFields,
    tagTemplate: {
      ...DEFAULT_SETTINGS.tagTemplate,
      ...objectOf(setting('tag_template')),
    } as AppSettings['tagTemplate'],
    estimate: {
      ...DEFAULT_SETTINGS.estimate,
      ...objectOf(setting('estimate')),
      defaultGoldRate: latestRate('Gold'),
      defaultSilverRate: latestRate('Silver'),
    } as AppSettings['estimate'],
    // the prototype's rule: an estimate carries no tax
    taxes: {
      ...DEFAULT_SETTINGS.taxes,
      ...objectOf(setting('taxes')),
      estimateTaxPercent: 0,
    } as AppSettings['taxes'],
    users: rowCache
      .rows('users')
      .map(
        (user): UserSetting => ({
          id: user.id,
          name: user.full_name,
          role: ROLE_LABEL[user.role] ?? 'Billing Staff',
          canSeeOriginalWeight: user.role === 'owner',
          canEditStock: user.role !== 'biller',
          active: user.active,
        })
      )
      .sort((a, b) => a.name.localeCompare(b.name)),
    numbering: {
      ...DEFAULT_SETTINGS.numbering,
      ...objectOf(setting('numbering')),
      categoryPrefixes: Object.fromEntries(
        rowCache.rows('categories').map((category) => [category.name, category.prefix])
      ),
    } as AppSettings['numbering'],
    business: {
      ...DEFAULT_SETTINGS.business,
      ...objectOf(setting('business')),
    } as AppSettings['business'],
  };
}

// the preview's own settings, in this page only
let previewSettings: AppSettings = DEFAULT_SETTINGS;

export function getSettings(): AppSettings {
  if (PREVIEW_MODE) return previewSettings;
  const version = rowCache.versionOf('settings', 'daily-rates', 'categories', 'users');
  if (cachedSettings && cachedSettings.version === version) return cachedSettings.value;
  const value = buildSettings();
  cachedSettings = { version, value };
  return value;
}

/** The stock locations of the shop (the setting `locations`, D3): the places a piece can be. Empty when the role does not read them or none are set. */
export function getLocations(): string[] {
  if (PREVIEW_MODE) return ['Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition'];
  const value = setting('locations');
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// ── saving the settings (WEB05) ──────────────────────────────────────────────

/** The sections of `AppSettings` that are one row each in `settings`, and the key of the row. The people and the rates are rows of other tables. */
const SECTION_KEYS = {
  materials: 'materials',
  customFields: 'custom_fields',
  tagTemplate: 'tag_template',
  estimate: 'estimate',
  taxes: 'taxes',
  numbering: 'numbering',
  business: 'business',
} as const;
type SettingsSection = keyof typeof SECTION_KEYS;
const SECTIONS = Object.keys(SECTION_KEYS) as SettingsSection[];

/** The same JSON value, whatever the order of the keys of an object. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((item, i) => sameJson(item, b[i]));
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  const keys = Object.keys(x);
  return (
    keys.length === Object.keys(y).length &&
    keys.every((key) => Object.hasOwn(y, key) && sameJson(x[key], y[key]))
  );
}

/**
 * The value of the row of a section: what the screen holds, minus what is not part of the row (the rates of the estimate are `daily_rates`, the category prefixes are
 * `categories`), over what the row holds now, so that a key this screen does not know is kept (the last write wins and must not lose the owner's other keys).
 */
function valueOfSection(section: SettingsSection, next: AppSettings): object {
  const stored = objectOf(setting(SECTION_KEYS[section]));
  switch (section) {
    case 'materials':
      return next.materials;
    case 'customFields':
      return next.customFields;
    case 'estimate': {
      const { defaultGoldRate: _gold, defaultSilverRate: _silver, ...rest } = next.estimate;
      return { ...stored, ...rest };
    }
    case 'numbering': {
      const { categoryPrefixes: _prefixes, ...rest } = next.numbering;
      return { ...stored, ...rest };
    }
    case 'taxes':
      return { ...stored, ...next.taxes, estimateTaxPercent: 0 };
    default:
      return { ...stored, ...next[section] };
  }
}

/**
 * Saves the sections of the settings that changed, each as one row, one after another. Memory shows a section at once and goes back if its write fails; the first failure stops
 * the rest. Resolves with the settings as they are then; throws a SaveError (`saved` counts the sections written). A preview changes its own settings.
 */
export async function saveSettings(next: AppSettings): Promise<AppSettings> {
  if (PREVIEW_MODE) {
    previewSettings = mergeSettings(next);
    return previewSettings;
  }
  const current = getSettings();
  let saved = 0;
  for (const section of SECTIONS) {
    if (sameJson(current[section], next[section])) continue;
    try {
      await putSettingValue(SECTION_KEYS[section], valueOfSection(section, next));
      saved += 1;
    } catch (error) {
      throw new SaveError(error, { saved });
    }
  }
  return getSettings();
}

export function resetSettings(): AppSettings {
  if (!PREVIEW_MODE) throw savingNotAvailable('Resetting the settings');
  previewSettings = DEFAULT_SETTINGS;
  return previewSettings;
}

// ── the daily rates (WEB05, D4, R2, Y8) ──────────────────────────────────────

/** Today in the shop's time zone, `YYYY-MM-DD` (S5). The API decides what today is; this is what the screen offers. */
export function businessToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export type RateMaterial = DailyRateRow['material'];

/** One purity of one material on the rate card: its rate for the day if there is one, else the last rate before the day (to start from). */
export interface RateEntry {
  material: RateMaterial;
  purity: string;
  row: DailyRateRow | undefined;
  suggestion: DailyRateRow | undefined;
}

// the preview's sample rates, in this page only
const previewRates: DailyRateRow[] = PREVIEW_MODE
  ? [
      ['Gold', '22K', '6920.00'],
      ['Silver', '925', '88.00'],
    ].map(([material, purity, rate], n) => ({
      id: `preview-rate-${n + 1}`,
      material: material as RateMaterial,
      purity,
      rate_per_gram: rate,
      rate_date: businessToday(),
      confirmed_by: null,
      created_at: '2026-01-01T00:00:00.000000Z',
      updated_at: '2026-01-01T00:00:00.000000Z',
      created_by: null,
      updated_by: null,
    }))
  : [];

const rateRows = (): readonly DailyRateRow[] =>
  PREVIEW_MODE ? previewRates : rowCache.rows('daily-rates');

const ratesLike = (source: readonly DailyRateRow[]): readonly DailyRateLike[] =>
  source.map((row) => ({
    material: row.material,
    purity: row.purity,
    ratePerGram: row.rate_per_gram,
    rateDate: row.rate_date,
  }));
let cachedRates: { source: readonly DailyRateRow[]; value: readonly DailyRateLike[] } | null = null;

/** R2: the daily rates the billing screen picks a default from (material, purity, rate per gram as text, business date). The same array until the rates change. */
export function getDailyRates(): readonly DailyRateLike[] {
  const source = rateRows();
  if (PREVIEW_MODE) return ratesLike(source); // the preview's rates are changed in place
  if (cachedRates?.source !== source) cachedRates = { source, value: ratesLike(source) };
  return cachedRates.value;
}

/** The rate card for a day: each purity of Gold and Silver in the materials setting, with its rate for the day and the last rate before it. */
export function getRateSheet(date: string): RateEntry[] {
  const rows = rateRows();
  const out: RateEntry[] = [];
  for (const material of getSettings().materials) {
    if (material.name !== 'Gold' && material.name !== 'Silver') continue;
    for (const purity of material.purities) {
      let row: DailyRateRow | undefined;
      let suggestion: DailyRateRow | undefined;
      for (const rate of rows) {
        if (rate.material !== material.name || rate.purity !== purity) continue;
        if (rate.rate_date === date) row = rate;
        else if (rate.rate_date < date && (!suggestion || rate.rate_date > suggestion.rate_date))
          suggestion = rate;
      }
      out.push({ material: material.name, purity, row, suggestion });
    }
  }
  return out;
}

export interface RateInput {
  material: RateMaterial;
  purity: string;
  /** What the person typed: an amount above 0 with at most two decimals. */
  rate: string;
}

function rateText(entry: RateInput): string {
  const text = entry.rate.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text) || !/[1-9]/.test(text))
    throw new Error(
      `The ${entry.material} ${entry.purity} rate must be an amount above 0 with at most two decimals, such as 7350.50.`
    );
  const [whole, fraction = ''] = text.split('.');
  return `${whole.replace(/^0+(?=\d)/, '')}.${fraction.padEnd(2, '0')}`;
}

/**
 * Saves the rates of one day (D4): a rate for a purity with no row that day is a NEW row (shown when the server has made it, C11); a rate that has a row is corrected by an
 * ordinary edit of `rate_per_gram`, shown at once; one that did not change is not sent. One after another; the first failure stops the rest and names the purity. The API decides
 * who may do what: the owner any day up to today and may correct today's, a biller today's only and no correction (Y8). Resolves with how many rates were written; throws a
 * SaveError, or an Error before any call for a rate that is not an amount.
 */
export async function saveDailyRates(date: string, entries: readonly RateInput[]): Promise<number> {
  const planned = entries.map((entry) => ({ entry, text: rateText(entry) }));
  if (PREVIEW_MODE) {
    let written = 0;
    for (const { entry, text } of planned) {
      const at = previewRates.findIndex(
        (r) => r.rate_date === date && r.material === entry.material && r.purity === entry.purity
      );
      if (at >= 0) {
        if (!sameDecimal(previewRates[at].rate_per_gram, text)) {
          previewRates[at] = { ...previewRates[at], rate_per_gram: text };
          written += 1;
        }
      } else {
        previewRates.push({
          ...previewRates[0],
          id: `preview-rate-${previewRates.length + 1}`,
          material: entry.material,
          purity: entry.purity,
          rate_per_gram: text,
          rate_date: date,
        });
        written += 1;
      }
    }
    return written;
  }
  let written = 0;
  for (const { entry, text } of planned) {
    const label = `${entry.material} ${entry.purity}`;
    try {
      const existing = rowCache
        .rows('daily-rates')
        .find(
          (r) => r.rate_date === date && r.material === entry.material && r.purity === entry.purity
        );
      if (existing) {
        if (sameDecimal(existing.rate_per_gram, text)) continue;
        await editRow({
          resource: 'daily-rates',
          id: existing.id,
          changes: { rate_per_gram: text },
        });
      } else {
        await insertRow('daily-rates', {
          material: entry.material,
          purity: entry.purity,
          rate_per_gram: text,
          rate_date: date,
        });
      }
      written += 1;
    } catch (error) {
      throw new SaveError(error, { saved: written, label });
    }
  }
  return written;
}
