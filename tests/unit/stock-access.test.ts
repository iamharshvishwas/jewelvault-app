// The stock screens follow the person's ticks (plan: access and roles, Task 19; DESIGN 6.2, ticks S1 to S7 and P1). Each control of the Inventory, Add Design, Edit Stock and Design
// detail screens is offered for the tick of the call it makes (the API's matrix row) or of the data it shows, so a person never meets a control the API would refuse. This file holds
// the pure half, in plain Node (`stockAccess`), and the screens that can be drawn on the server side of React: the Inventory header, the Edit Stock form and the two steps of Add Design
// that hold a control (the details step and the groups step), each with the person stood in for. The rest (the grid's Delete buttons, which only exist once the effect has loaded the
// designs) is proved in the browser, tests/e2e/role-and-detail.spec.ts.
//
// The day-one columns below are typed in from what the screens did before the change (they tested the role key: the Scan link, the Delete buttons, the original weight and the metal,
// purity and selling method were the Owner's; the status step and the add-category rows were everyone's who opened the screen, which is the Owner and Staff: a Biller cannot open Add
// Design or Edit Stock) and from tests/e2e/stock-edit.spec.ts and add-design.spec.ts. They are NOT read from the code under test.
//
// Run: npm test -- tests/unit/stock-access.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICK_KEYS, canAccessPath, type TickKey } from '@/lib/access';
import type { Design, SkuStatus } from '@/lib/mockData';
import { stockAccess, type StockAccess } from '@/lib/stockAccess';
import { holderFor, sessionFor, type RoleSpec } from './support/access';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const NOTHING: StockAccess = {
  scanLink: false,
  originalWeight: false,
  deleteDesign: false,
  designMaterial: false,
  changeStatus: false,
  addCategory: false,
};
const CONTROLS = Object.keys(NOTHING) as Array<keyof StockAccess>;
const offering = (...names: Array<keyof StockAccess>): StockAccess => ({
  ...NOTHING,
  ...Object.fromEntries(names.map((name) => [name, true])),
});
const ticks = (...list: TickKey[]): RoleSpec => ({ ticks: list });
/** Every tick but these: the Owner with something taken away. */
const allBut = (...taken: TickKey[]): RoleSpec => ({
  ticks: TICK_KEYS.filter((tick) => !taken.includes(tick)),
});

// ================================================================================================ the pure half

describe('the controls of the stock screens: the three roles of today get what they got', () => {
  it('the Owner gets every control: the Scan link, Delete, the original weight, the metal, the status step and the add-category rows', () => {
    expect(stockAccess(holderFor('owner'))).toEqual(offering(...CONTROLS));
  });

  it('the Biller gets none of them: no owner control on the Inventory screen, and no Add Design or Edit Stock screen to hold the others', () => {
    expect(stockAccess(holderFor('biller'))).toEqual(NOTHING);
  });

  it('Staff get the status step and the add-category rows, and none of the owner controls', () => {
    expect(stockAccess(holderFor('staff'))).toEqual(offering('changeStatus', 'addCategory'));
  });

  it('a Super Admin (every tick and the flag) gets every control, like the Owner', () => {
    expect(stockAccess(holderFor({ ticks: TICK_KEYS, superAdmin: true }))).toEqual(
      offering(...CONTROLS)
    );
  });

  it('nobody who is not known gets a control', () => {
    expect(stockAccess(null)).toEqual(NOTHING);
  });
});

