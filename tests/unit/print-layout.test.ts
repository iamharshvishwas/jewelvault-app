// WEB13 (PT-W13): the printed estimate and the tag page (PLAN.md P3-T1; QA UI-03, UI-04). The pages that Chromium cuts are checked in a real browser by tests/e2e/print.spec.ts; these are the
// checks that need no browser:
//   - the shop's name, address and phone on the estimate are the Settings' (`business`), and a blank one prints nothing
//   - a Per Piece line with a quantity above 1 says so (the handoffs of WEB07, WEB08 and WEB11 left the quantity to this task); nothing changes for a bill of single pieces
//   - the print rules of src/styles/tailwind.css: no fixed height, no clipping, no absolute position on the sheet; the totals block kept together; the header row repeated; a line never cut;
//     the application's bars hidden and its shell let go of the window's height, for every page that is printed
//   - the shell carries the names the print rules use
//
// The screen is drawn on the server side of React over the real store, as tests/unit/ledger-screens.test.ts does.
//
// Run: npm test -- tests/unit/print-layout.test.ts      (or: npm test -- -t PT-W13)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { at, uuid } from './support/rows';
import { billRow, customerRow, fill, itemRow, shop, summaryRow } from './support/money-rows';

const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  usePathname: () => '/estimate',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const SRC = path.resolve(__dirname, '../../src');

// ================================================================================================ the books

const meera = uuid(5301);

/** A bill with the lines it is given: 1 = a ring by weight, 2 = a Per Piece line with a quantity of 3 (price 1,500.00 each). */
function oneBill(lines: ('weight' | 'pieces3' | 'piece1')[]) {
  const bill = billRow(21, meera, {
    bill_no: 'JV-0021',
    subtotal: '9000.00',
    grand_total: '9000.00',
    bill_date: '2026-10-15',
  });
  const items = lines.map((kind, i) =>
    kind === 'weight'
      ? itemRow(bill, i + 1, {
          design_no: 'RING-00001',
          sku_no: `RING-00001-00${i + 1}`,
          item_total: '4500.00',
          metal_amount: '4500.00',
        })
      : itemRow(bill, i + 1, {
          design_no: 'PEND-00002',
          sku_no: `PEND-00002-00${i + 1}`,
          selling_method: 'Per Piece',
          gross_weight: '2.000',
          customer_net_weight: '1.800',
          quantity: kind === 'pieces3' ? 3 : 1,
          metal_rate: '1500.00',
          labour_rate: '0.00',
          labour_amount: '0.00',
          metal_amount: kind === 'pieces3' ? '4500.00' : '1500.00',
          item_total: kind === 'pieces3' ? '4500.00' : '1500.00',
        })
  );
  const base = shop();
  return {
    ...base,
    customers: [customerRow(meera, { name: 'Meera Jain', mobile: '9000100001' })],
    balances: [],
    bills: [bill],
    summaries: [
      summaryRow(bill, {
        received: '0.00',
        pending: '9000.00',
        fine_settled: '0.000',
        fine_pending: '0.000',
        payment_status: 'Pending',
        item_count: lines.length,
      }),
    ],
    items,
    receipts: [],
    allocations: [],
    billId: bill.id,
  };
}

const businessRow = (value: Record<string, unknown>) => ({
  setting_key: 'business',
  value,
  created_at: at(1),
  updated_at: at(1),
  created_by: null,
  updated_by: null,
});

async function world(
  lines: ('weight' | 'pieces3' | 'piece1')[],
  business: Record<string, unknown> | null
) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.stubGlobal('fetch', () => Promise.reject(new Error('this test makes no call')));
  const [react, dom, cache, app, estimate] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
    import('@/app/estimate/components/EstimateViewClient'),
  ]);
  const book = oneBill(lines);
  fill(cache.rowCache, book as never);
  if (business)
    (cache.rowCache.merge as (r: never, rows: never) => number)(
      'settings' as never,
      [businessRow(business)] as never
    );
  address.search = `id=${book.billId}`;
  return {
    app,
    book,
    html: dom.renderToStaticMarkup(react.createElement(estimate.default, {})),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  address.search = '';
});

const decode = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
const plain = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
const textOf = (html: string, testId: string): string => {
  const found = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(
    html
  );
  if (!found) throw new Error(`no element has data-testid="${testId}"`);
  return plain(found[2]);
};
/** The markup of the sheet's `h1` and what follows it up to the estimate number: the shop's block. */
const shopBlock = (html: string) =>
  /<h1[\s\S]*?<\/h1>[\s\S]*?(?=Estimate No\.)/.exec(html)?.[0] ?? '';

