// The Customer Ledger's money part follows `bill_view`, and a link never leads to a screen the person may not open (plan: access and roles, Task 20b, controller ruling T; DESIGN 6.2: "Customer Ledger
// opens with M1 (`customer_view`), its ledger part needs M2 (`bill_view`)"). Before this task the whole card was made from the bills and the balances, so a role that holds the customers and not the
// bills (for example a data-entry role: "Add and edit customers" needs only `customer_view`) opened the screen, read zero for every figure and got "The ledger could not be loaded" on every card.
//
//   - `ledgerAccess` (pure): the screen and the customers' names are `customer_view`, the money part is `bill_view`. The day-one column is typed in from the old behaviour (the owner and the biller opened
//     the screen and drew everything, staff never opened it), and each of the 32 ticks is tried alone.
//   - the ledger call (V3) that a card makes when it opens is made for a person who may read the bills and for nobody else: `startLedgerWatch` over the real store and a fake network, and the wiring of
//     the page read from its source (an effect does not run on the server side of React, where these screens are drawn).
//   - the screens drawn for the person: the page (the total outstanding, Add Customer), the list (a balance beside a name) and the card (figures, the three tabs, the money buttons, the one sentence).
//   - the links: every link the ledger and the owner panels draw is one the person may open (`canAccessPath`), over the three roles, each tick alone and mixed sets; and the four links that exist are named
//     here, so that a fifth cannot be added without being gated and tested.
//
// The owner actions themselves (`ownerActionFlags`) and the source guard are in money-access.test.ts; the browser half is tests/e2e (ledger, payments, owner-actions, billing).
//
// Run: npm test -- tests/unit/ledger-access.test.ts
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICK_KEYS, canAccessPath, type TickKey } from '@/lib/access';
import { ledgerAccess, startLedgerWatch } from '@/lib/ledgerAccess';
import { holderFor, sessionFor, type RoleSpec } from './support/access';
import { fill, id, shop } from './support/money-rows';
import { FakeMoneyApi, ledgerRow } from './support/money-server';
import { sourceText, sourcesUnder } from './support/sources';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/customer-ledger',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const SENTENCE = 'Your role cannot see the money part of the ledger.';

const ticks = (...list: TickKey[]): RoleSpec => ({ ticks: list });
/** Every tick but these: the Owner with something taken away. */
const allBut = (...taken: TickKey[]): RoleSpec => ({
  ticks: TICK_KEYS.filter((tick) => !taken.includes(tick)),
});
const SUPER_ADMIN: RoleSpec = { ticks: TICK_KEYS, superAdmin: true };
/** A data-entry role: it may see customers and add and edit them ("Add and edit customers" needs only "See customers"), and it cannot see a bill. */
const DATA_ENTRY = ticks('customer_view', 'customer_edit');

/** The people the links are tried for: today's three roles, a Super Admin, each tick alone, and the mixed sets that matter. */
const WHO: Array<[string, RoleSpec]> = [
  ['the Owner', 'owner'],
  ['the Biller', 'biller'],
  ['Staff', 'staff'],
  ['a Super Admin', SUPER_ADMIN],
  ...TICK_KEYS.map((tick): [string, RoleSpec] => [`a role with only ${tick}`, ticks(tick)]),
  ['the data-entry role', DATA_ENTRY],
  ['a role that sees the bills', ticks('customer_view', 'bill_view')],
  [
    'a role with Re-issue and what the API says it needs (the role this task is about)',
    ticks('bill_reissue', 'customer_view', 'bill_view'),
  ],
  [
    'the same role with the billing screen',
    ticks('bill_reissue', 'customer_view', 'bill_view', 'bill_make'),
  ],
  ['a role with Cancel and what it needs', ticks('bill_cancel', 'customer_view', 'bill_view')],
  [
    'a role with the bills and the estimate screen',
    ticks('customer_view', 'bill_view', 'bill_make'),
  ],
  ['the Owner without the billing screen', allBut('bill_make')],
  ['the Owner without Re-issue', allBut('bill_reissue')],
];

// ================================================================================================ ledgerAccess

