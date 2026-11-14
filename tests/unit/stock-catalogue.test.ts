// FB-D2 (Siddhi #6): the ready-stock catalogue, a screen of the designs that have at least one piece In Stock, by category, with the first photo, printed or saved as a PDF by the browser.
//   - `catalogueRows(designs, categories)`: a design whose pieces are all Sold (or Reserved, anything but In Stock) is absent; the categories filter; the rows are sorted by category and then by
//     design number; the gross-weight range and the count are of the In Stock pieces only; a row has no key for the owner's original weight, and none for a price
//   - the screen draws the photo from the API (`/v1/photos/{id}/thumb`), the design number, name, purity, the gross-weight range and the number of pieces in stock; no price, no original weight,
//     no design that is sold out; the three roles of the shop may open it and nobody else
//
// The screen is drawn on the server side of React (`renderToStaticMarkup`) over the real stores, filled with rows (tests/unit/support/rows.ts), as tests/unit/design-and-scan-detail.test.ts does.
//
// Run: npm test -- tests/unit/stock-catalogue.test.ts      (or: npm test -- -t FB-D2)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Design, Sku, SkuStatus } from '@/lib/mockData';
import { canAccessPath } from '@/lib/authStore';
import { catalogueRows } from '@/lib/stockCatalogue';
import {
  categoryRow,
  designRow,
  settingRow,
  skuPrivateRow,
  skuRow,
  userRow,
  uuid,
} from './support/rows';

const SRC = path.resolve(__dirname, '../../src');
const API = 'https://api.example.test';

// ================================================================================================ the rows, from hand-made designs

const photo = (n: number) => `${API}/v1/photos/${uuid(900 + n)}/full`;

function piece(designNumber: string, n: number, status: SkuStatus, gross: number): Sku {
  return {
    id: uuid(2000 + n),
    skuNumber: `${designNumber}-${String(n).padStart(3, '0')}`,
    designId: uuid(300),
    designNumber,
    grossWeight: gross,
    // the owner's weight: the one figure no row may carry
    originalNetWeight: 99.999,
    customerNetWeight: gross - 0.5,
    stones: 0,
    stoneWeight: 0,
    kundan: 0,
    kundanWeight: 0,
    piroi: 0,
    labour: 353,
    status,
    location: 'Main Showroom',
    barcode: `BC${n}`,
    createdAt: '2026-10-14T08:00:00.000Z',
    createdBy: 'Asha Verma',
    notes: '',
    sellingMethod: 'By Weight',
    purity: '22K',
    material: 'Gold',
    category: 'Ring',
    subcategory: '',
  };
}

function design(
  designNumber: string,
  category: string,
  skus: Array<[SkuStatus, number]>,
  over: Partial<Design> = {}
): Design {
  return {
    id: uuid(300 + Number(designNumber.replace(/\D/g, '') || 0)),
    designNumber,
    designName: `${designNumber} name`,
    category,
    subcategory: '',
    material: 'Gold',
    purity: '22K',
    sellingMethod: 'By Weight',
    description: '',
    notes: '',
    tags: [],
    images: ['/assets/images/no_image.png'],
    primaryImage: '/assets/images/no_image.png',
    skus: skus.map(([status, gross], i) => piece(designNumber, i + 1, status, gross)),
    createdAt: '2026-10-14T08:00:00.000Z',
    createdBy: 'Asha Verma',
    labour: 353,
    piroi: 150,
    ...over,
  };
}

const SHOP: Design[] = [
  design(
    'RING-00002',
    'Ring',
    [
      ['In Stock', 12.5],
      ['In Stock', 10.25],
      ['Sold', 30],
    ],
    {
      images: [photo(2), photo(3)],
      purity: '22K',
    }
  ),
  design('RING-00001', 'Ring', [['In Stock', 8]], { images: [photo(1)], purity: '18K' }),
  design('RING-00003', 'Ring', [
    ['Sold', 9],
    ['Sold', 9.5],
  ]),
  design(
    'CH-00004',
    'Chain',
    [
      ['In Stock', 20.125],
      ['Reserved', 5],
    ],
    { images: [photo(4)] }
  ),
  design('ER-00005', 'Earrings', [['In Stock', 3.1]]),
  design('ER-00006', 'Earrings', []),
];

