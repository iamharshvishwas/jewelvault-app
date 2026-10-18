// WEB03: the stock-side stores (designStore, catalogStore, settingsStore) keep their names and their synchronous reads, and answer from the
// memory the hydrate filled (spec C2, C8, C9, D20). `mockData.ts` is read only in a preview build. Nothing is read from or written to browser
// storage, the old `jaishri.*` keys included. The money-side store (appStore) reads no sample data and no old key either; its own move onto the
// cache is WEB07. The browser halves are tests/e2e/hydrate.spec.ts.
//
// The stores read the flag of the preview build when they load, so each case imports a fresh copy of them over a fake `window`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  at,
  categoryRow,
  designRow,
  rateRow,
  settingRow,
  skuPrivateRow,
  skuRow,
  subcategoryRow,
  userRow,
  uuid,
} from './support/rows';

/** A localStorage that records every touch, so a test can say "never touched". */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const touched: string[] = [];
  const api = {
    getItem: (key: string) => {
      touched.push(`get ${key}`);
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem: (key: string, value: string) => {
      touched.push(`set ${key}`);
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      touched.push(`remove ${key}`);
      data.delete(key);
    },
    clear: () => {
      touched.push('clear');
      data.clear();
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
  return { api, data, touched };
}

async function load({ preview = false, storage = {} as Record<string, string> } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  const fake = fakeStorage(storage);
  vi.stubGlobal('window', { localStorage: fake.api });
  const [cache, designs, catalog, settings, app, mock] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/designStore'),
    import('@/lib/catalogStore'),
    import('@/lib/settingsStore'),
    import('@/lib/appStore'),
    import('@/lib/mockData'),
  ]);
  return { fake, cache: cache.rowCache, designs, catalog, settings, app, mock };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** What the hydrate leaves in memory for a small shop: two categories with sub-categories, two designs, three pieces. */
function fillStock(cache: Awaited<ReturnType<typeof load>>['cache'], { owner = true } = {}) {
  cache.merge('users', [userRow(1, { full_name: 'Asha Verma' })]);
  cache.merge('categories', [
    categoryRow(1, 'Ring', 'RING'),
    categoryRow(2, 'Earrings', 'ER'),
    categoryRow(3, 'Retired', 'RET', { active: false }),
  ]);
  cache.merge('subcategories', [
    subcategoryRow(1, 1, 'Kundan'),
    subcategoryRow(2, 1, 'Casting'),
    subcategoryRow(3, 1, 'Old style', { active: false }),
    subcategoryRow(4, 2, 'Jadau'),
  ]);
  cache.merge('designs', [
    designRow(1, {
      name: 'Bridal ring',
      category_id: uuid(101),
      subcategory_id: uuid(201),
      created_by: uuid(901),
      updated_at: at(10),
      created_at: '2026-10-14T08:00:00.123456Z',
    }),
    designRow(2, {
      name: 'Jhumka',
      category_id: uuid(102),
      subcategory_id: uuid(204),
      material: 'Silver',
      purity: '925',
      selling_method: 'Per Piece',
      tags: ['wedding'],
      created_at: '2026-10-15T08:00:00.654321Z',
    }),
  ]);
  cache.merge('skus', [
    skuRow(1, 1, { created_by: uuid(901) }),
    skuRow(2, 1, { status: 'Sold', gross_weight: '20.000', customer_net_weight: '18.500' }),
    skuRow(3, 2, { status: 'Archived', location: null, notes: 'pair' }),
  ]);
  if (owner) cache.merge('sku-private', [skuPrivateRow(1, '10.125')]);
}

describe('T-E05 the stores never fall back to sample data or to anything stored in the browser (C2, C8, D20)', () => {
  it('before the hydrate has filled memory they hold nothing: no sample designs, no sample categories, no sample rate', async () => {
    const { designs, catalog, settings, mock } = await load();
    expect(designs.getDesigns()).toEqual([]);
    expect(catalog.getCategories()).toEqual([]);
    expect(catalog.getSubcategories('Ring')).toEqual([]);
    expect(settings.getSettings().estimate.defaultGoldRate).toBe(0);
    expect(settings.getSettings().estimate.defaultSilverRate).toBe(0);
    expect(mock.MOCK_DESIGNS).toEqual([]);
    expect(mock.MOCK_CUSTOMERS).toEqual([]);
  });

  it('reads and writes no browser storage at all, and leaves the old jaishri.* keys exactly as they were', async () => {
    const legacy = JSON.stringify([{ id: 'legacy', designNumber: 'OLD-00001', skus: [] }]);
    const stored = {
      'jaishri.designs.v1': legacy,
      'jaishri.categories.v1': '["Old category"]',
      'jaishri.subcategories.v2': '{"Old category":["Old sub"]}',
      'jaishri.settings.v1': '{"estimate":{"defaultGoldRate":1}}',
      'jaishri.customers.v1': '[{"id":"legacy-customer","name":"Old Customer"}]',
      'jaishri.invoices.v1': '[]',
      'jaishri.ledger.v1': '[]',
    };
    const { fake, cache, designs, catalog, settings, app } = await load({ storage: stored });
    fillStock(cache);
    designs.getDesigns();
    designs.findSkuByCode('RING-00001-001');
    catalog.getCategories();
    catalog.getSubcategories('Ring');
    catalog.getCategoryPrefix('Ring');
    settings.getSettings();
    app.getCustomers();
    app.getInvoices();
    app.getLedger();
    app.computeDashboardStats();
    expect(fake.touched).toEqual([]);
    expect(Object.fromEntries(fake.data)).toEqual(stored);
    // and none of it shows
    expect(designs.getDesigns().map((d) => d.designNumber)).not.toContain('OLD-00001');
    expect(catalog.getCategories()).not.toContain('Old category');
    expect(app.getCustomers()).toEqual([]);
  });

  it('a build that is not a preview holds no sample records at all: the mock arrays are empty', async () => {
    const { mock } = await load();
    expect(mock.MOCK_DESIGNS).toHaveLength(0);
    expect(mock.MOCK_CUSTOMERS).toHaveLength(0);
    expect(mock.MOCK_INVOICES).toHaveLength(0);
    expect(mock.MOCK_LEDGER).toHaveLength(0);
  });

  it('empties with the memory: after a logout (the cache cleared) the stores hold nothing again', async () => {
    const { cache, designs, catalog, settings } = await load();
    fillStock(cache);
    cache.merge('daily-rates', [rateRow(1)]);
    expect(designs.getDesigns().length).toBeGreaterThan(0);
    expect(settings.getSettings().estimate.defaultGoldRate).toBe(7350);
    cache.clear();
    expect(designs.getDesigns()).toEqual([]);
    expect(catalog.getCategories()).toEqual([]);
    expect(settings.getSettings().estimate.defaultGoldRate).toBe(0);
  });
});

describe('T-E05 getDesigns() and its neighbours answer from memory with the shape the screens know (C9)', () => {
  it("a design carries its pieces, the names of its category and sub-category and the first piece's rates", async () => {
    const { cache, designs } = await load();
    fillStock(cache);
    const list = designs.getDesigns();
    expect(list).toHaveLength(2);
    // the newest first (the prototype put a new design at the front)
    expect(list.map((d) => d.designNumber)).toEqual(['RING-00002', 'RING-00001']);
    const ring = list[1];
    expect(ring).toMatchObject({
      id: uuid(301),
      designNumber: 'RING-00001',
      designName: 'Bridal ring',
      category: 'Ring',
      subcategory: 'Kundan',
      material: 'Gold',
      purity: '22K',
      sellingMethod: 'By Weight',
      description: '',
      notes: '',
      tags: [],
      createdBy: 'Asha Verma',
      createdAt: '2026-10-14T08:00:00.123Z',
      labour: 353,
      retailLabour: 353,
      semiWholesaleLabour: 325,
      wholesaleLabour: 300,
      piroi: 150,
    });
    expect(ring.skus).toHaveLength(2);
    expect(list[0]).toMatchObject({
      category: 'Earrings',
      subcategory: 'Jadau',
      material: 'Silver',
      purity: '925',
      sellingMethod: 'Per Piece',
      tags: ['wedding'],
    });
  });

  it("a piece has its weights and amounts as numbers for the screens, its design's names, and its own status", async () => {
    const { cache, designs } = await load();
    fillStock(cache);
    const ring = designs.getDesigns().find((d) => d.designNumber === 'RING-00001');
    const sku = ring?.skus.find((s) => s.id === uuid(1001));
    expect(sku).toMatchObject({
      id: uuid(1001),
      skuNumber: 'RING-00001-001',
      designId: uuid(301),
      designNumber: 'RING-00001',
      barcode: 'BC100001',
      grossWeight: 12.5,
      customerNetWeight: 11.25,
      stones: 3,
      stoneWeight: 0.5,
      kundan: 2,
      kundanWeight: 0.25,
      piroi: 150,
      labour: 353,
      retailLabour: 353,
      semiWholesaleLabour: 325,
      wholesaleLabour: 300,
      status: 'In Stock',
      location: 'Main Showroom',
      material: 'Gold',
      purity: '22K',
      sellingMethod: 'By Weight',
      category: 'Ring',
      subcategory: 'Kundan',
      notes: '',
      createdBy: 'Asha Verma',
    });
    const sold = ring?.skus.find((s) => s.id === uuid(1002));
    expect(sold).toMatchObject({ status: 'Sold', grossWeight: 20, customerNetWeight: 18.5 });
    const archived = designs.getDesigns()[0].skus[0];
    expect(archived).toMatchObject({ status: 'Archived', location: '', notes: 'pair' });
  });

  it("the owner-only weight is the owner's alone: from sku-private, and 0 for a role that does not read it", async () => {
    const owner = await load();
    fillStock(owner.cache, { owner: true });
    const mine = owner.designs
      .getDesigns()
      .flatMap((d) => d.skus)
      .find((s) => s.id === uuid(1001));
    expect(mine?.originalNetWeight).toBe(10.125);
    const biller = await load();
    fillStock(biller.cache, { owner: false });
    const theirs = biller.designs
      .getDesigns()
      .flatMap((d) => d.skus)
      .find((s) => s.id === uuid(1001));
    expect(theirs?.originalNetWeight).toBe(0);
  });

  it('the list is the same array until a row it is made of changes, so a screen that compares the reads every second does not redraw for nothing', async () => {
    const { cache, designs } = await load();
    fillStock(cache);
    const first = designs.getDesigns();
    expect(designs.getDesigns()).toBe(first);
    cache.merge('customers', [
      {
        id: uuid(5000),
        name: 'C',
        mobile: null,
        customer_type: 'Retail',
        email: null,
        address: null,
        gst_number: null,
        pan: null,
        notes: null,
        is_walkin: false,
        archived_at: null,
        created_at: at(0),
        updated_at: at(5),
        created_by: null,
        updated_by: null,
      },
    ]);
    expect(designs.getDesigns()).toBe(first); // another resource
    cache.merge('skus', [skuRow(1, 1, { status: 'Reserved', updated_at: at(30) })]);
    const second = designs.getDesigns();
    expect(second).not.toBe(first);
    expect(
      second.find((d) => d.id === uuid(301))?.skus.find((s) => s.id === uuid(1001))?.status
    ).toBe('Reserved');
  });

  it('finds a piece by its number or its barcode, in any case', async () => {
    const { cache, designs } = await load();
    fillStock(cache);
    expect(designs.findSkuByCode('ring-00001-002')?.sku.id).toBe(uuid(1002));
    expect(designs.findSkuByCode(' bc100001 ')?.sku.id).toBe(uuid(1001));
    expect(designs.findSkuByCode('bc100001')?.design.id).toBe(uuid(301));
    expect(designs.findSkuByCode('nothing')).toBeNull();
  });

  it('feeds the dashboard counts from memory (appStore reads the design store)', async () => {
    const { cache, app } = await load();
    fillStock(cache);
    const stats = app.computeDashboardStats();
    expect(stats.totalDesigns).toBe(2);
    expect(stats.totalSkus).toBe(3);
    expect(stats.inStock).toBe(1);
    expect(stats.sold).toBe(1);
  });
});

describe('T-E05 the catalogue and the settings answer from memory (C9)', () => {
  it('lists the active categories by name, and the active sub-categories of one', async () => {
    const { cache, catalog } = await load();
    fillStock(cache);
    expect(catalog.getCategories()).toEqual(['Earrings', 'Ring']);
    expect(catalog.getSubcategories('Ring')).toEqual(['Casting', 'Kundan']);
    expect(catalog.getSubcategories('Earrings')).toEqual(['Jadau']);
    expect(catalog.getSubcategories('No such category')).toEqual([]);
    expect(catalog.getCategoryPrefix('Ring')).toBe('RING');
    expect(catalog.getCategoryPrefix('Earrings')).toBe('ER');
  });

  it('builds the settings of the screens from the settings rows, the people from users and the rates from the daily rates', async () => {
    const { cache, settings } = await load();
    fillStock(cache);
    cache.merge('settings', [
      settingRow('business', { displayName: 'Jaishri Gold Palace', phone: '0141' }),
      settingRow('estimate', { prefix: 'JV', roundOff: false, footerNote: 'Estimate only' }),
      settingRow('taxes', { gstEnabled: false, gstPercent: 0, estimateTaxPercent: 5 }),
      settingRow('numbering', { designPadding: 6, skuPadding: 4, barcodePrefix: 'XX' }),
      settingRow('tag_template', { widthMm: 60, copiesPerSku: 2 }),
      settingRow('materials', [{ name: 'Gold', purities: ['22K'] }]),
      settingRow('custom_fields', [
        { id: 'cf-1', label: 'Hallmark', type: 'Text', appliesTo: 'SKU', required: false },
      ]),
      settingRow('data_epoch', { epoch: '1970-01-01 00:00:00.000000' }),
    ]);
    cache.merge('daily-rates', [
      rateRow(1, {
        material: 'Gold',
        purity: '22K',
        rate_per_gram: '7350.00',
        rate_date: '2026-10-14',
      }),
      rateRow(2, {
        material: 'Gold',
        purity: '22K',
        rate_per_gram: '7400.50',
        rate_date: '2026-10-15',
      }),
      rateRow(3, {
        material: 'Silver',
        purity: '925',
        rate_per_gram: '88.25',
        rate_date: '2026-10-15',
      }),
    ]);
    const s = settings.getSettings();
    expect(s.business.displayName).toBe('Jaishri Gold Palace');
    expect(s.business.phone).toBe('0141');
    expect(s.estimate).toMatchObject({
      prefix: 'JV',
      roundOff: false,
      footerNote: 'Estimate only',
      defaultGoldRate: 7400.5,
      defaultSilverRate: 88.25,
    });
    expect(s.taxes.estimateTaxPercent).toBe(0); // the prototype's rule: an estimate carries no tax
    expect(s.numbering).toMatchObject({
      designPadding: 6,
      skuPadding: 4,
      barcodePrefix: 'XX',
      categoryPrefixes: { Ring: 'RING', Earrings: 'ER' },
    });
    expect(s.tagTemplate).toMatchObject({ widthMm: 60, copiesPerSku: 2 });
    expect(s.materials).toEqual([{ name: 'Gold', purities: ['22K'] }]);
    expect(s.customFields).toHaveLength(1);
    expect(s.users).toEqual([
      {
        id: uuid(901),
        name: 'Asha Verma',
        role: 'Owner',
        canSeeOriginalWeight: true,
        canEditStock: true,
        active: true,
      },
    ]);
  });

  it("a role that reads fewer settings keys (staff) gets the rest from the app's own labels, and still no sample rate", async () => {
    const { cache, settings } = await load();
    cache.merge('settings', [
      settingRow('numbering', { designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' }),
      settingRow('tag_template', { widthMm: 52 }),
    ]);
    const s = settings.getSettings();
    expect(s.numbering.barcodePrefix).toBe('BC');
    expect(s.tagTemplate.widthMm).toBe(52);
    expect(s.estimate.defaultGoldRate).toBe(0);
    expect(s.estimate.defaultSilverRate).toBe(0);
    expect(s.materials.length).toBeGreaterThan(0);
  });

  it('is the same object until a row it is made of changes', async () => {
    const { cache, settings } = await load();
    cache.merge('settings', [settingRow('numbering', { designPadding: 5 })]);
    const first = settings.getSettings();
    expect(settings.getSettings()).toBe(first);
    cache.merge('settings', [settingRow('numbering', { designPadding: 7 }, 50)]);
    expect(settings.getSettings()).not.toBe(first);
    expect(settings.getSettings().numbering.designPadding).toBe(7);
  });
});

describe("T-E01 (clause): the owner's rate card reads the rates from memory as soon as the gate has opened", () => {
  it("the card's mount effect asks getSettings(): before the load it gets no rate, after it the rate the shop set", async () => {
    const { cache, settings } = await load();
    expect(settings.getSettings().estimate.defaultGoldRate).toBe(0);
    expect(settings.getSettings().estimate.defaultSilverRate).toBe(0);
    // what the hydrate leaves in memory when the gate opens
    cache.merge('daily-rates', [
      rateRow(1, { material: 'Gold', rate_per_gram: '7350.00' }),
      rateRow(2, { material: 'Silver', purity: '925', rate_per_gram: '88.50' }),
    ]);
    expect(settings.getSettings().estimate.defaultGoldRate).toBe(7350);
    expect(settings.getSettings().estimate.defaultSilverRate).toBe(88.5);
  });
});

describe('T-E05 a change that cannot be saved yet is refused, never shown as if it were saved (C5, C8)', () => {
  // WEB05 put the ordinary edits on the API (tests/unit/stores.test.ts): upsertDesign, renameSubcategory, removeSubcategory and saveSettings are writes now.
  // What is left says "cannot be saved yet" until the task that owns it (WEB06: a new design, a status, a removal; WEB08: the sale) puts it on the API.
  it('every writing function that is not on the API yet says so and changes nothing, and nothing goes to the browser', async () => {
    const { fake, cache, designs, catalog, settings } = await load();
    fillStock(cache);
    const before = designs.getDesigns();
    const design = before[0];
    const attempts: Array<[string, () => unknown]> = [
      ['addDesign', () => designs.addDesign(design)],
      ['removeDesign', () => designs.removeDesign(design.id)],
      ['removeDesigns', () => designs.removeDesigns(new Set([design.id]))],
      ['clearInventory', () => designs.clearInventory()],
      ['removeSku', () => designs.removeSku(uuid(1001))],
      ['updateSkuStatus', () => designs.updateSkuStatus(uuid(1001), 'Reserved')],
      ['resetLocalDesignData', () => designs.resetLocalDesignData()],
      ['addCategory', () => catalog.addCategory('Anklet')],
      ['addSubcategory', () => catalog.addSubcategory('Ring', 'Plain')],
      ['clearAllSubcategories', () => catalog.clearAllSubcategories()],
      ['resetSettings', () => settings.resetSettings()],
    ];
    for (const [name, attempt] of attempts) {
      expect(attempt, name).toThrow(/not saved|cannot be saved/i);
    }
    expect(designs.getDesigns()).toBe(before);
    expect(catalog.getCategories()).toEqual(['Earrings', 'Ring']);
    expect(fake.touched).toEqual([]);
  });
});

describe('T-E05 a preview build keeps the screens alive with sample data, as before (until WEB15)', () => {
  it('holds the sample designs, categories and settings, and the old keys decide what a preview shows', async () => {
    const { designs, catalog, settings, mock, app } = await load({ preview: true });
    expect(mock.MOCK_DESIGNS.length).toBeGreaterThan(0);
    expect(mock.MOCK_CUSTOMERS.length).toBeGreaterThan(0);
    expect(designs.getDesigns().length).toBe(mock.MOCK_DESIGNS.length);
    expect(designs.getDesigns().some((d) => d.designNumber === 'SET-00572')).toBe(true);
    expect(catalog.getCategories()).toEqual(catalog.DEFAULT_CATEGORIES);
    expect(settings.getSettings().estimate.defaultGoldRate).toBe(6920);
    expect(app.getCustomers().length).toBe(mock.MOCK_CUSTOMERS.length);
  });

  it('a preview changes its sample data in this page only: nothing goes to browser storage, and the cache plays no part (WEB05)', async () => {
    const { fake, designs, cache } = await load({ preview: true });
    const first = designs.getDesigns()[0];
    designs.updateSkuStatus(first.skus[0].id, 'Reserved');
    expect(designs.getDesigns()[0].skus[0].status).toBe('Reserved');
    // the stock side keeps nothing in storage (the money side, appStore, still reads its own old keys in a preview: WEB07)
    expect(fake.touched.filter((t) => /designs|categories|subcategories|settings/.test(t))).toEqual(
      []
    );
    expect(cache.size()).toBe(0);
  });
});