describe('ledgerAccess: the customers follow customer_view and the money part follows bill_view', () => {
  // typed in from the old behaviour: the screen opened for the owner and the biller (the route rule is customer_view) and drew everything for them; staff never opened it
  it.each([
    ['owner', true, true],
    ['biller', true, true],
    ['staff', false, false],
  ] as const)('%s, as before the change: list %s, money %s', (role, list, money) => {
    expect(ledgerAccess(holderFor(role))).toEqual({ list, money });
  });

  it('a Super Admin (every tick and the flag) has both, and nobody who is not signed in has either', () => {
    expect(ledgerAccess(holderFor(SUPER_ADMIN))).toEqual({ list: true, money: true });
    expect(ledgerAccess(null)).toEqual({ list: false, money: false });
  });

  it('a role with only customer_view has the list and no money; a role with only bill_view has the money and no list; a role with neither has neither', () => {
    expect(ledgerAccess(holderFor(ticks('customer_view')))).toEqual({ list: true, money: false });
    expect(ledgerAccess(holderFor(ticks('bill_view')))).toEqual({ list: false, money: true });
    expect(ledgerAccess(holderFor(ticks()))).toEqual({ list: false, money: false });
    expect(ledgerAccess(holderFor(DATA_ENTRY))).toEqual({ list: true, money: false });
  });

  it.each(TICK_KEYS)('a role that holds only %s has exactly what that tick opens', (tick) => {
    expect(ledgerAccess(holderFor(ticks(tick)))).toEqual({
      list: tick === 'customer_view',
      money: tick === 'bill_view',
    });
  });

  it('the Owner with one of the two ticks taken away has the other part, and no other tick takes anything away', () => {
    expect(ledgerAccess(holderFor(allBut('bill_view')))).toEqual({ list: true, money: false });
    expect(ledgerAccess(holderFor(allBut('customer_view')))).toEqual({ list: false, money: true });
    for (const tick of TICK_KEYS.filter((key) => key !== 'bill_view' && key !== 'customer_view'))
      expect(ledgerAccess(holderFor(allBut(tick))), tick).toEqual({ list: true, money: true });
  });

  it('the list is the rule of the route: whoever may open /customer-ledger has it, and nobody else', () => {
    for (const [name, who] of WHO)
      expect(ledgerAccess(holderFor(who)).list, name).toBe(
        canAccessPath(holderFor(who), '/customer-ledger')
      );
  });

  it('a role with bill_view and no customer_view cannot open the screen at all, as before', () => {
    expect(canAccessPath(holderFor(ticks('bill_view')), '/customer-ledger')).toBe(false);
    expect(canAccessPath(holderFor(DATA_ENTRY), '/customer-ledger')).toBe(true);
  });
});

// ================================================================================================ the world

/** Who is signed in while a screen is drawn: the session the screens read is stood in for, and set by each draw. */
const signedIn: { who: RoleSpec | null } = { who: null };

async function load() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const server = new FakeMoneyApi();
  vi.stubGlobal('fetch', server.fetch);
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => sessionFor(signedIn.who),
  }));
  const [cache, app, client, detail, list, invoices, actions] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
    import('@/app/customer-ledger/components/CustomerLedgerClient'),
    import('@/app/customer-ledger/components/CustomerDetail'),
    import('@/app/customer-ledger/components/CustomerList'),
    import('@/app/customer-ledger/components/CustomerInvoiceList'),
    import('@/components/owner/OwnerBillActions'),
  ]);
  const book = shop();
  book.customers[0] = { ...book.customers[0], gst_number: '27AABCU9603R1ZX' };
  fill(cache.rowCache, book);
  const draw = (who: RoleSpec | null, element: Parameters<typeof renderToStaticMarkup>[0]) => {
    signedIn.who = who;
    return renderToStaticMarkup(element);
  };
  const priya = () => {
    const found = app.getCustomers().find((c) => c.id === id.priya);
    if (!found) throw new Error('Priya is not in memory');
    return found;
  };
  return {
    book,
    server,
    app,
    page: (who: RoleSpec | null) => draw(who, createElement(client.default)),
    card: (who: RoleSpec | null) => draw(who, createElement(detail.default, { customer: priya() })),
    list: (who: RoleSpec | null, balances: boolean) =>
      draw(
        who,
        createElement(list.default, {
          customers: app.getCustomers(),
          selectedId: null,
          onSelect: () => undefined,
          balances,
        })
      ),
    invoices: (who: RoleSpec | null, rows = app.getBillsOfCustomer(id.priya).reverse()) =>
      draw(who, createElement(invoices.default, { invoices: rows })),
    billActions: (who: RoleSpec | null, billId: string) =>
      draw(who, createElement(actions.default, { billId })),
    /** The calls that read a customer's ledger (V3). */
    ledgerCalls: () =>
      server.seen.filter(
        (call) =>
          call.method === 'GET' && /^\/v1\/customers\/[0-9a-f-]{36}\/ledger$/.test(call.path)
      ),
  };
}

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  signedIn.who = null;
});

