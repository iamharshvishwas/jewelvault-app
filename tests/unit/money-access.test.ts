// Billing, ledger, orders, owner actions, reports and downloads follow the person's ticks (plan: access and roles, Task 20; DESIGN 6.2, ticks M12 to M17, O1 to O3 and R1 to R3). This file holds
// the pure halves, in plain Node, and the screens that can be drawn on the server side of React with the person stood in: the order buttons and the Order Book (`orderActions`,
// `orderBookAccess`), the five owner actions (`ownerActionFlags`), the reason for cash over the limit (`cashReasonFor`) and the tabs of the Reports (`reportsAccess`). The refusal of re-issue
// is in reissue-setup.test.ts, the refusal and the zip of Download everything in download-server.test.ts and download-everything.test.ts, the owner screens in owner-screens.test.ts and the
// browser half in tests/e2e (orders, owner-actions, billing, payments, ledger, hidden-and-download).
//
// The day-one columns below are typed in from what the screens did before the change (they tested the role key: the owner had the five owner actions, the Cancel of a delivered order and the
// Reports; the owner and the biller made orders, moved them along and saw the customer on them; the reason for cash over the limit was the owner's; staff read the list and nothing else), and
// from tests/e2e/orders.spec.ts and owner-actions.spec.ts. They are NOT read from the code under test.
//
// Task 20b (controller ruling T) adds two things here: Re-issue is offered for its tick AND the billing screen its link goes to (`ownerActionFlags`), and the source guard at the end walks EVERY .ts and
// .tsx file under the converted directories (it used to read a hand-written list of 19) and catches a role however it is spelled. The Customer Ledger's money part (`ledgerAccess`) and the links
// of the ledger are in ledger-access.test.ts.
//
// Run: npm test -- tests/unit/money-access.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICK_KEYS, canAccessPath, type TickKey } from '@/lib/access';
import type { OrderRow } from '@/lib/api/types';
import { cashReasonFor } from '@/lib/billing';
import {
  ORDER_CHAIN,
  orderActions,
  orderBookAccess,
  type OrderBookAccess,
} from '@/lib/orderStatus';
import type { OrderView } from '@/lib/orderStore';
import { ownerActionFlags, type OwnerActionFlags } from '@/lib/ownerActions';
import { reportsAccess, type ReportsAccess } from '@/lib/reportsAccess';
import { holderFor, sessionFor, type RoleSpec } from './support/access';
import { customerRow } from './support/money-rows';
import { at, uuid } from './support/rows';
import { sourceText, sourcesUnder } from './support/sources';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const ticks = (...list: TickKey[]): RoleSpec => ({ ticks: list });
/** Every tick but these: the Owner with something taken away. */
const allBut = (...taken: TickKey[]): RoleSpec => ({
  ticks: TICK_KEYS.filter((tick) => !taken.includes(tick)),
});
const SUPER_ADMIN: RoleSpec = { ticks: TICK_KEYS, superAdmin: true };

/** The screens are drawn with the person stood in for the session (the way tests/unit/dashboard-access.test.ts does it). */
async function stoodIn(who: RoleSpec | null): Promise<void> {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => sessionFor(who),
  }));
  vi.doMock('@/lib/businessClock', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/businessClock')>()),
    useBusinessToday: () => '2026-11-15',
  }));
}

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.doUnmock('@/lib/businessClock');
  vi.unstubAllEnvs();
});

// ================================================================================================ the owner's actions

