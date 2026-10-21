// The clean-ups of 19 October, unit half (spec C8, U8, T-E05; the screens of WEB06 and WEB10). The browser half is tests/e2e/role-and-detail.spec.ts.
//
//   CL19-1  the owner-only original weight on the design page: the button (and, behind it, the column) is the OWNER's, by the role of the session, not by a constant of the file. A biller, a staff
//           user and a person whose role is not known yet do not get it; the preview build's demo person is the owner and does.
//   CL19-2  the design page and the scan screen show the design and the piece that the address or the scanned code names, read from the stores (which read the cache): an address that names no
//           design, or one that is not in the stock, says so and shows no other design; "View Design" carries the id of the design of the piece; no sample text is written in the screens; in the
//           preview build the sample design and piece still show, because they come from the preview's sample store.
//
// The screens are drawn on the server side of React (`renderToStaticMarkup`) over the real stores, filled with rows (tests/unit/support/rows.ts); the role is the one thing stood in for. A
// click (the button that shows the column) is not something a static render can do: the browser half presses it.
//
// Run: npm test -- tests/unit/design-and-scan-detail.test.ts      (or: npm test -- -t CL19)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  categoryRow,
  designRow,
  skuPrivateRow,
  skuRow,
  subcategoryRow,
  userRow,
  uuid,
} from './support/rows';

/** `'session'` is the real session store (the preview build's demo person); the others are a role stood in for it. */
type Who = 'owner' | 'biller' | 'staff' | null | 'session';

/** The owner's weight of the first piece: no other figure of the pages is this one. */
const OWNER_WEIGHT = '34.987';

async function world(who: Who, { preview = false } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.doMock('@/lib/authStore', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/authStore')>();
    return {
      ...original,
      useSession: () => (who === 'session' ? original.getSessionState() : { role: who }),
    };
  });
  const [cache, designs, table, tabs, info, gallery] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/designStore'),
    import('@/app/design-detail/components/DesignSkuTable'),
    import('@/app/design-detail/components/DesignTabs'),
    import('@/app/design-detail/components/DesignInfoPanel'),
    import('@/app/design-detail/components/DesignGallery'),
  ]);
  const el = React.createElement;
  return {
    cache: cache.rowCache,
    designs,
    drawTable: (design: unknown) =>
      renderToStaticMarkup(el(table.default as never, { design } as never)),
    drawTabs: (design: unknown) =>
      renderToStaticMarkup(el(tabs.default as never, { design } as never)),
    drawInfo: (design: unknown) =>
      renderToStaticMarkup(el(info.default as never, { design } as never)),
    drawGallery: (design: unknown) =>
      renderToStaticMarkup(el(gallery.default as never, { design } as never)),
  };
}
type World = Awaited<ReturnType<typeof world>>;

/** What the hydrate leaves in memory for a small shop: a ring category, two designs, three pieces, the owner's weight of the first. */
function fillShop(cache: World['cache'], { owner = true } = {}) {
  cache.merge('users', [userRow(1, { full_name: 'Asha Verma' })]);
  cache.merge('categories', [categoryRow(1, 'Ring', 'RING'), categoryRow(2, 'Chain', 'CH')]);
  cache.merge('subcategories', [subcategoryRow(1, 1, 'Kundan'), subcategoryRow(2, 2, 'Rope')]);
  cache.merge('designs', [
    designRow(1, {
      design_no: 'RING-00001',
      name: 'Alpha ring',
      category_id: uuid(101),
      subcategory_id: uuid(201),
      created_at: '2026-10-14T08:00:00.000000Z',
    }),
    designRow(2, {
      design_no: 'CH-00002',
      name: 'Beta chain',
      category_id: uuid(102),
      subcategory_id: uuid(202),
      created_at: '2026-10-15T08:00:00.000000Z',
    }),
  ]);
  cache.merge('skus', [
    skuRow(1, 1, { sku_no: 'RING-00001-001', barcode: 'BCALPHA1' }),
    skuRow(2, 1, { sku_no: 'RING-00001-002', barcode: 'BCALPHA2' }),
    skuRow(3, 2, { sku_no: 'CH-00002-001', barcode: 'BCBETA1' }),
  ]);
  if (owner) cache.merge('sku-private', [skuPrivateRow(1, OWNER_WEIGHT)]);
}

const designOf = (w: World, designNo: string) => {
  const design = w.designs.getDesigns().find((d) => d.designNumber === designNo);
  if (!design) throw new Error(`no design ${designNo}`);
  return design;
};

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const TOGGLE = /Original NW/;
const NOT_THE_OWNER: Array<[string, Who]> = [
  ['a biller', 'biller'],
  ['a staff user', 'staff'],
  ['a person whose role is not known', null],
];

// ================================================================================================ CL19-1

