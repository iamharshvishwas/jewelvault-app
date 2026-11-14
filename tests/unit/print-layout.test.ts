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
import { FakeMoneyApi, ledgerRow, type LedgerWireRow } from './support/money-server';

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
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
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
    // the side bar, the top bar, the connection banner, the phone navigation and the preview note are all bars
    expect(layout.match(/app-chrome/g)!.length).toBeGreaterThanOrEqual(5);
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

// ================================================================================================ FB-D1: the ledger on paper

// FB-D1 (Siddhi #4): one customer's ledger prints, or is saved as a PDF, from the customer card. The sheet is the shop's header (the Settings' `business`), the customer, the day it was printed
// (Asia/Kolkata), the rows of V3 as the server sent them, and four totals; the application around it is not printed. Where Chromium cuts the pages is checked by tests/e2e/print.spec.ts.

const LEDGER_CUSTOMER = uuid(5401);
const LEDGER_DAY = '2026-11-14';

/** Meera's ledger: a bill of 9,000.00 with 6.000 g of silver due, a part payment of 2,500.00 and 2.500 g of silver. The running balances are the server's (hand-worked here). */
function ledgerRows(): LedgerWireRow[] {
  const row = (n: number, over: Partial<LedgerWireRow>) =>
    ledgerRow(n, LEDGER_CUSTOMER, { entry_at: at(400 + n), ...over });
  return [
    row(1, {
      kind: 'Invoice',
      entry_date: '2026-10-15',
      description: 'Invoice JV-0021',
      debit: '9000.00',
      fine_debit: '6.000',
      balance: '9000.00',
      fine_balance: '6.000',
    }),
    row(2, {
      kind: 'Payment',
      kind_rank: 3,
      entry_date: '2026-10-16',
      description: 'Payment (Cash)',
      debit: '0.00',
      credit: '2500.00',
      balance: '6500.00',
      fine_balance: '6.000',
    }),
    row(3, {
      kind: 'Fine',
      kind_rank: 3,
      entry_date: '2026-10-17',
      description: 'Silver received 2.500 g',
      debit: '0.00',
      fine_credit: '2.500',
      balance: '6500.00',
      fine_balance: '3.500',
    }),
  ];
}

async function ledgerWorld(
  entries: LedgerWireRow[],
  business: Record<string, unknown> | null,
  { today = LEDGER_DAY }: { today?: string } = {}
) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.doMock('@/lib/businessClock', () => ({ useBusinessToday: () => today }));
  const server = new FakeMoneyApi();
  vi.stubGlobal('fetch', server.fetch);
  server.ledgers.set(LEDGER_CUSTOMER, entries);
  const [react, dom, cache, app, detail, sheet] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
    import('@/app/customer-ledger/components/CustomerDetail'),
    import('@/app/customer-ledger/components/CustomerLedgerPrint'),
  ]);
  const book = {
    ...shop(),
    customers: [customerRow(LEDGER_CUSTOMER, { name: 'Meera Jain', mobile: '9000100001' })],
    balances: [],
    bills: [],
    summaries: [],
    items: [],
    receipts: [],
    allocations: [],
  };
  fill(cache.rowCache, book as never);
  if (business)
    (cache.rowCache.merge as (r: never, rows: never) => number)(
      'settings' as never,
      [businessRow(business)] as never
    );
  await app.loadLedgerForCustomer(LEDGER_CUSTOMER);
  const customer = app.getCustomers().find((c) => c.id === LEDGER_CUSTOMER)!;
  return {
    // the print sheet as it is drawn while something is printing (the card draws it only then: Wave 2 fix 1)
    html: dom.renderToStaticMarkup(
      react.createElement(sheet.default, {
        customer,
        entries: app.getLedgerForCustomer(LEDGER_CUSTOMER),
      })
    ),
    // the customer card as it is drawn on the screen, with nothing printing
    card: dom.renderToStaticMarkup(react.createElement(detail.default, { customer })),
  };
}

/** The cells of every `<tr data-testid=...>` as plain text. */
const rowsOf = (html: string, testId: string): string[][] =>
  [...html.matchAll(new RegExp(`<tr[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</tr>`, 'g'))].map(
    (row) => [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => plain(cell[1]))
  );