describe("the owner's actions: the three roles of today get what they got", () => {
  const NO_ACTIONS: OwnerActionFlags = {
    cancel: false,
    reissue: false,
    voidPayment: false,
    refund: false,
    openingBalance: false,
  };
  const ACTIONS = Object.keys(NO_ACTIONS) as Array<keyof OwnerActionFlags>;
  const offering = (...names: Array<keyof OwnerActionFlags>): OwnerActionFlags => ({
    ...NO_ACTIONS,
    ...Object.fromEntries(names.map((name) => [name, true])),
  });

  it('the Owner is offered all five: Cancel, Re-issue, Void, Hand Money Back and Opening Balance', () => {
    expect(ownerActionFlags(holderFor('owner'))).toEqual(offering(...ACTIONS));
  });

  it('the Biller is offered none of them', () => {
    expect(ownerActionFlags(holderFor('biller'))).toEqual(NO_ACTIONS);
  });

  it('Staff are offered none of them', () => {
    expect(ownerActionFlags(holderFor('staff'))).toEqual(NO_ACTIONS);
  });

  it('a Super Admin (every tick and the flag) is offered all five, like the Owner', () => {
    expect(ownerActionFlags(holderFor(SUPER_ADMIN))).toEqual(offering(...ACTIONS));
  });

  it('nobody who is not known is offered one', () => {
    expect(ownerActionFlags(null)).toEqual(NO_ACTIONS);
  });

  it('a preview build offers none, the Owner included: there is no server to send them to', () => {
    expect(ownerActionFlags(holderFor('owner'), true)).toEqual(NO_ACTIONS);
    expect(ownerActionFlags(holderFor(SUPER_ADMIN), true)).toEqual(NO_ACTIONS);
  });

  // the tick of each of the five actions
  const OPENS: Partial<Record<TickKey, keyof OwnerActionFlags>> = {
    bill_cancel: 'cancel',
    bill_reissue: 'reissue',
    payment_void: 'voidPayment',
    refund_give: 'refund',
    opening_balance: 'openingBalance',
  };
  // the one action a role with this one tick is offered; every other tick offers none of them on its own. Re-issue is not among them: its link goes to the billing screen, which opens with
  // bill_make, so the tick alone has nowhere to send the person (ruling T of the plan; see below)
  const ALONE: Partial<Record<TickKey, keyof OwnerActionFlags>> = {
    bill_cancel: 'cancel',
    payment_void: 'voidPayment',
    refund_give: 'refund',
    opening_balance: 'openingBalance',
  };

  it.each(TICK_KEYS)(
    'a role that holds only %s is offered exactly what that tick opens',
    (tick) => {
      const only = ALONE[tick];
      expect(ownerActionFlags(holderFor(ticks(tick)))).toEqual(only ? offering(only) : NO_ACTIONS);
    }
  );

  it('the Owner with one of the five ticks taken away has the other four, and no tick but its own opens an action', () => {
    for (const [tick, action] of Object.entries(OPENS) as Array<
      [TickKey, keyof OwnerActionFlags]
    >) {
      const flags = ownerActionFlags(holderFor(allBut(tick)));
      expect(flags[action], tick).toBe(false);
      expect(
        ACTIONS.filter((name) => name !== action).every((name) => flags[name]),
        tick
      ).toBe(true);
    }
  });

  // ruling T: the Re-issue link goes to /billing-pos, which opens only with bill_make (SCREENS of src/lib/access.ts). A role with exactly {bill_reissue, customer_view, bill_view} is a role the API
  // lets Siddhi save, and it was drawn a link to a denied page.
  it('Re-issue is the tick and the billing screen: the tick alone, or with what the API says it needs, offers no link to a screen that is closed', () => {
    expect(canAccessPath(holderFor(ticks('bill_make')), '/billing-pos')).toBe(true);
    expect(ownerActionFlags(holderFor(ticks('bill_reissue'))).reissue).toBe(false);
    expect(
      ownerActionFlags(holderFor(ticks('bill_reissue', 'customer_view', 'bill_view'))).reissue
    ).toBe(false);
    expect(ownerActionFlags(holderFor(ticks('bill_make'))).reissue).toBe(false);
    expect(ownerActionFlags(holderFor(ticks('bill_reissue', 'bill_make'))).reissue).toBe(true);
    expect(
      ownerActionFlags(holderFor(ticks('bill_reissue', 'customer_view', 'bill_view', 'bill_make')))
        .reissue
    ).toBe(true);
  });

  it('the Owner still has all five and the Biller none; the Owner without the billing screen has the other four', () => {
    expect(ownerActionFlags(holderFor('owner'))).toEqual(offering(...ACTIONS));
    expect(ownerActionFlags(holderFor('biller'))).toEqual(NO_ACTIONS);
    expect(ownerActionFlags(holderFor(allBut('bill_make')))).toEqual({
      ...offering(...ACTIONS),
      reissue: false,
    });
  });

  it.each(TICK_KEYS)(
    'Re-issue with %s added: offered only when that is the tick that opens the billing screen',
    (tick) => {
      expect(ownerActionFlags(holderFor(ticks('bill_reissue', tick))).reissue).toBe(
        tick === 'bill_make'
      );
    }
  );

  it('a role with no tick is offered none', () => {
    expect(ownerActionFlags(holderFor(ticks()))).toEqual(NO_ACTIONS);
  });
});

// ================================================================================================ the reason for cash over the limit