describe('FB-D2 catalogueRows: which designs, in which order', () => {
  it('a design whose pieces are all Sold is absent, and so is one with no pieces at all', () => {
    const rows = catalogueRows(SHOP, ['Ring', 'Chain', 'Earrings']);
    expect(rows.map((r) => r.designNumber)).not.toContain('RING-00003');
    expect(rows.map((r) => r.designNumber)).not.toContain('ER-00006');
  });

  it('a piece that is Reserved is not In Stock: a design with only reserved pieces is absent', () => {
    const rows = catalogueRows([design('CH-00009', 'Chain', [['Reserved', 5]])], ['Chain']);
    expect(rows).toEqual([]);
  });

  it('only the chosen categories, sorted by category and then by design number', () => {
    expect(catalogueRows(SHOP, ['Ring']).map((r) => r.designNumber)).toEqual([
      'RING-00001',
      'RING-00002',
    ]);
    expect(catalogueRows(SHOP, ['Earrings', 'Chain']).map((r) => r.designNumber)).toEqual([
      'CH-00004',
      'ER-00005',
    ]);
    expect(catalogueRows(SHOP, ['Ring', 'Chain', 'Earrings']).map((r) => r.designNumber)).toEqual([
      'CH-00004',
      'ER-00005',
      'RING-00001',
      'RING-00002',
    ]);
    expect(catalogueRows(SHOP, [])).toEqual([]);
    expect(catalogueRows(SHOP, ['Bangles'])).toEqual([]);
  });

  it('a row says the design, the first photo, the number of pieces in stock and the gross weights of those pieces in milligrams', () => {
    const [chain, , , ring2] = catalogueRows(SHOP, ['Ring', 'Chain', 'Earrings']);
    expect(ring2).toEqual({
      designNumber: 'RING-00002',
      designName: 'RING-00002 name',
      category: 'Ring',
      purity: '22K',
      photoId: uuid(902),
      inStock: 2, // the Sold piece is not counted
      grossMinMg: 10250,
      grossMaxMg: 12500, // the Sold piece of 30 g does not widen the range
    });
    // the Reserved piece (5 g) is not In Stock: it counts for nothing and does not narrow the range
    expect(chain).toMatchObject({ inStock: 1, grossMinMg: 20125, grossMaxMg: 20125 });
  });

  it('weights are whole milligrams, never a float: 20.125 g is 20125 mg and 0.1 + 0.2 g is 300 mg', () => {
    const rows = catalogueRows([design('RING-00010', 'Ring', [['In Stock', 0.1 + 0.2]])], ['Ring']);
    expect(rows[0].grossMinMg).toBe(300);
    expect(Number.isInteger(rows[0].grossMaxMg)).toBe(true);
  });

  it('the photo is the first photo of the design; the placeholder is no photo (null)', () => {
    const rows = catalogueRows(SHOP, ['Ring', 'Earrings']);
    expect(rows.find((r) => r.designNumber === 'RING-00001')?.photoId).toBe(uuid(901));
    expect(rows.find((r) => r.designNumber === 'RING-00002')?.photoId).toBe(uuid(902));
    expect(rows.find((r) => r.designNumber === 'ER-00005')?.photoId).toBeNull();
  });

  it("a row has no key for the owner's original weight and none for a price, whatever the pieces carry", () => {
    const rows = catalogueRows(SHOP, ['Ring', 'Chain', 'Earrings']);
    const keys = new Set(rows.flatMap((r) => Object.keys(r)));
    expect([...keys].sort()).toEqual(
      [
        'category',
        'designName',
        'designNumber',
        'grossMaxMg',
        'grossMinMg',
        'inStock',
        'photoId',
        'purity',
      ].sort()
    );
    for (const key of keys) {
      expect(key.toLowerCase()).not.toContain('original');
      expect(key.toLowerCase()).not.toMatch(/price|rate|labour|amount|net/);
    }
    // the owner's weight of every piece is 99.999 g: no figure of it is anywhere in what a row holds
    expect(JSON.stringify(rows)).not.toMatch(/99\.999|99999/);
  });
});

// ================================================================================================ the screen, over the stores