describe('the controls of the stock screens: a control follows its tick', () => {
  // the controls a role with this one tick gets; every other tick opens none of them on its own
  const ALONE: Partial<Record<TickKey, Array<keyof StockAccess>>> = {
    secret_weight: ['scanLink', 'originalWeight'],
    design_material: ['designMaterial'],
    stock_status: ['changeStatus'],
    category_add: ['addCategory'],
  };

  it.each(TICK_KEYS)('a role that holds only %s gets exactly what that tick opens', (tick) => {
    expect(stockAccess(holderFor(ticks(tick)))).toEqual(offering(...(ALONE[tick] ?? [])));
  });

  it('a role with no tick gets nothing', () => {
    expect(stockAccess(holderFor(ticks()))).toEqual(NOTHING);
  });

  it('the original weight and the Scan link go with the secret-weight tick: the Owner without it has neither, a role with only it has both', () => {
    expect(stockAccess(holderFor(allBut('secret_weight')))).toMatchObject({
      originalWeight: false,
      scanLink: false,
    });
    expect(stockAccess(holderFor(ticks('secret_weight')))).toMatchObject({
      originalWeight: true,
      scanLink: true,
    });
  });

  it('the metal, purity and selling method go with their own tick, not with Edit design and piece details: Staff hold that one and have no such control today', () => {
    expect(stockAccess(holderFor(ticks('stock_edit'))).designMaterial).toBe(false);
    expect(stockAccess(holderFor('staff')).designMaterial).toBe(false);
    expect(stockAccess(holderFor(allBut('design_material'))).designMaterial).toBe(false);
  });

  it('the status step needs the status tick and the add-category rows the add-category tick, not the tick of the screen that holds them (Add Design, Edit Stock)', () => {
    expect(stockAccess(holderFor(ticks('stock_edit', 'stock_add'))).changeStatus).toBe(false);
    expect(stockAccess(holderFor(ticks('stock_edit', 'stock_add'))).addCategory).toBe(false);
    expect(stockAccess(holderFor(allBut('stock_status'))).changeStatus).toBe(false);
    expect(stockAccess(holderFor(allBut('category_add'))).addCategory).toBe(false);
  });

  it('Delete asks for everything a removal would touch (the design, its pieces, its photos): all three, and Staff, who hold the first two, have no Delete today', () => {
    const touched = ['stock_edit', 'stock_status', 'photo_rewrite'] as const;
    expect(stockAccess(holderFor(ticks(...touched))).deleteDesign).toBe(true);
    for (const missing of touched)
      expect(
        stockAccess(holderFor(ticks(...touched.filter((tick) => tick !== missing)))).deleteDesign,
        `without ${missing}`
      ).toBe(false);
    expect(stockAccess(holderFor('staff')).deleteDesign).toBe(false);
    expect(stockAccess(holderFor('biller')).deleteDesign).toBe(false);
  });

  it('the Scan link is the gate of the Scan Detail screen for everybody: it is never offered when the screen would refuse, and never withheld when it would open', () => {
    const people: RoleSpec[] = [
      'owner',
      'biller',
      'staff',
      ticks(),
      allBut('secret_weight'),
      { ticks: TICK_KEYS, superAdmin: true },
      ...TICK_KEYS.map((tick) => ticks(tick)),
    ];
    for (const person of people) {
      const who = holderFor(person);
      expect(stockAccess(who).scanLink, JSON.stringify(person)).toBe(
        canAccessPath(who, '/scan-detail')
      );
    }
    expect(stockAccess(null).scanLink).toBe(canAccessPath(null, '/scan-detail'));
  });
});

// ================================================================================================ the Inventory header

/** The screens are drawn with the person stood in for the session (the same way tests/unit/design-and-scan-detail.test.ts does it). */
async function stoodIn(who: RoleSpec | null, { preview = false } = {}): Promise<void> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => sessionFor(who),
  }));
}

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
});

async function drawHeader(who: RoleSpec | null): Promise<string> {
  await stoodIn(who);
  const header = await import('@/app/inventory-management/components/InventoryHeader');
  return renderToStaticMarkup(createElement(header.default));
}