describe('the reason for cash over the limit goes with its tick (Z1, M17)', () => {
  const REASON = 'The customer paid the whole wedding order in cash';

  it('the Owner sends what was typed; the Biller and Staff send nothing, whatever is in the box', () => {
    expect(cashReasonFor(holderFor('owner'), REASON)).toBe(REASON);
    expect(cashReasonFor(holderFor('biller'), REASON)).toBe('');
    expect(cashReasonFor(holderFor('staff'), REASON)).toBe('');
  });

  it('a Super Admin sends it, and nobody who is not known does', () => {
    expect(cashReasonFor(holderFor(SUPER_ADMIN), REASON)).toBe(REASON);
    expect(cashReasonFor(null, REASON)).toBe('');
  });

  it('a role with only that tick sends it, and the Owner without it does not', () => {
    expect(cashReasonFor(holderFor(ticks('cash_over_limit')), REASON)).toBe(REASON);
    expect(cashReasonFor(holderFor(allBut('cash_over_limit')), REASON)).toBe('');
  });

  it('no other tick sends it: the Biller holds receive-payments and still sends none', () => {
    for (const tick of TICK_KEYS.filter((key) => key !== 'cash_over_limit'))
      expect(cashReasonFor(holderFor(ticks(tick)), REASON), tick).toBe('');
  });

  it('an empty box stays empty for the one who may give a reason', () => {
    expect(cashReasonFor(holderFor('owner'), '')).toBe('');
  });
});

// ================================================================================================ the buttons of an order

describe('the order buttons: the three roles of today get what they got (F-extra-2)', () => {
  type Buttons = Array<[string, string]>;
  const FORWARD: Record<'open' | 'in_progress' | 'ready', Buttons> = {
    open: [
      ['in_progress', 'Mark In progress'],
      ['cancelled', 'Cancel order'],
    ],
    in_progress: [
      ['ready', 'Mark Ready'],
      ['cancelled', 'Cancel order'],
    ],
    ready: [
      ['delivered', 'Mark Delivered'],
      ['cancelled', 'Cancel order'],
    ],
  };
  // before the change: the owner and the biller got the next step and Cancel; a delivered order was cancelled by the owner alone; a cancelled order had no button; staff had none
  const DAY_ONE: Record<'owner' | 'biller' | 'staff', Record<string, Buttons>> = {
    owner: {
      ...FORWARD,
      delivered: [['cancelled', 'Cancel order']],
      cancelled: [],
    },
    biller: { ...FORWARD, delivered: [], cancelled: [] },
    staff: { open: [], in_progress: [], ready: [], delivered: [], cancelled: [] },
  };
  const STATUSES = Object.keys(ORDER_CHAIN) as Array<keyof typeof ORDER_CHAIN>;

  it.each(['owner', 'biller', 'staff'] as const)(
    '%s: every status has the buttons it had',
    (role) => {
      expect(STATUSES).toHaveLength(5);
      for (const status of STATUSES)
        expect(
          orderActions(status, holderFor(role)).map((a) => [a.to, a.label]),
          `${role} ${status}`
        ).toEqual(DAY_ONE[role][status]);
    }
  );

  it('a Super Admin has the Owner buttons, and nobody who is not known has any', () => {
    for (const status of STATUSES) {
      expect(orderActions(status, holderFor(SUPER_ADMIN)), status).toEqual(
        orderActions(status, holderFor('owner'))
      );
      expect(orderActions(status, null), status).toEqual([]);
    }
  });

  it('a delivered order: the Owner can cancel it, the Biller has no button (it is closed)', () => {
    expect(orderActions('delivered', holderFor('biller'))).toEqual([]);
    expect(orderActions('delivered', holderFor('owner')).map((a) => a.to)).toEqual(['cancelled']);
  });
});

describe('the order buttons: a button follows its tick', () => {
  const STATUSES = Object.keys(ORDER_CHAIN) as Array<keyof typeof ORDER_CHAIN>;
  const buttons = (status: (typeof STATUSES)[number], who: RoleSpec) =>
    orderActions(status, holderFor(who)).map((a) => a.to);

  it.each(TICK_KEYS)(
    'a role that holds only %s is offered a button only with order_edit',
    (tick) => {
      for (const status of STATUSES) {
        if (tick === 'order_edit' && ['open', 'in_progress', 'ready'].includes(status))
          expect(buttons(status, ticks(tick)), status).toHaveLength(2);
        else expect(buttons(status, ticks(tick)), `${tick} ${status}`).toEqual([]);
      }
    }
  );

  it('changing a delivered order needs order_edit and the tick for a closed order: neither alone is enough', () => {
    expect(buttons('delivered', ticks('order_edit', 'order_closed_change'))).toEqual(['cancelled']);
    expect(buttons('delivered', ticks('order_edit'))).toEqual([]);
    expect(buttons('delivered', ticks('order_closed_change'))).toEqual([]);
  });

  it('a cancelled order has no button for anybody: the screen offers no step out of it', () => {
    expect(buttons('cancelled', ticks('order_edit', 'order_closed_change'))).toEqual([]);
    expect(buttons('cancelled', SUPER_ADMIN)).toEqual([]);
  });

  it('the Owner without order_edit has none, and the Owner without the closed-order tick has the Biller buttons', () => {
    for (const status of STATUSES) {
      expect(buttons(status, allBut('order_edit')), status).toEqual([]);
      expect(buttons(status, allBut('order_closed_change')), status).toEqual(
        buttons(status, 'biller')
      );
    }
  });
});