// ================================================================================================ reading the markup and the source

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
const count = (html: string, testId: string): number =>
  (html.match(new RegExp(`data-testid="${testId}"`, 'g')) ?? []).length;
const textOf = (html: string, testId: string): string => {
  const found = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(
    html
  );
  if (!found) throw new Error(`no element has data-testid="${testId}"`);
  return plain(found[2]);
};
const hrefsOf = (html: string): string[] =>
  [...html.matchAll(/href="([^"]*)"/g)].map((match) => decode(match[1]));
/** The tabs of the card that are drawn as buttons. */
const tabsIn = (html: string): string[] =>
  ['Ledger', 'Invoices', 'Payments'].filter((label) =>
    new RegExp(`<button[^>]*>\\s*${label}\\b`).test(html)
  );
const occurrences = (text: string, part: string): number => text.split(part).length - 1;

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(
    file,
    sourceText(file),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

/** Every call of a function by its plain name (`name(...)`, not `x.name(...)`). */
function callsOf(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    )
      found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function mentions(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child) && child.text === name) found = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Is this node on the right of a `&&` whose left side mentions `name`: the way a screen draws a part of itself only for who may see it. */
function guardedBy(node: ts.Node, name: string): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent)
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      parent.right === child &&
      mentions(parent.left, name)
    )
      return true;
  return false;
}

/** The ways a file of the ledger or the owner panels can send a person to another screen: an `href` (an attribute or a property) and a call of `router.push` or `router.replace`. */
function leavesIn(source: ts.SourceFile): number {
  let found = 0;
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(source) === 'href') found += 1;
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      node.name.getText(source) === 'href'
    )
      found += 1;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ['push', 'replace'].includes(node.expression.name.text) &&
      node.expression.expression.getText(source) === 'router'
    )
      found += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

// ================================================================================================ the ledger call

describe("the ledger call: a card reads the customer's ledger only for a person who may read the bills (M2)", () => {
  const NO_ONE_WITH_BILLS: Array<[string, RoleSpec | null]> = [
    ['the data-entry role', DATA_ENTRY],
    ['a role with only customer_view', ticks('customer_view')],
    ['Staff', 'staff'],
    ['nobody who is signed in', null],
  ];

  function recorder() {
    const calls: string[] = [];
    const watch = (customerId: string) => {
      calls.push(`watch ${customerId}`);
      return () => {
        calls.push(`stop ${customerId}`);
      };
    };
    return { calls, watch };
  }

  it('starts the watch for a person who holds bill_view, and gives the way to stop it', () => {
    for (const who of ['owner', 'biller', ticks('bill_view'), SUPER_ADMIN] as const) {
      const { calls, watch } = recorder();
      const stop = startLedgerWatch(holderFor(who), 'customer-1', watch);
      expect(calls, JSON.stringify(who)).toEqual(['watch customer-1']);
      stop?.();
      expect(calls, JSON.stringify(who)).toEqual(['watch customer-1', 'stop customer-1']);
    }
  });

  it('asks for nothing from a person without bill_view: the watch is not started and there is nothing to stop', () => {
    for (const [name, who] of NO_ONE_WITH_BILLS) {
      const { calls, watch } = recorder();
      const stop = startLedgerWatch(who === null ? null : holderFor(who), 'customer-1', watch);
      expect(calls, name).toEqual([]);
      expect(stop, name).toBeUndefined();
    }
  });

  it('over the real store and a fake network: the data-entry role makes no call to the ledger address and the Biller makes one', async () => {
    const w = await load();
    w.server.ledgers.set(id.priya, [ledgerRow(1, id.priya)]);

    const none = startLedgerWatch(holderFor(DATA_ENTRY), id.priya, w.app.watchCustomerLedger);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(none).toBeUndefined();
    expect(w.ledgerCalls()).toEqual([]);

    // the same fake server does see a ledger call when it is made (so the empty list above means something)
    const stop = startLedgerWatch(holderFor('biller'), id.priya, w.app.watchCustomerLedger);
    await vi.waitFor(() => expect(w.ledgerCalls()).toHaveLength(1));
    expect(w.ledgerCalls()[0].path).toBe(`/v1/customers/${id.priya}/ledger`);
    stop?.();
  });

  it('the page reaches the ledger only through that function: it never starts a watch itself, and its one direct read ("Try again") is under the money guard', () => {
    const source = parse('app/customer-ledger/components/CustomerLedgerClient.tsx');
    expect(callsOf(source, 'watchCustomerLedger')).toEqual([]); // it is passed to startLedgerWatch, never called
    expect(callsOf(source, 'startLedgerWatch')).toHaveLength(1);
    const reads = callsOf(source, 'loadLedgerForCustomer');
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(guardedBy(read, 'money'), read.getText(source)).toBe(true);
  });
});