describe('the Inventory header: the Scan link is for the Scan Detail screen, the other buttons are for everybody', () => {
  // what the header drew for every person before the change: the two switches, Print Tags, the three exports, Import and Add Design
  const FOR_EVERYBODY = [
    'aria-label="Grid view"',
    'aria-label="Table view"',
    'href="/print-tags"',
    '>Excel<',
    '>CSV<',
    '>PDF<',
    '>Import<',
    'href="/add-design"',
  ];

  it.each(['owner', 'biller', 'staff'] as const)(
    '%s: the buttons of every person are there',
    async (role) => {
      const html = await drawHeader(role);
      for (const piece of FOR_EVERYBODY) expect(html, piece).toContain(piece);
    }
  );

  it('the Owner has the Scan link', async () => {
    expect(await drawHeader('owner')).toContain('href="/scan-detail"');
  });

  it.each([
    ['the Biller', 'biller'],
    ['Staff', 'staff'],
    ['a person who is not known', null],
  ] as const)('%s has no Scan link', async (_label, who) => {
    expect(await drawHeader(who)).not.toContain('/scan-detail');
  });

  it('a role follows the tick: the secret-weight tick alone gets the link, the Owner without it does not', async () => {
    expect(await drawHeader(ticks('secret_weight'))).toContain('href="/scan-detail"');
    expect(await drawHeader(allBut('secret_weight'))).not.toContain('/scan-detail');
    expect(await drawHeader(ticks('order_view'))).not.toContain('/scan-detail');
  });
});

// ================================================================================================ Edit Stock

const PIECE = 'RING-00001-001';
const design = (status: SkuStatus): Design => ({
  id: 'design-1',
  designNumber: 'RING-00001',
  designName: 'Plain ring',
  category: 'Ring',
  subcategory: 'Plain',
  material: 'Gold',
  purity: '22K',
  sellingMethod: 'By Weight',
  description: '',
  notes: '',
  tags: [],
  images: [],
  primaryImage: '/assets/images/no_image.png',
  skus: [
    {
      id: 'sku-1',
      skuNumber: PIECE,
      designId: 'design-1',
      designNumber: 'RING-00001',
      grossWeight: 12.5,
      originalNetWeight: 10.125,
      customerNetWeight: 11.25,
      stones: 0,
      stoneWeight: 0,
      kundan: 0,
      kundanWeight: 0,
      piroi: 0,
      labour: 353,
      status,
      location: 'Main Showroom',
      barcode: 'BC1',
      createdAt: '2026-10-15T09:00:00.000Z',
      createdBy: 'Asha',
      notes: '',
      sellingMethod: 'By Weight',
      purity: '22K',
      material: 'Gold',
      category: 'Ring',
      subcategory: 'Plain',
    },
  ],
  createdAt: '2026-10-15T09:00:00.000Z',
  createdBy: 'Asha',
  labour: 353,
  piroi: 150,
});

async function drawEditStock(who: RoleSpec | null, status: SkuStatus = 'In Stock') {
  await stoodIn(who);
  const screen = await import('@/app/edit-stock/components/EditStockClient');
  return renderToStaticMarkup(createElement(screen.EditStockForm, { stored: design(status) }));
}