// ================================================================================================ the Order Book

describe('the Order Book: editing and the customer follow their own ticks', () => {
  const NOTHING: OrderBookAccess = { edit: false, customers: false };

  it('the Owner and the Biller make orders and see the customer; Staff do neither (ruling A4, F-extra-1)', () => {
    expect(orderBookAccess(holderFor('owner'))).toEqual({ edit: true, customers: true });
    expect(orderBookAccess(holderFor('biller'))).toEqual({ edit: true, customers: true });
    expect(orderBookAccess(holderFor('staff'))).toEqual(NOTHING);
  });

  it('a Super Admin does both, and nobody who is not known does either', () => {
    expect(orderBookAccess(holderFor(SUPER_ADMIN))).toEqual({ edit: true, customers: true });
    expect(orderBookAccess(null)).toEqual(NOTHING);
  });

  it('making and changing orders is order_edit, and seeing the customer is customer_view, each on its own', () => {
    expect(orderBookAccess(holderFor(ticks('order_edit')))).toEqual({
      edit: true,
      customers: false,
    });
    expect(orderBookAccess(holderFor(ticks('customer_view')))).toEqual({
      edit: false,
      customers: true,
    });
    expect(orderBookAccess(holderFor(ticks('order_view')))).toEqual(NOTHING);
    expect(orderBookAccess(holderFor(ticks()))).toEqual(NOTHING);
    expect(orderBookAccess(holderFor(allBut('order_edit')))).toEqual({
      edit: false,
      customers: true,
    });
    expect(orderBookAccess(holderFor(allBut('customer_view')))).toEqual({
      edit: true,
      customers: false,
    });
  });
});

describe('the Order Book screens: the card and the page are drawn for the person', () => {
  const CUSTOMER = uuid(3001);
  const row = (status: OrderRow['status'] = 'open'): OrderRow => ({
    id: uuid(7001),
    order_no: 'ORD-2026-0001',
    customer_id: CUSTOMER,
    description: 'Gold chain, 22K',
    delivery_date: '2026-11-16',
    status,
    photo_ids: [],
    notes: null,
    created_at: at(0),
    updated_at: at(1),
    created_by: null,
    updated_by: null,
  });
  const view = (status: OrderView['status'] = 'open'): OrderView => ({
    id: uuid(7001),
    orderNo: 'ORD-2026-0001',
    customerId: CUSTOMER,
    customerName: 'Meera Jain',
    customerMobile: '9876500001',
    description: 'Gold chain, 22K',
    deliveryDate: '2026-11-16',
    status,
    statusLabel: status,
    photoIds: [],
    notes: '',
    createdAt: at(0),
    updatedAt: at(1),
  });

  async function drawCard(who: RoleSpec | null, status: OrderView['status'] = 'open') {
    await stoodIn(who);
    const { default: Card } = await import('@/app/order-book/components/OrderCard');
    const { holderOf } = await import('@/lib/useAccess');
    const holder = holderOf(sessionFor(who));
    return renderToStaticMarkup(
      createElement(Card, { order: view(status), holder, today: '2026-11-15' })
    );
  }

  async function drawPage(who: RoleSpec | null) {
    await stoodIn(who);
    const [{ rowCache }, { default: Page }] = await Promise.all([
      import('@/lib/cache/cache'),
      import('@/app/order-book/components/OrderBookClient'),
    ]);
    rowCache.merge('customers', [customerRow(CUSTOMER, { name: 'Meera Jain' })]);
    rowCache.merge('orders', [row()]);
    return renderToStaticMarkup(createElement(Page));
  }

  const hasCustomer = (html: string) => html.includes('data-testid="order-customer"');
  const hasPhotoControl = (html: string) => html.includes('data-testid="order-add-photo"');
  const hasButtons = (html: string) =>
    html.includes('Mark In progress') && html.includes('Cancel order');

  it('the Owner and the Biller: the customer, the photo control and the buttons on an open order', async () => {
    for (const who of ['owner', 'biller'] as const) {
      const html = await drawCard(who);
      expect(hasCustomer(html), who).toBe(true);
      expect(html, who).toContain('Meera Jain');
      expect(hasPhotoControl(html), who).toBe(true);
      expect(hasButtons(html), who).toBe(true);
    }
  });

  it('Staff: the number, the words and the date, and no customer, no photo control, no button', async () => {
    const html = await drawCard('staff');
    expect(html).toContain('ORD-2026-0001');
    expect(html).toContain('Gold chain, 22K');
    expect(hasCustomer(html)).toBe(false);
    expect(html).not.toContain('Meera Jain');
    expect(html).not.toContain('Unknown customer');
    expect(hasPhotoControl(html)).toBe(false);
    expect(html).not.toContain('Mark In progress');
    expect(html).not.toContain('Cancel order');
  });

  it('a delivered order: the Owner can cancel it, the Biller has the card and no button, and neither can add a photo', async () => {
    const owner = await drawCard('owner', 'delivered');
    expect(owner).toContain('Cancel order');
    expect(hasPhotoControl(owner)).toBe(false);
    const biller = await drawCard('biller', 'delivered');
    expect(biller).not.toContain('Cancel order');
    expect(hasPhotoControl(biller)).toBe(false);
    expect(hasCustomer(biller)).toBe(true);
  });

  it('a role with the Order Book and the customers: the customer, and nothing to change', async () => {
    const html = await drawCard(ticks('order_view', 'customer_view'));
    expect(hasCustomer(html)).toBe(true);
    expect(hasPhotoControl(html)).toBe(false);
    expect(html).not.toContain('Mark In progress');
  });

  it('a role with the Order Book and order editing but not the customers: the buttons and the photo control, no customer line and no word of one', async () => {
    const html = await drawCard(ticks('order_view', 'order_edit'));
    expect(hasButtons(html)).toBe(true);
    expect(hasPhotoControl(html)).toBe(true);
    expect(hasCustomer(html)).toBe(false);
    expect(html).not.toContain('Unknown customer');
  });

  it('the page: the Owner and the Biller have New order and the customer in the search; Staff have neither', async () => {
    for (const who of ['owner', 'biller'] as const) {
      const html = await drawPage(who);
      expect(html, who).toContain('New order');
      expect(html, who).toContain('Search by order number, customer or words');
      expect(html, who).toContain('Meera Jain');
    }
    const staff = await drawPage('staff');
    expect(staff).not.toContain('New order');
    expect(staff).toContain('Search by order number or words');
    expect(staff).not.toContain('customer or words');
    expect(staff).toContain('ORD-2026-0001');
    expect(staff).not.toContain('Meera Jain');
  });

  it('the page follows the ticks: the customers alone show the customer and no New order; order editing alone gives New order and no customer', async () => {
    const readers = await drawPage(ticks('order_view', 'customer_view'));
    expect(readers).not.toContain('New order');
    expect(readers).toContain('Meera Jain');
    expect(readers).toContain('customer or words');
    const editors = await drawPage(ticks('order_view', 'order_edit'));
    expect(editors).toContain('New order');
    expect(editors).not.toContain('Meera Jain');
    expect(editors).toContain('Search by order number or words');
  });
});