// ================================================================================================ the page

describe('the Customer Ledger page: the total outstanding follows the money part and Add Customer follows customer_edit', () => {
  it('the Owner and the Biller: the number of customers, the total outstanding of the balances, and + Add Customer, as before', async () => {
    const w = await load();
    for (const who of ['owner', 'biller'] as const) {
      const html = w.page(who);
      expect(plain(html), who).toContain('customers · ₹1,32,000 total outstanding');
      expect(textOf(html, 'ledger-total-outstanding'), who).toBe('₹1,32,000');
      expect(plain(html), who).toContain('+ Add Customer');
      expect(plain(html), who).toContain('Click "+ Add Customer" to get started.');
      expect(plain(html), who).not.toContain(SENTENCE);
    }
  });

  it('the data-entry role: the screen and + Add Customer, and no total outstanding (a made-up zero)', async () => {
    const w = await load();
    const html = w.page(DATA_ENTRY);
    expect(plain(html)).toContain('Customer Ledger');
    expect(plain(html)).toContain('0 customers');
    expect(plain(html)).toContain('+ Add Customer');
    expect(count(html, 'ledger-total-outstanding')).toBe(0);
    expect(plain(html)).not.toContain('total outstanding');
    expect(plain(html)).not.toContain('₹');
  });

  it('a role with only customer_view: no Add Customer either, and the empty list does not point at a button that is not there', async () => {
    const w = await load();
    const html = w.page(ticks('customer_view'));
    expect(plain(html)).toContain('Customer Ledger');
    expect(plain(html)).not.toContain('Add Customer');
    expect(plain(html)).toContain('No customers yet.');
    expect(count(html, 'ledger-total-outstanding')).toBe(0);
  });

  it('Add Customer is customer_edit and nothing else, and the total is bill_view and nothing else', async () => {
    const w = await load();
    for (const [name, who] of WHO) {
      const html = w.page(who);
      const holder = holderFor(who);
      if (!ledgerAccess(holder).list) {
        expect(html, name).toBe(''); // the screen is not theirs: the route closes it, and the page draws nothing of its own
        continue;
      }
      expect(plain(html).includes('+ Add Customer'), name).toBe(
        holder.permissions.has('customer_edit')
      );
      expect(count(html, 'ledger-total-outstanding') === 1, name).toBe(
        holder.permissions.has('bill_view')
      );
    }
  });

  it('a role with only bill_view has no screen: the page draws nothing (the route closes it first)', async () => {
    const w = await load();
    expect(w.page(ticks('bill_view'))).toBe('');
    expect(w.page(null)).toBe('');
  });

  // the page cannot be driven further in plain Node (its customers are put in memory by an effect, which does not run on the server side of React), so what it gives the list is read from its source
  it('the page gives the list the money flag, and the list draws a balance only for it', () => {
    const source = sourceText('app/customer-ledger/components/CustomerLedgerClient.tsx');
    expect(source).toContain('const { list, money } = ledgerAccess(holder);');
    expect(source).toContain('balances={money}');
  });
});

// ================================================================================================ the list