/** The opening tag of the field that follows a label's text (the labels of the form wrap their field). */
function fieldOf(html: string, label: string): string {
  const tag = new RegExp(`${label}<(?:select|input)\\b[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error(`no field "${label}" on the screen`);
  return tag;
}
const statusSelect = (html: string): string => {
  const tag = new RegExp(`<select\\b[^>]*aria-label="Status of ${PIECE}"[^>]*>`).exec(html)?.[0];
  if (!tag) throw new Error('no status step on the screen');
  return tag;
};
const isOff = (tag: string): boolean => /\sdisabled(=""|\s|>)/.test(tag);
const REFUSED = 'title="Your role cannot change this."';
const hasArchive = (html: string): boolean => /Archive<\/button>/.test(html);
const hasOriginal = (html: string): boolean => html.includes('Original Net Wt (g)');

describe('Edit Stock: the owner fields, the status step and the Archive button follow the ticks', () => {
  it('the Owner changes the metal, purity and selling method, sees the original weight, changes the status and can archive a piece', async () => {
    const html = await drawEditStock('owner');
    for (const label of ['Material', 'Purity', 'Selling Method']) {
      expect(isOff(fieldOf(html, label)), label).toBe(false);
      expect(fieldOf(html, label), label).not.toContain('title=');
    }
    expect(hasOriginal(html)).toBe(true);
    expect(isOff(statusSelect(html))).toBe(false);
    expect(hasArchive(html)).toBe(true);
  });

  it('Staff cannot change the metal, purity and selling method (the field says why), have no original weight, and change the status and archive as before', async () => {
    const html = await drawEditStock('staff');
    for (const label of ['Material', 'Purity', 'Selling Method']) {
      expect(isOff(fieldOf(html, label)), label).toBe(true);
      expect(fieldOf(html, label), label).toContain(REFUSED);
    }
    expect(html).not.toContain('Only the owner can change this.');
    expect(hasOriginal(html)).toBe(false);
    expect(isOff(statusSelect(html))).toBe(false);
    expect(hasArchive(html)).toBe(true);
  });

  it('a role with only the metal tick changes the metal, and has no status step, no Archive and no original weight', async () => {
    const html = await drawEditStock(ticks('design_material'));
    for (const label of ['Material', 'Purity', 'Selling Method'])
      expect(isOff(fieldOf(html, label)), label).toBe(false);
    expect(isOff(statusSelect(html))).toBe(true);
    expect(statusSelect(html)).toContain(REFUSED);
    expect(hasArchive(html)).toBe(false);
    expect(hasOriginal(html)).toBe(false);
  });

  it('a role with only the status tick changes the status and archives, and changes none of the metal fields', async () => {
    const html = await drawEditStock(ticks('stock_status'));
    expect(isOff(statusSelect(html))).toBe(false);
    expect(hasArchive(html)).toBe(true);
    for (const label of ['Material', 'Purity', 'Selling Method'])
      expect(isOff(fieldOf(html, label)), label).toBe(true);
    expect(hasOriginal(html)).toBe(false);
  });

  it('a role with only the secret-weight tick sees the original weight and changes nothing else of the owner fields', async () => {
    const html = await drawEditStock(ticks('secret_weight'));
    expect(hasOriginal(html)).toBe(true);
    for (const label of ['Material', 'Purity', 'Selling Method'])
      expect(isOff(fieldOf(html, label)), label).toBe(true);
    expect(isOff(statusSelect(html))).toBe(true);
    expect(hasArchive(html)).toBe(false);
  });

  it('the Owner without the status tick still sees the status of the piece, in a step that cannot be used, and has no Archive', async () => {
    const html = await drawEditStock(allBut('stock_status'));
    expect(isOff(statusSelect(html))).toBe(true);
    expect(statusSelect(html)).toContain(REFUSED);
    expect(html).toMatch(/<option[^>]*selected[^>]*>In Stock<\/option>/);
    expect(hasArchive(html)).toBe(false);
    // the other owner fields stay
    expect(isOff(fieldOf(html, 'Material'))).toBe(false);
    expect(hasOriginal(html)).toBe(true);
  });

  it('a piece that is Sold or Archived has no Archive button, whoever the person is (as before)', async () => {
    expect(hasArchive(await drawEditStock('owner', 'Sold'))).toBe(false);
    expect(hasArchive(await drawEditStock('owner', 'Archived'))).toBe(false);
  });
});

// ================================================================================================ Add Design

describe('Add Design: the rows that add a category or a sub-category follow the add-category tick', () => {
  const EMPTY = {
    designName: '',
    category: 'Ring',
    subcategory: '',
    material: '',
    purity: '',
    sellingMethod: '',
    description: '',
    tags: '',
    notes: '',
  };
  async function drawDetails(who: RoleSpec | null): Promise<string> {
    await stoodIn(who);
    const screen = await import('@/app/add-design/components/AddDesignClient');
    return renderToStaticMarkup(
      createElement(screen.DesignDetailsStep, {
        form: EMPTY,
        onChange: () => undefined,
        generatedDesignNumber: 'RING-00001',
      })
    );
  }
  const hasRows = (html: string) =>
    html.includes('aria-label="New category name"') &&
    html.includes('aria-label="New sub-category name"');
  const hasNoRow = (html: string) =>
    !html.includes('New category name') &&
    !html.includes('New sub-category name') &&
    !html.includes('Add new category') &&
    !html.includes('Add new sub-category');

  it.each(['owner', 'staff'] as const)('%s get both rows, as before', async (role) => {
    expect(hasRows(await drawDetails(role))).toBe(true);
  });

  it('a role with only the add-category tick gets both rows', async () => {
    expect(hasRows(await drawDetails(ticks('category_add')))).toBe(true);
  });

  it.each([
    ['the Biller', 'biller'],
    ['a person who is not known', null],
  ] as const)('%s gets no row (the screen is not open to them anyway)', async (_label, who) => {
    expect(hasNoRow(await drawDetails(who))).toBe(true);
  });

  it('the Owner without the add-category tick, and a role that only adds designs, get no row, and still choose from the categories there are', async () => {
    for (const who of [allBut('category_add'), ticks('stock_add', 'stock_edit')]) {
      const html = await drawDetails(who);
      expect(hasNoRow(html)).toBe(true);
      expect(html).toContain('data-testid="category-select"');
      expect(html).toContain('data-testid="subcategory-select"');
    }
  });
});

describe('Add Design: the field for the original weight follows the secret-weight tick', () => {
  const GROUP = {
    id: 'group-1',
    pieces: '1',
    grossWeight: '',
    originalNetWeight: '',
    customerNetWeight: '',
    stones: '',
    stoneWeight: '',
    kundan: '',
    kundanWeight: '',
    piroi: '',
    labour: '',
    retailLabour: '',
    semiWholesaleLabour: '',
    wholesaleLabour: '',
    notes: '',
  };
  async function drawGroups(who: RoleSpec | null): Promise<string> {
    await stoodIn(who);
    const screen = await import('@/app/add-design/components/AddDesignClient');
    return renderToStaticMarkup(
      createElement(screen.BulkSkuStep, {
        designNumber: 'RING-00001',
        sellingMethod: 'By Weight',
        skus: [GROUP],
        onSkusChange: () => undefined,
      })
    );
  }
  const FIELD = 'Original Net Wt (g)';

  it('the Owner has the field, a role with only the tick has it, and a Super Admin has it', async () => {
    for (const who of [
      'owner',
      ticks('secret_weight'),
      { ticks: TICK_KEYS, superAdmin: true },
    ] as const)
      expect(await drawGroups(who), JSON.stringify(who)).toContain(FIELD);
  });

  it('Staff and the Biller have no field (it is not hidden: it is not there), and the rest of the group is drawn as before', async () => {
    for (const who of ['staff', 'biller', null] as const) {
      const html = await drawGroups(who);
      expect(html, String(who)).not.toContain('Original Net Wt');
      expect(html, String(who)).toContain('Customer Net Wt (g)');
      expect(html, String(who)).toContain('Gross Weight (g)');
    }
  });

  it('the Owner with the secret-weight tick taken away has no field', async () => {
    expect(await drawGroups(allBut('secret_weight'))).not.toContain('Original Net Wt');
  });
});

// ================================================================================================ the screens read no role

describe('the stock screens read no role key and name no role', () => {
  const SRC = path.resolve(__dirname, '../../src');
  const FILES = [
    'app/inventory-management/components/InventoryHeader.tsx',
    'app/inventory-management/components/InventoryGrid.tsx',
    'app/edit-stock/components/EditStockClient.tsx',
    'app/add-design/components/AddDesignClient.tsx',
    'app/design-detail/components/DesignSkuTable.tsx',
    'app/catalogue/components/CatalogueClient.tsx',
    'lib/inventoryExport.ts',
  ];

  /** What a file reads from a person's role: a property called `role`, and the three names of today's roles as text. A JSX `role="alert"` is an attribute, not a read. */
  function roleReads(file: string): string[] {
    const full = path.join(SRC, file);
    const source = ts.createSourceFile(
      full,
      readFileSync(full, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'role')
        found.push(node.getText(source));
      if (ts.isStringLiteralLike(node) && ['owner', 'biller', 'staff'].includes(node.text))
        found.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it.each(FILES)('%s', (file) => {
    expect(roleReads(file)).toEqual([]);
  });
});