// ================================================================================================ the Reports

describe('the Reports: a tab is shown for the data it is made from', () => {
  const NO_TABS: ReportsAccess = {
    inventory: false,
    sales: false,
    payments: false,
    jewellery: false,
  };
  const ALL_TABS: ReportsAccess = { inventory: true, sales: true, payments: true, jewellery: true };
  const tabs = (...names: Array<keyof ReportsAccess>): ReportsAccess => ({
    ...NO_TABS,
    ...Object.fromEntries(names.map((name) => [name, true])),
  });

  it('the Owner has the four tabs, and so does a Super Admin', () => {
    expect(reportsAccess(holderFor('owner'))).toEqual(ALL_TABS);
    expect(reportsAccess(holderFor(SUPER_ADMIN))).toEqual(ALL_TABS);
  });

  it('the Biller and Staff cannot open the Reports at all, so no tab of theirs is ever drawn (the screen is Open Reports, which only the Owner holds)', () => {
    expect(canAccessPath(holderFor('owner'), '/reports')).toBe(true);
    expect(canAccessPath(holderFor('biller'), '/reports')).toBe(false);
    expect(canAccessPath(holderFor('staff'), '/reports')).toBe(false);
  });

  it('nobody who is not known has a tab', () => {
    expect(reportsAccess(null)).toEqual(NO_TABS);
  });

  it('the stock tab is for everybody who is signed in (the stock is always on): a role with no tick has it and nothing else', () => {
    expect(reportsAccess(holderFor(ticks()))).toEqual(tabs('inventory'));
  });

  it('the sales and the jewellery metrics are made from the bills, so they need See bills', () => {
    expect(reportsAccess(holderFor(ticks('bill_view')))).toEqual(
      tabs('inventory', 'sales', 'jewellery')
    );
    expect(reportsAccess(holderFor(allBut('bill_view')))).toEqual(tabs('inventory'));
  });

  it('the payments tab is the cash book of the month, what is owed and who owes it: the bills, the customers and the whole cash book, all three', () => {
    const base: TickKey[] = ['bill_view', 'customer_view', 'cashbook_all'];
    expect(reportsAccess(holderFor(ticks(...base))).payments).toBe(true);
    for (const missing of base)
      expect(
        reportsAccess(holderFor(ticks(...base.filter((tick) => tick !== missing)))).payments,
        `without ${missing}`
      ).toBe(false);
    // the cash book of two days is not the month's
    expect(
      reportsAccess(holderFor(ticks('bill_view', 'customer_view', 'cashbook_recent'))).payments
    ).toBe(false);
    expect(reportsAccess(holderFor(allBut('customer_view')))).toEqual(
      tabs('inventory', 'sales', 'jewellery')
    );
    expect(reportsAccess(holderFor(allBut('cashbook_all')))).toEqual(
      tabs('inventory', 'sales', 'jewellery')
    );
  });

  it('only See bills opens a tab by itself: every other single tick leaves the stock tab alone', () => {
    for (const tick of TICK_KEYS.filter((key) => key !== 'bill_view'))
      expect(reportsAccess(holderFor(ticks(tick))), tick).toEqual(tabs('inventory'));
  });
});