// ================================================================================================ the shop on the paper

describe("PT-W13 the shop on the printed estimate is the Settings (layout only: the figures are the API's)", () => {
  it('the name, the address and the phone come from the business settings', async () => {
    const w = await world(['weight'], {
      legalName: 'Test Jewellers Pvt Ltd',
      displayName: 'Test Jewellers',
      address: '12 Sarafa Bazaar\nUjjain 456006',
      phone: '+91 99999 13013',
    });
    expect(textOf(w.html, 'estimate-shop-name')).toBe('Test Jewellers Pvt Ltd');
    expect(textOf(w.html, 'estimate-shop-address')).toBe('12 Sarafa Bazaar Ujjain 456006');
    // the line break of the address is kept on the paper
    expect(w.html).toMatch(
      /data-testid="estimate-shop-address"[^>]*class="[^"]*whitespace-pre-line/
    );
    expect(textOf(w.html, 'estimate-shop-phone')).toContain('+91 99999 13013');
    // the prototype's constant is not printed any more when the Settings have a name
    expect(plain(w.html)).not.toContain('Jaishri Gold Palace');
  });

  it('a blank address or phone prints no line at all, and a blank name falls back to the constant of the prototype', async () => {
    const seeded = await world(['weight'], {
      legalName: 'Test Jewellers Pvt Ltd',
      address: '',
      phone: '  ',
    });
    expect(textOf(seeded.html, 'estimate-shop-name')).toBe('Test Jewellers Pvt Ltd');
    expect(seeded.html).not.toContain('estimate-shop-address');
    expect(seeded.html).not.toContain('estimate-shop-phone');
    const blank = await world(['weight'], { legalName: ' ', address: '', phone: '' });
    expect(textOf(blank.html, 'estimate-shop-name')).toBe('Jaishri Gold Palace Pvt Ltd');
  });

  it('no business row in memory (not read yet): the name of the prototype, no address, no phone', async () => {
    const w = await world(['weight'], null);
    expect(textOf(w.html, 'estimate-shop-name')).toBe('Jaishri Gold Palace Pvt Ltd');
    expect(shopBlock(w.html)).not.toMatch(/Phone/);
  });

  it('a value of the Settings is text on the paper, never markup', async () => {
    const w = await world(['weight'], {
      legalName: '<img src=x onerror=alert(1)> & Sons',
      address: '<b>1 Main</b>',
      phone: '1',
    });
    expect(w.html).not.toContain('<img src=x');
    expect(w.html).not.toContain('<b>1 Main</b>');
    expect(textOf(w.html, 'estimate-shop-name')).toBe('<img src=x onerror=alert(1)> & Sons');
  });
});

// ================================================================================================ the quantity

describe('PT-W13 a Per Piece line with a quantity above 1 says so (left to this task by WEB07, WEB08 and WEB11)', () => {
  it('the invoice line has the quantity of the bill_items row', async () => {
    const w = await world(['weight', 'pieces3'], null);
    const invoice = w.app.getInvoiceById(w.book.billId)!;
    expect(invoice.items.map((item) => item.quantity)).toEqual([1, 3]);
  });

  it("the sheet has a Qty column, on screen and on paper, when any line has more than one piece, and the figures of the line stay the API's", async () => {
    const w = await world(['weight', 'pieces3'], null);
    const headers = [...w.html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => plain(m[1]));
    // two tables (the screen's and the paper's), each with the column
    expect(headers.filter((h) => h === 'Qty')).toHaveLength(2);
    const rows = [...w.html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => plain(c[1]))
    );
    const pieceRows = rows.filter((cells) => cells.includes('PEND-00002-002'));
    expect(pieceRows).toHaveLength(2);
    for (const cells of pieceRows) {
      expect(cells).toContain('3');
      expect(cells).toContain('₹1,500'); // the price of one piece
      expect(cells).toContain('₹4,500'); // the API's line total for three
    }
  });

  it('a bill of single pieces prints as it did: no Qty column', async () => {
    const w = await world(['weight', 'piece1'], null);
    expect(plain(w.html)).not.toMatch(/\bQty\b/);
  });
});

// ================================================================================================ the print rules

