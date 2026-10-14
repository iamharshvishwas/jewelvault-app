'use client';

import {
  BUSINESS_LOCATION,
  BUSINESS_NAME,
  BUSINESS_OWNER_NAME,
  BUSINESS_SHORT_NAME,
  BUSINESS_TAGLINE,
} from '@/lib/businessConfig';
import { DEFAULT_CATEGORIES, DEFAULT_CATEGORY_PREFIXES } from '@/lib/catalogStore';

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

export function getSettings(): AppSettings {
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
  const normalized = mergeSettings(next);
  if (canUseStorage()) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resetSettings(): AppSettings {
  if (canUseStorage()) window.localStorage.removeItem(SETTINGS_KEY);
  return DEFAULT_SETTINGS;
}