describe('the Reports screen: the tabs are drawn for the person', () => {
  async function drawReports(who: RoleSpec | null): Promise<string> {
    await stoodIn(who);
    const { default: Reports } = await import('@/app/reports/components/ReportsClient');
    return renderToStaticMarkup(createElement(Reports));
  }
  const tabsIn = (html: string) =>
    ['Inventory', 'Sales', 'Payments', 'Jewellery Metrics'].filter((label) =>
      html.includes(`>${label}</button>`)
    );

  it('the Owner and a Super Admin have the four tabs, as before', async () => {
    for (const who of ['owner', SUPER_ADMIN] as const)
      expect(tabsIn(await drawReports(who)), JSON.stringify(who)).toEqual([
        'Inventory',
        'Sales',
        'Payments',
        'Jewellery Metrics',
      ]);
  });

  it('a role that may open the Reports and read nothing of the books has the stock tab only, and no figure of money', async () => {
    const html = await drawReports(ticks('reports_open'));
    expect(tabsIn(html)).toEqual(['Inventory']);
    expect(html).toContain('Total Designs');
  });

  it('a role that reads the bills has the stock, sales and jewellery tabs; the customers and the whole cash book add the payments tab', async () => {
    expect(tabsIn(await drawReports(ticks('reports_open', 'bill_view')))).toEqual([
      'Inventory',
      'Sales',
      'Jewellery Metrics',
    ]);
    expect(
      tabsIn(await drawReports(ticks('reports_open', 'bill_view', 'customer_view', 'cashbook_all')))
    ).toEqual(['Inventory', 'Sales', 'Payments', 'Jewellery Metrics']);
  });
});

// ================================================================================================ the screens read no role