describe('CL19-1 the original weight of a piece is for the owner, by the role of the session', () => {
  it('the owner has the button that shows the column', async () => {
    const w = await world('owner');
    fillShop(w.cache);
    expect(w.drawTable(designOf(w, 'RING-00001'))).toMatch(TOGGLE);
  });

  it.each(NOT_THE_OWNER)('%s has no button, no column and no word of it', async (_label, who) => {
    const w = await world(who);
    fillShop(w.cache, { owner: who === 'staff' ? false : true });
    const design = designOf(w, 'RING-00001');
    for (const html of [w.drawTable(design), w.drawTabs(design)]) {
      expect(html).toContain('RING-00001-001'); // the pieces are there
      expect(html).not.toMatch(TOGGLE);
      expect(html).not.toMatch(/Admin Only|Admin View|Orig\. NW/);
      expect(html).not.toContain(OWNER_WEIGHT);
    }
  });

  it('the preview build opens as the demo owner, so the button is there on its sample piece', async () => {
    const w = await world('session', { preview: true });
    const sample = w.designs
      .getDesigns()
      .find((d) => d.skus.some((s) => s.skuNumber === 'SET-00572-001'));
    if (!sample) throw new Error('the sample design is not in the preview store');
    expect(w.drawTable(sample)).toMatch(TOGGLE);
  });

  it('a real build with no session at all (the demo owner is a preview only) has no button', async () => {
    const w = await world('session');
    fillShop(w.cache);
    expect(w.drawTable(designOf(w, 'RING-00001'))).not.toMatch(TOGGLE);
  });

  it('the file keeps no role of its own: no fixed constant stands for the person who is signed in', () => {
    const file = path.join(
      path.resolve(__dirname, '../..'),
      'src/app/design-detail/components/DesignSkuTable.tsx'
    );
    const names = new Set<string>();
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(names.has('USER_ROLE')).toBe(false);
    expect(names.has('useSession')).toBe(true);
  });
});

// ================================================================================================ CL19-2

/** The `.ts` and `.tsx` files under a folder. */
function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(name)) yield full;
  }
}

/** The string literals and the text of a file (comments do not count). */
function strings(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) out.push(node.text);
    else if (ts.isJsxText(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node))
      out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const SRC = path.resolve(__dirname, '../../src');

describe('CL19-2 the screens write no sample of their own', () => {
  // the made-up design of the prototype, its category and its demo scans: the preview build shows them from the sample STORE (src/lib/mockData.ts), never from a screen
  const SAMPLE = /SET-00572|Necklace Set|Quick demo scans|RING-00821|ER-00341/;
  const screens = [
    ...walk(path.join(SRC, 'app/design-detail')),
    ...walk(path.join(SRC, 'app/scan-detail')),
  ];

  it('there are screens to read', () => {
    expect(screens.length).toBeGreaterThanOrEqual(6);
  });

  it.each(screens.map((file) => [path.relative(SRC, file), file] as const))(
    '%s has no sample design, category or scan in a string or a text',
    (_name, file) => {
      expect(strings(file).filter((text) => SAMPLE.test(text))).toEqual([]);
    }
  );
});

describe('CL19-2 the design of the page is the one the address names', () => {
  it('finds the design by its id, and never falls back to another', async () => {
    const w = await world('owner');
    fillShop(w.cache);
    const { designOfPage } = await import('@/app/design-detail/components/designOfPage');
    const designs = w.designs.getDesigns();
    const alpha = designOf(w, 'RING-00001');
    const beta = designOf(w, 'CH-00002');
    expect(designs[0]).toBe(beta); // the newest design is the first of the list: the one a fallback would show
    expect(designOfPage(designs, alpha.id)).toEqual({ kind: 'found', design: alpha });
    expect(designOfPage(designs, beta.id)).toEqual({ kind: 'found', design: beta });
    expect(designOfPage(designs, null)).toEqual({ kind: 'none' });
    expect(designOfPage(designs, '')).toEqual({ kind: 'none' });
    expect(designOfPage(designs, uuid(999))).toEqual({ kind: 'missing' });
    expect(designOfPage([], alpha.id)).toEqual({ kind: 'missing' });
  });

  it('the view of a found design names it and its own pieces, and its own category in the breadcrumb', async () => {
    const w = await world('owner');
    fillShop(w.cache);
    const { default: View } = await import('@/app/design-detail/components/DesignDetailView');
    const alpha = designOf(w, 'RING-00001');
    const html = renderToStaticMarkup(
      React.createElement(View as never, { state: { kind: 'found', design: alpha } } as never)
    );
    expect(html).toContain('data-testid="design-number"');
    expect(html).toContain('RING-00001');
    expect(html).toContain('Alpha ring');
    expect(html).toContain('RING-00001-001');
    expect(html).toContain('RING-00001-002');
    expect(html).not.toContain('CH-00002');
    expect(html).not.toContain('Beta chain');
    const crumbs = /data-testid="design-breadcrumb"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(crumbs).toContain('Ring');
    expect(crumbs).toContain('RING-00001');
  });

  it('an address with no design, and one with a design that is not there, say so and show no design at all', async () => {
    const w = await world('owner');
    fillShop(w.cache);
    const { default: View } = await import('@/app/design-detail/components/DesignDetailView');
    const draw = (state: unknown) =>
      renderToStaticMarkup(React.createElement(View as never, { state } as never));
    const none = draw({ kind: 'none' });
    const missing = draw({ kind: 'missing' });
    expect(none).toContain('data-testid="design-none"');
    expect(missing).toContain('data-testid="design-missing"');
    expect(none).not.toContain('data-testid="design-missing"');
    expect(missing).not.toContain('data-testid="design-none"');
    for (const html of [none, missing]) {
      expect(html).not.toContain('data-testid="design-number"');
      expect(html).not.toMatch(/RING-0|CH-0|Alpha|Beta/);
      expect(html).toContain('href="/inventory-management"');
    }
  });

  it('the preview build shows its sample design and piece from the preview store, with the demo owner’s button', async () => {
    const w = await world('session', { preview: true });
    const { designOfPage } = await import('@/app/design-detail/components/designOfPage');
    const { default: View } = await import('@/app/design-detail/components/DesignDetailView');
    const state = designOfPage(w.designs.getDesigns(), 'design-set-00572');
    expect(state.kind).toBe('found');
    const html = renderToStaticMarkup(React.createElement(View as never, { state } as never));
    expect(html).toContain('SET-00572');
    expect(html).toContain('SET-00572-001');
    expect(html).toContain('Jaishri Bridal Kundan Necklace Set');
    expect(html).toContain('Necklace Set'); // its category, from the sample store
    expect(html).toMatch(TOGGLE);
    // the other sample design is a design of its own
    const ring = designOfPage(w.designs.getDesigns(), 'design-ring-00821');
    expect(ring.kind).toBe('found');
    expect(
      renderToStaticMarkup(React.createElement(View as never, { state: ring } as never))
    ).not.toContain('SET-00572');
  });
});

