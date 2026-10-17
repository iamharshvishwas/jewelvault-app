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
import { stampMicros } from '@/lib/cache/stamp';
import { PREVIEW_MODE } from '@/lib/previewMode';

// Task WEB03. In a real build (spec C2, C8, C9) the settings of the screens are made from the rows the hydrate put in memory: one row per key in
// `settings`, the people from `users`, the category prefixes from `categories` and the rates from `daily_rates` (D3, D20). `getSettings()` answers from memory
// after the loading gate, reads no browser storage, and never returns the prototype's DEFAULT_SETTINGS values for a number the shop owns: a rate with no row is 0,
// not the prototype's 6,920. A role that reads fewer keys (staff read seven, A4) gets the prototype's labels for the sections it does not read. A change cannot be
// saved yet (WEB05 puts settings and rates on the API), so `saveSettings` and `resetSettings` say so and change nothing. In a preview build (until WEB15) the
// store is the prototype's, kept in this browser only.

const SETTINGS_KEY = 'jaishri.settings.v1';

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

function canUseStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

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

export function getSettings(): AppSettings {
  if (!PREVIEW_MODE) {
    const version = rowCache.versionOf('settings', 'daily-rates', 'categories', 'users');
    if (cachedSettings && cachedSettings.version === version) return cachedSettings.value;
    const value = buildSettings();
    cachedSettings = { version, value };
    return value;
  }
  if (!canUseStorage()) return DEFAULT_SETTINGS;
  const saved = window.localStorage.getItem(SETTINGS_KEY);
  if (!saved) return DEFAULT_SETTINGS;
  try {
    return mergeSettings(JSON.parse(saved) as Partial<AppSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(next: AppSettings): AppSettings {
  if (!PREVIEW_MODE) throw savingNotAvailable('A change to the settings');
  const normalized = mergeSettings(next);
  if (canUseStorage()) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resetSettings(): AppSettings {
  if (!PREVIEW_MODE) throw savingNotAvailable('Resetting the settings');
  if (canUseStorage()) window.localStorage.removeItem(SETTINGS_KEY);
  return DEFAULT_SETTINGS;
}