describe('the billing, ledger, order, owner-action, report, activity-log and download files read no role key and name no role', () => {
  // EVERY .ts and .tsx under these directories is looked at (they are found by walking them, so the file added next week is looked at at once), and so are the libs that were converted
  const DIRECTORIES = [
    'app/billing-pos',
    'app/customer-ledger',
    'app/order-book',
    'app/reports',
    'app/activity-log',
    'components/owner',
  ];
  const LIBS = [
    'lib/orderStatus.ts',
    'lib/orderStore.ts',
    'lib/billing.ts',
    'lib/payments.ts',
    'lib/reissue.ts',
    'lib/ownerActions.ts',
    'lib/ledgerAccess.ts',
    'lib/ledgerView.ts',
    'lib/reportsAccess.ts',
    'lib/activityLog.ts',
    'lib/downloadEverything.ts',
    'lib/cache/downloadServer.ts',
  ];
  const FILES = [...new Set([...DIRECTORIES.flatMap(sourcesUnder), ...LIBS])].sort();

  /** The names of today's three roles. */
  const ROLE_NAMES = ['owner', 'biller', 'staff'];

  /** A name that reads as a role when it is imported: `ROLE_OWNER`, `OWNER_ROLE`, `AuthRole`, `roles`, or just `OWNER` / `Biller` / `staff`. `useOwnerActions` and `OWNER_ACTIONS` are not roles. */
  function roleLike(name: string): boolean {
    if (ROLE_NAMES.includes(name.toLowerCase())) return true;
    const words = name.split(/[_\s]+|(?<=[a-z0-9])(?=[A-Z])/).map((word) => word.toLowerCase());
    return words.includes('role') || words.includes('roles');
  }

  /** The name a property is written with in a pattern (`role`, `'role'` or `['role']`), or null when it is computed. */
  function propertyNameOf(name: ts.PropertyName | ts.BindingName | undefined): string | null {
    if (name === undefined) return null;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
    if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
      return name.expression.text;
    return null;
  }

  /**
   * What a source text reads from a person's role, however it is spelled:
   *   - a property called `role`: `x.role`, `x?.role`, `x['role']`, `x?.['role']`;
   *   - a role taken out of an object: `const { role } = x`, `const { role: mine } = x`, `({ role }) => ...`;
   *   - the name of one of today's roles as text: a string, a template with nothing in it, a piece of a template;
   *   - an import named like a role (`ROLE_OWNER`, `AuthRole`).
   * A JSX `role="alert"` is an attribute, not a read; comments and the words on screen are not looked at.
   */
  function roleReadsOf(text: string, name: string): string[] {
    const source = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const found: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'role')
        found.push(node.getText(source));
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === 'role'
      )
        found.push(node.getText(source));
      if (
        ts.isBindingElement(node) &&
        ts.isObjectBindingPattern(node.parent) &&
        propertyNameOf(node.propertyName ?? node.name) === 'role'
      )
        found.push(node.getText(source));
      if (ts.isStringLiteralLike(node) && ROLE_NAMES.includes(node.text.trim()))
        found.push(node.getText(source));
      if (ts.isTemplateExpression(node))
        for (const piece of [node.head, ...node.templateSpans.map((span) => span.literal)])
          if (ROLE_NAMES.includes(piece.text.trim())) found.push(`\`${piece.text}\``);
      if (
        ts.isImportSpecifier(node) &&
        [node.name, node.propertyName].some((n) => n && roleLike(n.text))
      )
        found.push(node.getText(source));
      if (ts.isImportClause(node) && node.name && roleLike(node.name.text))
        found.push(node.name.text);
      if (ts.isNamespaceImport(node) && roleLike(node.name.text)) found.push(node.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }
  const roleReads = (file: string): string[] => roleReadsOf(sourceText(file), file);

  it.each(FILES)('%s', (file) => {
    expect(roleReads(file)).toEqual([]);
  });

  it('looks at every file: each directory has some, the deep ones and the ones the old hand-written list left out are among them, and so is every file that list named', () => {
    for (const directory of DIRECTORIES)
      expect(sourcesUnder(directory).length, directory).toBeGreaterThan(0);
    for (const file of [
      'app/reports/components/charts/MonthlySalesChart.tsx', // a subdirectory
      'app/customer-ledger/components/CustomerInvoiceList.tsx', // the old list did not name it
      'app/activity-log/components/ActivityLogClient.tsx',
      'components/owner/OpeningBalancePanel.tsx',
      'lib/ledgerAccess.ts',
    ])
      expect(FILES, file).toContain(file);
    for (const file of [
      'lib/orderStatus.ts',
      'lib/billing.ts',
      'lib/payments.ts',
      'lib/reissue.ts',
      'lib/ownerActions.ts',
      'lib/reportsAccess.ts',
      'lib/downloadEverything.ts',
      'lib/cache/downloadServer.ts',
      'components/owner/useOwnerActions.ts',
      'components/owner/OwnerBillActions.tsx',
      'components/owner/VoidReceiptAction.tsx',
      'app/order-book/components/OrderBookClient.tsx',
      'app/order-book/components/OrderCard.tsx',
      'app/billing-pos/components/BillingPOSClient.tsx',
      'app/billing-pos/components/BillingSummaryPanel.tsx',
      'app/customer-ledger/components/ReceivePaymentPanel.tsx',
      'app/customer-ledger/components/CustomerDetail.tsx',
      'app/customer-ledger/components/CustomerPaymentsTab.tsx',
      'app/reports/components/ReportsClient.tsx',
    ])
      expect(FILES, file).toContain(file);
  });

  it('the checker sees a role when there is one (negative control)', () => {
    expect(roleReadsOf("const mayCancel = session.role === 'owner';", 'x.ts')).toEqual([
      'session.role',
      "'owner'",
    ]);
    expect(roleReadsOf('<p role="alert">Saved</p>;', 'x.tsx')).toEqual([]);
  });

  it("it sees a property called role however it is written: x?.role, x['role'], x?.['role'] and x[`role`]", () => {
    expect(roleReadsOf('const mine = session?.role;', 'x.ts')).toEqual(['session?.role']);
    expect(roleReadsOf("const mine = session['role'];", 'x.ts')).toEqual(["session['role']"]);
    expect(roleReadsOf("const mine = session?.['role'];", 'x.ts')).toEqual(["session?.['role']"]);
    expect(roleReadsOf('const mine = session[`role`];', 'x.ts')).toEqual(['session[`role`]']);
  });

  it('it sees a role taken out of an object: const { role } = x, with another name, with a quoted key, and in the parameters of a component', () => {
    expect(roleReadsOf('const { role } = session;', 'x.ts')).toEqual(['role']);
    expect(roleReadsOf('const { id, role } = session;', 'x.ts')).toEqual(['role']);
    expect(roleReadsOf('const { role: mine, email } = session;', 'x.ts')).toEqual(['role: mine']);
    expect(roleReadsOf("const { 'role': mine } = session;", 'x.ts')).toEqual(["'role': mine"]);
    expect(roleReadsOf("const { ['role']: mine } = session;", 'x.ts')).toEqual(["['role']: mine"]);
    expect(roleReadsOf('function Card({ role }: Props) { return null; }', 'x.tsx')).toEqual([
      'role',
    ]);
    // a local that is called role and holds something else is not a read of the person's role
    expect(roleReadsOf('const { holder: role } = props;', 'x.ts')).toEqual([]);
  });

  it('it sees the name of a role as text: a string, a template with nothing in it, and a piece of a template', () => {
    expect(roleReadsOf("const who = 'biller';", 'x.ts')).toEqual(["'biller'"]);
    expect(roleReadsOf('const who = "staff";', 'x.ts')).toEqual(['"staff"']);
    expect(roleReadsOf('const who = `owner`;', 'x.ts')).toEqual(['`owner`']);
    expect(roleReadsOf('const who = `${prefix}owner`;', 'x.ts')).toEqual(['`owner`']);
    expect(roleReadsOf('const who = `staff${suffix}`;', 'x.ts')).toEqual(['`staff`']);
    expect(roleReadsOf("type Who = 'owner' | 'biller' | 'staff';", 'x.ts')).toEqual([
      "'owner'",
      "'biller'",
      "'staff'",
    ]);
  });

  it('it sees an imported constant named like a role: ROLE_OWNER, with another name, by default, as a namespace, and a type called Role', () => {
    expect(roleReadsOf("import { ROLE_OWNER } from '@/lib/roles';", 'x.ts')).toEqual([
      'ROLE_OWNER',
    ]);
    expect(roleReadsOf("import { ROLE_OWNER as mine } from '@/lib/roles';", 'x.ts')).toEqual([
      'ROLE_OWNER as mine',
    ]);
    expect(roleReadsOf("import { mine as OWNER_ROLE } from '@/lib/roles';", 'x.ts')).toEqual([
      'mine as OWNER_ROLE',
    ]);
    expect(roleReadsOf("import OWNER from '@/lib/roles';", 'x.ts')).toEqual(['OWNER']);
    expect(roleReadsOf("import * as roles from '@/lib/roles';", 'x.ts')).toEqual(['* as roles']);
    expect(roleReadsOf("import type { AuthRole } from '@/lib/authStore';", 'x.ts')).toEqual([
      'AuthRole',
    ]);
  });

  it('and it leaves alone what only sounds like one: the owner actions, the words on screen, a prop called holder', () => {
    expect(roleReadsOf("import { useOwnerActions } from './useOwnerActions';", 'x.ts')).toEqual([]);
    expect(
      roleReadsOf("import { OWNER_ACTIONS, type OwnerAction } from '@/lib/ownerActions';", 'x.ts')
    ).toEqual([]);
    expect(
      roleReadsOf("import OwnerBillActions from '@/components/owner/OwnerBillActions';", 'x.tsx')
    ).toEqual([]);
    expect(
      roleReadsOf('const { holder, status } = props; const mayRefund = owner.refund;', 'x.ts')
    ).toEqual([]);
    expect(roleReadsOf('const words = `Only the owner can ${what}`;', 'x.ts')).toEqual([]);
    expect(roleReadsOf('const words = "The owner enters this payment.";', 'x.ts')).toEqual([]);
    expect(roleReadsOf('// a comment about the owner, the biller and role.owner', 'x.ts')).toEqual(
      []
    );
  });
});

describe('the two panels that take cash send the reason for cash over the limit only through the tick', () => {
  // the panels cannot be driven in plain Node (they save through the network), so their wiring is read from the source; the rule itself is `cashReasonFor` above and the words are billing.test.ts
  // and payments.test.ts; the browser half is tests/e2e/billing.spec.ts and payments.spec.ts
  const SRC = path.resolve(__dirname, '../../src');
  it.each([
    'app/billing-pos/components/BillingSummaryPanel.tsx',
    'app/customer-ledger/components/ReceivePaymentPanel.tsx',
  ])('%s', (file) => {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    expect(source).toContain('cashReasonFor(holder, cashReason)');
    expect(source).not.toMatch(/cashOverrideReason:\s*cashReason\b/);
    expect(source).toMatch(/who: holder/);
    expect(source).toContain('mayGiveReason');
  });
});