async function world() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', API);
  const [cache, screen] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/app/stock-catalogue/components/StockCatalogueClient'),
  ]);
  const { rowCache } = cache;
  rowCache.merge('users', [userRow(1, { full_name: 'Asha Verma' })]);
  rowCache.merge('categories', [
    categoryRow(1, 'Ring', 'RING'),
    categoryRow(2, 'Chain', 'CH'),
    categoryRow(3, 'Earrings', 'ER'),
  ]);
  rowCache.merge('settings', [
    settingRow('business', {
      legalName: 'Test Jewellers Pvt Ltd',
      displayName: 'Test Jewellers',
      address: '',
      phone: '',
    }),
  ]);
  rowCache.merge('designs', [
    designRow(1, {
      design_no: 'RING-00001',
      name: 'Alpha ring',
      category_id: uuid(101),
      purity: '22K',
      primary_photo_id: uuid(901),
      photo_ids: [uuid(901), uuid(902)],
    }),
    designRow(2, {
      design_no: 'RING-00002',
      name: 'Sold out ring',
      category_id: uuid(101),
      photo_ids: [uuid(903)],
      primary_photo_id: uuid(903),
    }),
    designRow(3, {
      design_no: 'CH-00003',
      name: 'Beta chain',
      category_id: uuid(102),
      purity: '18K',
    }),
  ]);
  rowCache.merge('skus', [
    skuRow(1, 1, { sku_no: 'RING-00001-001', gross_weight: '12.500', status: 'In Stock' }),
    skuRow(2, 1, { sku_no: 'RING-00001-002', gross_weight: '10.250', status: 'In Stock' }),
    skuRow(3, 1, { sku_no: 'RING-00001-003', gross_weight: '40.000', status: 'Sold' }),
    skuRow(4, 2, { sku_no: 'RING-00002-001', gross_weight: '9.000', status: 'Sold' }),
    skuRow(5, 3, { sku_no: 'CH-00003-001', gross_weight: '20.125', status: 'In Stock' }),
  ]);
  // the owner's weight of the first piece: no figure on the screen is this one
  rowCache.merge('sku-private', [skuPrivateRow(1, '34.987')]);
  return renderToStaticMarkup(React.createElement(screen.default as never));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const decode = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
const plain = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

describe('FB-D2 the catalogue screen', () => {
  it('shows each In Stock design with its first photo from the API, number, name, purity, gross range and pieces in stock', async () => {
    const html = await world();
    const cards = [
      ...html.matchAll(/<article[^>]*data-testid="catalogue-card"[^>]*>([\s\S]*?)<\/article>/g),
    ];
    expect(cards.map((c) => /RING-\d+|CH-\d+/.exec(plain(c[1]))?.[0])).toEqual([
      'CH-00003',
      'RING-00001',
    ]);
    const ring = plain(cards[1][1]);
    expect(ring).toContain('Alpha ring');
    expect(ring).toContain('22K');
    expect(ring).toContain('10.250 - 12.500 g');
    expect(ring).toContain('2 pieces in stock');
    // the photo: the first photo of the design, the small picture, on the API's address
    expect(cards[1][1]).toContain(`src="${API}/v1/photos/${uuid(901)}/thumb"`);
    // a design with no photo shows no broken picture
    expect(cards[0][1]).not.toContain('/v1/photos/');
    const chain = plain(cards[0][1]);
    expect(chain).toContain('20.125 g');
    expect(chain).toContain('1 piece in stock');
  });

  it('has no design that is sold out, no price and no original weight', async () => {
    const html = await world();
    const text = plain(html);
    expect(text).not.toContain('RING-00002');
    expect(text).not.toContain('Sold out ring');
    expect(text).not.toContain('₹');
    expect(text).not.toMatch(/\bRs\b/);
    expect(text).not.toContain('34.987');
    // the Sold piece of 40 g does not widen the range
    expect(text).not.toContain('40.000');
    expect(html).not.toContain(uuid(903));
  });

  it('offers the categories that have stock, names the shop, and can print', async () => {
    const html = await world();
    const chips = [
      ...html.matchAll(/data-testid="catalogue-category"[^>]*>([\s\S]*?)<\/button>/g),
    ].map((m) => plain(m[1]));
    expect(chips).toEqual(['Chain', 'Ring']);
    expect(plain(html)).toContain('Test Jewellers Pvt Ltd');
    expect(html).toMatch(/Print \/ Save PDF/);
    const source = readFileSync(
      path.join(SRC, 'app/stock-catalogue/components/StockCatalogueClient.tsx'),
      'utf8'
    );
    expect(source).toContain('window.print()');
  });
});

describe('FB-D2 who may open the screen', () => {
  it('the owner, the biller and the staff; nobody without a role', () => {
    for (const role of ['owner', 'biller', 'staff'] as const)
      expect(canAccessPath(role, '/stock-catalogue'), role).toBe(true);
    expect(canAccessPath(null, '/stock-catalogue')).toBe(false);
  });

  it('is in the menu under Inventory', () => {
    const sidebar = readFileSync(path.join(SRC, 'components/Sidebar.tsx'), 'utf8');
    expect(sidebar).toMatch(/label: 'Stock Catalogue \(PDF\)',\s*href: '\/stock-catalogue'/);
  });
});