/** The text between the braces of the first rule in the print block whose selector list contains `selector`. */
function printBlock(): string {
  const css = readFileSync(path.join(SRC, 'styles/tailwind.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  const start = css.indexOf('@media print');
  expect(start, 'the file has a print block').toBeGreaterThan(-1);
  return css.slice(start);
}

function printRule(selector: string): string {
  const block = printBlock();
  const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const found = rules.find((rule) =>
    rule[1]
      .split(',')
      .map((s) => s.trim())
      .includes(selector)
  );
  if (!found) throw new Error(`the print block has no rule for ${selector}`);
  return found[2];
}
const declared = (body: string, property: string): string | null => {
  const found = new RegExp(
    `(?:^|[;\\s])${property}\\s*:\\s*([^;]+?)\\s*(?:!important)?\\s*(?:;|$)`
  ).exec(body);
  return found ? found[1].trim() : null;
};

describe('PT-W13 the print rules: pages that flow', () => {
  it('the estimate sheet has no fixed height, no clipping and no absolute position (UI-04: it was max-height 136mm with overflow hidden)', () => {
    const rule = printRule('.print-estimate-sheet');
    expect(declared(rule, 'max-height')).toBe('none');
    expect(declared(rule, 'min-height')).toBe('0');
    expect(declared(rule, 'height')).toBe('auto');
    expect(declared(rule, 'overflow')).toBe('visible');
    expect(declared(rule, 'position')).toBe('static');
    // the paper stays A4 as printed today: the sheet asks for no page of its own (a named page was never honoured for the box that was taken out of the flow)
    expect(declared(rule, 'page')).toBeNull();
    expect(printBlock()).not.toContain('estimate-half-sheet');
    expect(declared(printRule('@page'), 'size')).toBe('A4');
  });

  it('no print rule anywhere fixes a height in millimetres or clips a sheet', () => {
    const block = printBlock();
    expect(block).not.toMatch(/(?:max-|min-)?height\s*:\s*\d+(?:\.\d+)?mm/);
    expect(block).not.toMatch(/overflow\s*:\s*hidden/);
    expect(block).not.toMatch(/position\s*:\s*absolute/);
  });

  it('the totals block is kept together, the header row is repeated and a line is never cut', () => {
    for (const property of ['break-inside', 'page-break-inside']) {
      expect(declared(printRule('.print-estimate-totals'), property)).toBe('avoid');
      expect(declared(printRule('.print-estimate-sheet tr'), property)).toBe('avoid');
    }
    // and it does not stand alone on a page: the last line comes over with it
    expect(declared(printRule('.print-estimate-totals'), 'break-before')).toBe('avoid');
    expect(declared(printRule('.print-estimate-sheet thead'), 'display')).toBe(
      'table-header-group'
    );
    // the table may be cut between its lines: it is not asked to stay in one piece
    expect(declared(printRule('.print-estimate-sheet table'), 'break-inside')).not.toBe('avoid');
    expect(declared(printRule('.print-estimate-sheet table'), 'page-break-inside')).not.toBe(
      'avoid'
    );
  });

  it("the print shell: the application's bars are not printed and the shell lets go of the window's height (UI-03)", () => {
    expect(declared(printRule('.app-chrome'), 'display')).toBe('none');
    for (const selector of ['.app-shell', '.app-main-column', '.app-scroll']) {
      const rule = printRule(selector);
      expect(declared(rule, 'height'), selector).toBe('auto');
      expect(declared(rule, 'overflow'), selector).toBe('visible');
    }
    expect(declared(printRule('.app-page'), 'padding')).toBe('0');
  });

  it('the tags flow too: a tag is never cut, and the grid of tags is not asked to fit one page', () => {
    expect(declared(printRule('.print-tag-wrap'), 'break-inside')).toBe('avoid');
    const grid = printRule('.print-tags-grid');
    expect(declared(grid, 'height')).not.toMatch(/mm|px|vh/);
    expect(declared(grid, 'overflow')).not.toBe('hidden');
  });
});

describe('PT-W13 the shell and the pages carry the names the print rules use', () => {
  const text = (file: string) => readFileSync(path.join(SRC, file), 'utf8');
  it('AppLayout marks its shell, its bars and its scrolling parts', () => {
    const layout = text('components/AppLayout.tsx');
    for (const name of ['app-shell', 'app-main-column', 'app-scroll', 'app-page', 'app-chrome'])
      expect(layout, name).toContain(name);
    // the side bar, the top bar, the connection banner and the phone navigation are the four bars
    expect(layout.match(/className="app-chrome/g)!.length).toBe(4);
  });
  it('the estimate sheet and the tag page carry their hooks', () => {
    const estimate = text('app/estimate/components/EstimateViewClient.tsx');
    for (const name of [
      'print-estimate-head',
      'print-estimate-party',
      'print-estimate-lines',
      'print-estimate-totals',
    ])
      expect(estimate, name).toContain(name);
    expect(text('app/print-tags/components/PrintTagsClient.tsx')).toContain('print-tags-grid');
  });
});