describe('FB-D1 the ledger sheet on the customer card', () => {
  it('has a Print / Save PDF button that asks the browser to print', async () => {
    const w = await ledgerWorld(ledgerRows(), null);
    expect(w.card).toMatch(
      /<button[^>]*>(?:<svg[\s\S]*?<\/svg>)?\s*Print \/ Save PDF\s*<\/button>/
    );
    const source = readFileSync(
      path.join(SRC, 'app/customer-ledger/components/CustomerDetail.tsx'),
      'utf8'
    );
    expect(source).toContain('window.print()');
  });

  // Wave 2 fix 1: the sheet is a second copy of the whole ledger, so the card draws it only while something is printing (the button, or the browser's own print at `beforeprint`, switches it on and
  // `afterprint` off: that is looked at in the page, in tests/e2e/print.spec.ts).
  it('the card on the screen does not hold the print sheet: nothing of it is drawn until something prints', async () => {
    const w = await ledgerWorld(ledgerRows(), null);
    expect(w.card).toContain('data-testid="ledger-row"');
    expect(w.card).not.toContain('ledger-print-sheet');
    expect(w.card).not.toContain('ledger-print-row');
    const empty = await ledgerWorld([], null);
    expect(empty.card).not.toContain('ledger-print-');
  });

  it("the shop's name, address and phone on the sheet are the Settings' (a blank one prints nothing)", async () => {
    const w = await ledgerWorld(ledgerRows(), {
      legalName: 'Test Jewellers Pvt Ltd',
      address: '12 Sarafa Bazaar\nUjjain 456006',
      phone: '+91 99999 13013',
    });
    expect(textOf(w.html, 'ledger-print-shop-name')).toBe('Test Jewellers Pvt Ltd');
    expect(textOf(w.html, 'ledger-print-shop-address')).toBe('12 Sarafa Bazaar Ujjain 456006');
    expect(w.html).toMatch(
      /data-testid="ledger-print-shop-address"[^>]*class="[^"]*whitespace-pre-line/
    );
    expect(textOf(w.html, 'ledger-print-shop-phone')).toContain('+91 99999 13013');
    const blank = await ledgerWorld(ledgerRows(), {
      legalName: ' ',
      address: '',
      phone: '  ',
    });
    expect(textOf(blank.html, 'ledger-print-shop-name')).toBe('Jaishri Gold Palace Pvt Ltd');
    expect(blank.html).not.toContain('ledger-print-shop-address');
    expect(blank.html).not.toContain('ledger-print-shop-phone');
  });

  it('names the customer, their mobile and the day it was printed (Asia/Kolkata), as text', async () => {
    const w = await ledgerWorld(ledgerRows(), null);
    expect(textOf(w.html, 'ledger-print-customer')).toBe('Meera Jain');
    expect(textOf(w.html, 'ledger-print-mobile')).toBe('9000100001');
    expect(textOf(w.html, 'ledger-print-asof')).toBe('As of 14/11/2026');
  });

  it("prints every row of V3 as the server sent it, in its order, with the server's running balances", async () => {
    const w = await ledgerWorld(ledgerRows(), null);
    const rows = rowsOf(w.html, 'ledger-print-row');
    expect(rows).toHaveLength(3);
    // Date, Type, Description, Reference, Debit, Credit, Balance, Fine In, Fine Out, Fine Balance
    expect(rows[0]).toEqual([
      '15/10/2026',
      'Invoice',
      'Invoice JV-0021',
      '',
      '₹9,000',
      '—',
      '₹9,000',
      '6.000 g',
      '-',
      '6.000 g',
    ]);
    expect(rows[1].slice(0, 3)).toEqual(['16/10/2026', 'Payment', 'Payment (Cash)']);
    expect(rows[1].slice(4)).toEqual(['—', '₹2,500', '₹6,500', '-', '-', '6.000 g']);
    expect(rows[2].slice(4)).toEqual(['—', '—', '₹6,500', '-', '2.500 g', '3.500 g']);
  });

  it('a long description is printed whole, never cut with an ellipsis', async () => {
    const long = 'Invoice JV-0021 with a very long note that must not be cut short on the paper';
    const entries = ledgerRows();
    entries[0] = { ...entries[0], description: long };
    const w = await ledgerWorld(entries, null);
    expect(rowsOf(w.html, 'ledger-print-row')[0][2]).toBe(long);
    expect(w.html).not.toMatch(/data-testid="ledger-print-row"[\s\S]*?truncate/);
  });

  it('has the four totals: debit, credit, the balance and the silver balance (the last row of V3)', async () => {
    const w = await ledgerWorld(ledgerRows(), null);
    expect(textOf(w.html, 'ledger-print-total-debit')).toBe('₹9,000');
    expect(textOf(w.html, 'ledger-print-total-credit')).toBe('₹2,500');
    expect(textOf(w.html, 'ledger-print-total-balance')).toBe('₹6,500');
    expect(textOf(w.html, 'ledger-print-total-fine-balance')).toBe('3.500 g');
    // the labels are the words the paper shows
    const totals = plain(/data-testid="ledger-print-totals"[\s\S]*$/.exec(w.html)?.[0] ?? '');
    expect(totals).toContain('Total Debit');
    expect(totals).toContain('Total Credit');
    expect(totals).toMatch(/Balance\s+₹6,500/);
    expect(totals).toContain('Silver Fine Balance');
  });

  it('a customer who holds an advance prints it in words, not as a minus', async () => {
    const entries: LedgerWireRow[] = [
      ledgerRow(9, LEDGER_CUSTOMER, {
        kind: 'Opening advance',
        kind_rank: 3,
        description: 'Opening advance (Other)',
        debit: '0.00',
        credit: '5000.00',
        balance: '-5000.00',
      }),
    ];
    const w = await ledgerWorld(entries, null);
    expect(textOf(w.html, 'ledger-print-total-balance')).toBe('₹5,000 advance');
  });

  it('a customer with no entries prints the header and a line saying so, with no totals', async () => {
    const w = await ledgerWorld([], null);
    expect(textOf(w.html, 'ledger-print-customer')).toBe('Meera Jain');
    expect(w.html).toContain('data-testid="ledger-print-empty"');
    expect(w.html).not.toContain('ledger-print-totals');
  });

  it('a value of the Settings is text on the paper, never markup', async () => {
    const w = await ledgerWorld(ledgerRows(), { legalName: '<img src=x onerror=alert(1)>' });
    expect(w.html).not.toContain('<img src=x');
  });
});