describe('the customer list: the names are the customers, the balance beside a name is the money part', () => {
  it('with the money part: the name, the mobile and what the customer owes', async () => {
    const w = await load();
    const html = plain(w.list('biller', true));
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('9876543210');
    expect(html).toContain('₹1,32,000');
  });

  it('without it: the name and the mobile, and no balance', async () => {
    const w = await load();
    const html = plain(w.list(DATA_ENTRY, false));
    expect(html).toContain('Priya Sharma');
    expect(html).toContain('9876543210');
    expect(html).not.toContain('₹');
  });
});

// ================================================================================================ the card

describe('the customer card: the figures, the Ledger, Invoices and Payments tabs and the money buttons are the money part', () => {
  const FIGURES = [
    'cs-purchases',
    'cs-received',
    'cs-outstanding',
    'cs-advance',
    'cs-balance',
    'cs-fine',
    'cs-fine-balance',
    'cs-last',
    'cs-bills',
  ];

  it('the Owner and the Biller: the customer, every figure, the three tabs, Receive Payment and Print, and no sentence, as before', async () => {
    const w = await load();
    for (const who of ['owner', 'biller'] as const) {
      const html = w.card(who);
      expect(plain(html), who).toContain('Priya Sharma');
      for (const figure of FIGURES) expect(count(html, figure), `${who} ${figure}`).toBe(1);
      expect(textOf(html, 'cs-outstanding'), who).toBe('₹1,32,000');
      expect(tabsIn(html), who).toEqual(['Ledger', 'Invoices', 'Payments']);
      expect(plain(html), who).toContain('Receive Payment');
      expect(count(html, 'print-ledger'), who).toBe(1);
      expect(plain(html), who).not.toContain(SENTENCE);
    }
  });

  it('the data-entry role: the customer, and one plain sentence where the money would be; no figure, no tab, no button that takes or gives money', async () => {
    const w = await load();
    const html = w.card(DATA_ENTRY);
    // the customer: name, kind, mobile, e-mail, address and GST are the customer's own row ("See customers")
    for (const part of [
      'Priya Sharma',
      'Retail',
      '9876543210',
      'priya@example.test',
      '12 Johari Bazaar, Jaipur',
      'GST: 27AABCU9603R1ZX',
    ])
      expect(plain(html)).toContain(part);
    // the money part is one sentence
    expect(occurrences(plain(html), SENTENCE)).toBe(1);
    expect(count(html, 'ledger-no-money')).toBe(1);
    expect(textOf(html, 'ledger-no-money')).toBe(SENTENCE);
    expect(html).not.toMatch(/data-testid="cs-/);
    expect(tabsIn(html)).toEqual([]);
    expect(plain(html)).not.toContain('No ledger entries yet');
    expect(plain(html)).not.toContain('No invoices yet');
    expect(plain(html)).not.toContain('Receive Payment');
    expect(plain(html)).not.toContain('Print / Save PDF');
    expect(count(html, 'print-ledger')).toBe(0);
    expect(plain(html)).not.toContain('₹');
  });

  it('a role with money actions but not the bills still gets the sentence and no button: without bill_view there is no money part at all', async () => {
    const w = await load();
    // not a role the API lets Siddhi save (Hand Money Back and Opening Balance need the bills); it proves that the part is cut by the one tick, not by what else the role holds
    const html = w.card(
      ticks('customer_view', 'refund_give', 'opening_balance', 'payment_receive')
    );
    expect(occurrences(plain(html), SENTENCE)).toBe(1);
    expect(count(html, 'open-refund')).toBe(0);
    expect(count(html, 'open-opening')).toBe(0);
    expect(plain(html)).not.toContain('Receive Payment');
    expect(html).not.toMatch(/data-testid="cs-/);
  });

  it('the sentence is for exactly the people without bill_view: every person tried has the figures or the sentence, never both and never neither', async () => {
    const w = await load();
    for (const [name, who] of WHO) {
      const html = w.card(who);
      const money = holderFor(who).permissions.has('bill_view');
      expect(count(html, 'cs-outstanding'), name).toBe(money ? 1 : 0);
      expect(count(html, 'ledger-no-money'), name).toBe(money ? 0 : 1);
    }
  });
});

// ================================================================================================ the links

describe('the links: the ledger and the owner panels draw a link only to a screen the person may open', () => {
  it('a role with Re-issue and what the API says it needs (the bills and the customers) gets no link to the billing screen, which is closed to it, and no link to the estimate', async () => {
    const w = await load();
    const role = ticks('bill_reissue', 'customer_view', 'bill_view');
    expect(canAccessPath(holderFor(role), '/billing-pos')).toBe(false);
    expect(canAccessPath(holderFor(role), '/estimate')).toBe(false);
    const estimate = w.book.by.pending.bill.id;
    expect(w.billActions(role, estimate)).toBe(''); // no Re-issue (its link would be a denied page) and no Cancel (the role has not that tick)
    const list = w.invoices(role);
    expect(count(list, 'invoice-row')).toBe(6); // the bills themselves are there ("See bills")
    expect(count(list, 'reissue-bill')).toBe(0);
    expect(hrefsOf(list)).toEqual([]);
    expect(list).not.toContain('<a ');
    // the number of a bill is still written, as text
    expect(plain(list)).toContain('JV-0004');
    expect(plain(list)).not.toMatch(/\bView\b/);
  });

  it('the same role with the billing screen (make bills) gets the Re-issue link and the links to the estimate', async () => {
    const w = await load();
    const role = ticks('bill_reissue', 'customer_view', 'bill_view', 'bill_make');
    const estimate = w.book.by.pending.bill.id;
    expect(hrefsOf(w.billActions(role, estimate))).toEqual([`/billing-pos?reissue=${estimate}`]);
    const list = w.invoices(role);
    expect(count(list, 'reissue-bill')).toBe(4);
    expect(hrefsOf(list).filter((href) => href.startsWith('/estimate?id='))).toHaveLength(12); // the number and "View" of each of the six
  });

  it('the Owner and the Biller keep every link they had: the numbers and View of six bills, Re-issue on the four live estimates for the Owner only', async () => {
    const w = await load();
    const biller = w.invoices('biller');
    expect(hrefsOf(biller).filter((href) => href.startsWith('/estimate?id='))).toHaveLength(12);
    expect(hrefsOf(biller).filter((href) => href.startsWith('/billing-pos'))).toEqual([]);
    const owner = w.invoices('owner');
    expect(hrefsOf(owner).filter((href) => href.startsWith('/estimate?id='))).toHaveLength(12);
    expect(hrefsOf(owner).filter((href) => href.startsWith('/billing-pos?reissue='))).toHaveLength(
      4
    );
  });

  it('a customer with no bills: "+ New Sale" goes to the billing screen for a role that may open it, and is not drawn for one that may not', async () => {
    const w = await load();
    for (const who of ['owner', 'biller'] as const)
      expect(hrefsOf(w.invoices(who, [])), who).toEqual(['/billing-pos']);
    for (const who of [ticks('customer_view', 'bill_view'), ticks('bill_view'), 'staff'] as const) {
      const html = w.invoices(who, []);
      expect(plain(html), JSON.stringify(who)).toContain('No invoices yet');
      expect(hrefsOf(html), JSON.stringify(who)).toEqual([]);
      expect(plain(html), JSON.stringify(who)).not.toContain('New Sale');
    }
  });

  it('every link drawn is one the person may open (canAccessPath): the invoice list, an empty list and the owner actions of each kind of bill, for every person tried', async () => {
    const w = await load();
    const bills = Object.values(w.book.by).map((entry) => entry.bill.id);
    let drawn = 0;
    for (const [name, who] of WHO) {
      const holder = holderFor(who);
      const hrefs = [
        ...hrefsOf(w.invoices(who)),
        ...hrefsOf(w.invoices(who, [])),
        ...bills.flatMap((bill) => hrefsOf(w.billActions(who, bill))),
      ];
      for (const href of hrefs) expect(canAccessPath(holder, href), `${name}: ${href}`).toBe(true);
      drawn += hrefs.length;
    }
    expect(drawn).toBeGreaterThan(50); // the check is not an empty loop: the roles that may open the screens did draw their links
  });

  it('the ledger and the owner panels have four links, all in two files: a new one has to be gated and added here', () => {
    const found: Record<string, number> = {};
    for (const file of [
      ...sourcesUnder('app/customer-ledger'),
      ...sourcesUnder('components/owner'),
    ]) {
      const links = leavesIn(parse(file));
      if (links > 0) found[file] = links;
    }
    expect(found).toEqual({
      'app/customer-ledger/components/CustomerInvoiceList.tsx': 3, // "+ New Sale", the number of a bill, "View"
      'components/owner/OwnerBillActions.tsx': 1, // Re-issue
    });
  });
});