// ================================================================================================ CL19-2: the scan screen

async function scanWorld(who: Who, { preview = false } = {}) {
  const w = await world(who, { preview });
  const scan = await import('@/app/scan-detail/components/ScanDetailClient');
  const el = React.createElement;
  const record = (design: ReturnType<typeof designOf> | undefined, skuNumber: string) => {
    const sku = design?.skus.find((s) => s.skuNumber === skuNumber);
    if (!design || !sku) throw new Error(`no piece ${skuNumber}`);
    return { design, sku };
  };
  return {
    ...w,
    screen: () => renderToStaticMarkup(el(scan.default as never)),
    found: (r: unknown) =>
      renderToStaticMarkup(
        el((scan as never as Record<string, never>).SkuDetailCard, {
          record: r,
          onReset: () => undefined,
        } as never)
      ),
    sold: (r: unknown) =>
      renderToStaticMarkup(
        el((scan as never as Record<string, never>).AlreadySoldCard, {
          record: r,
          onReset: () => undefined,
        } as never)
      ),
    record,
  };
}

describe('CL19-2 the scan screen shows what is scanned, from the stores', () => {
  it('a real build writes no demo scan and no example from the prototype on its first screen', async () => {
    const w = await scanWorld('owner');
    fillShop(w.cache);
    const html = w.screen();
    expect(html).toContain('Scan Article');
    expect(html).toContain('placeholder="Enter SKU number or barcode"');
    expect(html).not.toMatch(/Quick demo scans|SET-00572|RING-00821|ER-00341/);
    // not even the real pieces are offered as chips: that is a preview's help
    expect(html).not.toContain('RING-00001-001');
  });

  it('the preview build offers quick scans made from ITS sample store, and only there', async () => {
    const w = await scanWorld('session', { preview: true });
    const html = w.screen();
    expect(html).toContain('Pieces of the sample stock');
    expect(html).not.toContain('Quick demo scans');
    expect(html).toContain('SET-00572-001');
    expect(html).toContain('RING-00821-001');
    expect(html).toContain('SET-00572-002 (Reserved)');
    expect(html).not.toContain('placeholder="Enter SKU number or barcode (e.g.');
  });

  it('View Design opens the design of the piece (its id in the address), in stock or sold', async () => {
    const w = await scanWorld('owner');
    fillShop(w.cache);
    const alpha = designOf(w, 'RING-00001');
    const beta = designOf(w, 'CH-00002');
    const links = (html: string) =>
      Array.from(html.matchAll(/href="(\/design-detail[^"]*)"/g), (m) =>
        m[1].replace(/&amp;/g, '&')
      );
    expect(links(w.found(w.record(alpha, 'RING-00001-001')))).toEqual([
      `/design-detail?id=${alpha.id}`,
    ]);
    expect(links(w.found(w.record(beta, 'CH-00002-001')))).toEqual([
      `/design-detail?id=${beta.id}`,
    ]);
    expect(links(w.sold(w.record(alpha, 'RING-00001-002')))).toEqual([
      `/design-detail?id=${alpha.id}`,
    ]);
  });
});