describe('FB-D1 the print rules of the ledger sheet', () => {
  it('the sheet flows: no fixed height, no clipping, no position of its own', () => {
    const rule = printRule('.print-ledger-sheet');
    expect(declared(rule, 'max-height')).toBe('none');
    expect(declared(rule, 'min-height')).toBe('0');
    expect(declared(rule, 'height')).toBe('auto');
    expect(declared(rule, 'overflow')).toBe('visible');
    expect(declared(rule, 'position')).toBe('static');
  });

  it('a row is never cut, the header row comes back on every page, the totals are kept whole and not alone', () => {
    for (const property of ['break-inside', 'page-break-inside']) {
      expect(declared(printRule('.print-ledger-sheet tr'), property)).toBe('avoid');
      expect(declared(printRule('.print-ledger-totals'), property)).toBe('avoid');
    }
    expect(declared(printRule('.print-ledger-totals'), 'break-before')).toBe('avoid');
    expect(declared(printRule('.print-ledger-sheet thead'), 'display')).toBe('table-header-group');
    // the table itself may be cut between its rows
    expect(declared(printRule('.print-ledger-sheet table'), 'break-inside')).not.toBe('avoid');
  });

  it('on paper the card shows its sheet and nothing else; the page around the card is not printed', () => {
    const rule = printRule(
      '.ledger-card-root:has(> .print-ledger-sheet) > :not(.print-ledger-sheet)'
    );
    expect(declared(rule, 'display')).toBe('none');
    // the card hides its parts only when its sheet is in the page (Wave 2 fix 1: the sheet is drawn only while printing); a print with no sheet comes out as the card, never blank
    expect(() => printRule('.ledger-card-root > :not(.print-ledger-sheet)')).toThrow();
    const source = readFileSync(
      path.join(SRC, 'app/customer-ledger/components/CustomerLedgerClient.tsx'),
      'utf8'
    );
    expect(source.match(/print:hidden/g)!.length).toBeGreaterThanOrEqual(2);
    const detail = readFileSync(
      path.join(SRC, 'app/customer-ledger/components/CustomerDetail.tsx'),
      'utf8'
    );
    expect(detail).toContain('ledger-card-root');
  });
});

// ================================================================================================ FB-D2: the catalogue on paper

describe('FB-D2 the print rules of the stock catalogue sheet', () => {
  it('the sheet flows like the estimate: no fixed height, no clipping, no position of its own', () => {
    const rule = printRule('.print-catalogue-sheet');
    expect(declared(rule, 'max-height')).toBe('none');
    expect(declared(rule, 'min-height')).toBe('0');
    expect(declared(rule, 'height')).toBe('auto');
    expect(declared(rule, 'overflow')).toBe('visible');
    expect(declared(rule, 'position')).toBe('static');
  });

  it('a card is never cut, a category name is never left alone at the foot of a page, three cards go across the A4 paper', () => {
    for (const property of ['break-inside', 'page-break-inside']) {
      expect(declared(printRule('.print-catalogue-card'), property)).toBe('avoid');
    }
    expect(declared(printRule('.print-catalogue-category h3'), 'break-after')).toBe('avoid');
    expect(declared(printRule('.print-catalogue-grid'), 'grid-template-columns')).toBe(
      'repeat(3, minmax(0, 1fr))'
    );
  });

  it('the screen carries the names the print rules use', () => {
    const screen = readFileSync(
      path.join(SRC, 'app/stock-catalogue/components/StockCatalogueClient.tsx'),
      'utf8'
    );
    for (const name of [
      'print-catalogue-sheet',
      'print-catalogue-grid',
      'print-catalogue-card',
      'print-catalogue-category',
    ])
      expect(screen, name).toContain(name);
    // the controls are not printed
    expect(screen.match(/print:hidden/g)!.length).toBeGreaterThanOrEqual(2);
  });
});
