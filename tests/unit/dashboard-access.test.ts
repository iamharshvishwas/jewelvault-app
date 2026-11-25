// The dashboard follows the person's ticks (plan: access and roles, Task 18; DESIGN 6.4: "Dashboard cards show only when their data tick is on"). Each block of the dashboard is shown
// for the tick or ticks of the data it reads and of the action it offers; where the data tick alone would show an owner-only block to the Biller (who holds the data ticks of the
// takings and does not see them today), the analytics tick `reports_open` is asked as well. This file is the pure half, in plain Node: which blocks a person gets (`dashboardAccess`) and
// which quick actions (`quickActionsFor`). The browser half, for the three roles of today, is tests/e2e/dashboard.spec.ts.
//
// The day-one columns below are typed in from what the page did before the change (it tested the role key: the owner got every block, the biller and the owner got the 60-day card, every
// role got the orders card, staff got the short list of quick actions), and from tests/e2e/dashboard.spec.ts and login.spec.ts. They are NOT read from the code under test.
//
// Run: npm test -- tests/unit/dashboard-access.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TICK_KEYS, canAccessPath, type Holder, type TickKey } from '@/lib/access';
import type { OrderRow } from '@/lib/api/types';
import { dashboardAccess, type DashboardAccess } from '@/lib/dashboardAccess';
import QuickActions, { quickActionsFor } from '@/app/components/DashboardQuickActions';
import { holderFor, sessionFor, type RoleSpec } from './support/access';
import { customerRow } from './support/money-rows';
import { at, uuid } from './support/rows';

const NOTHING: DashboardAccess = {
  healthLine: false,
  downloadCard: false,
  rateCard: false,
  ordersPanel: false,
  overduePanel: false,
  eveningCheck: false,
  charts: false,
  activityPanels: false,
  salesTiles: false,
  outstandingTile: false,
  onApprovalTile: false,
};
const BLOCKS = Object.keys(NOTHING) as Array<keyof DashboardAccess>;
const showing = (...names: Array<keyof DashboardAccess>): DashboardAccess => ({
  ...NOTHING,
  ...Object.fromEntries(names.map((name) => [name, true])),
});
const ticks = (...list: TickKey[]): RoleSpec => ({ ticks: list });

describe('the blocks of the dashboard: the three roles of today get what they got', () => {
  it('the Owner gets every block', () => {
    expect(dashboardAccess(holderFor('owner'))).toEqual(showing(...BLOCKS));
  });

  it('the Biller gets the orders card and the 60-day card, and no owner block: no takings, no health line, no rates, no download card', () => {
    expect(dashboardAccess(holderFor('biller'))).toEqual(showing('ordersPanel', 'overduePanel'));
  });

  it('Staff get the orders card and nothing else', () => {
    expect(dashboardAccess(holderFor('staff'))).toEqual(showing('ordersPanel'));
  });

  it('a Super Admin (every tick and the flag) gets every block, like the Owner', () => {
    expect(dashboardAccess(holderFor({ ticks: TICK_KEYS, superAdmin: true }))).toEqual(
      showing(...BLOCKS)
    );
  });

  it('nobody who is not known gets a block', () => {
    expect(dashboardAccess(null)).toEqual(NOTHING);
  });
});

describe('the blocks of the dashboard: a block follows its ticks', () => {
  // the one block a role with this one tick gets; every other tick opens none of them on its own
  const ALONE: Partial<Record<TickKey, keyof DashboardAccess>> = {
    activity_log: 'healthLine',
    download_all: 'downloadCard',
    order_view: 'ordersPanel',
  };

  it.each(TICK_KEYS)('a role that holds only %s gets exactly what that tick opens', (tick) => {
    const only = ALONE[tick];
    expect(dashboardAccess(holderFor(ticks(tick)))).toEqual(only ? showing(only) : NOTHING);
  });

  it('a role with no tick gets nothing: the orders card is for people who may read the orders', () => {
    expect(dashboardAccess(holderFor(ticks()))).toEqual(NOTHING);
  });

  it('the health line is for the Activity Log and health checks, the download card for Download everything', () => {
    expect(dashboardAccess(holderFor(ticks('activity_log'))).healthLine).toBe(true);
    expect(dashboardAccess(holderFor(ticks('download_all'))).downloadCard).toBe(true);
    // the Biller, who has neither tick, gets neither
    expect(dashboardAccess(holderFor('biller'))).toMatchObject({
      healthLine: false,
      downloadCard: false,
    });
  });

  it('the takings (sales tiles, charts) need the bills AND the analytics tick: the Biller reads the bills and does not get them, a Reports tick without bills would show made-up zeros', () => {
    expect(dashboardAccess(holderFor(ticks('bill_view')))).toEqual(NOTHING);
    expect(dashboardAccess(holderFor(ticks('reports_open')))).toEqual(NOTHING);
    expect(dashboardAccess(holderFor(ticks('bill_view', 'reports_open')))).toEqual(
      showing('salesTiles', 'charts')
    );
  });

  it('the Outstanding tile opens the customers ledger and the On Approval tile the billing screen: each needs the tick of that screen as well', () => {
    expect(
      dashboardAccess(holderFor(ticks('bill_view', 'customer_view', 'reports_open')))
    ).toMatchObject({ outstandingTile: true, onApprovalTile: false });
    expect(dashboardAccess(holderFor(ticks('reports_open', 'bill_make')))).toEqual(
      showing('onApprovalTile')
    );
    // the Biller holds the customers and the billing screen and still gets neither tile: the Reports tick is what keeps the Biller's grid as it is
    expect(dashboardAccess(holderFor('biller'))).toMatchObject({
      outstandingTile: false,
      onApprovalTile: false,
    });
  });

  it('the Biller with the Reports tick added gets the takings and the activity panels, and still no evening check, rates or health line', () => {
    const biller: Holder = holderFor('biller');
    const withReports: Holder = {
      permissions: new Set([...biller.permissions, 'reports_open' as TickKey]),
      isSuperAdmin: false,
    };
    expect(dashboardAccess(withReports)).toEqual(
      showing(
        'ordersPanel',
        'overduePanel',
        'salesTiles',
        'outstandingTile',
        'onApprovalTile',
        'charts',
        'activityPanels'
      )
    );
  });

  it('the activity panels name customers: they need the customers and the bills as well as the analytics tick', () => {
    expect(dashboardAccess(holderFor(ticks('reports_open', 'bill_view'))).activityPanels).toBe(
      false
    );
    expect(
      dashboardAccess(holderFor(ticks('reports_open', 'bill_view', 'customer_view'))).activityPanels
    ).toBe(true);
  });

  it('the 60-day card names customers and reads the bills: it needs both ticks', () => {
    expect(dashboardAccess(holderFor(ticks('bill_view'))).overduePanel).toBe(false);
    expect(dashboardAccess(holderFor(ticks('customer_view'))).overduePanel).toBe(false);
    expect(dashboardAccess(holderFor(ticks('bill_view', 'customer_view'))).overduePanel).toBe(true);
  });

  it('the evening check needs the whole cash book and the bills (its outstanding): the Biller reads the cash book of two days and does not get it', () => {
    expect(dashboardAccess(holderFor(ticks('cashbook_all'))).eveningCheck).toBe(false);
    expect(dashboardAccess(holderFor(ticks('cashbook_recent', 'bill_view'))).eveningCheck).toBe(
      false
    );
    expect(dashboardAccess(holderFor(ticks('cashbook_all', 'bill_view'))).eveningCheck).toBe(true);
  });

  it("the rate card is the owner's rate board: it needs to enter and to correct a rate. The Biller enters today's rate and does so on the billing screen, so it does not get the card", () => {
    expect(dashboardAccess(holderFor(ticks('rate_enter'))).rateCard).toBe(false);
    expect(dashboardAccess(holderFor(ticks('rate_correct'))).rateCard).toBe(false);
    expect(dashboardAccess(holderFor(ticks('rate_enter', 'back_date'))).rateCard).toBe(false);
    expect(dashboardAccess(holderFor(ticks('rate_enter', 'rate_correct'))).rateCard).toBe(true);
  });
});

// ================================================================================================ the quick actions

const SALES_DESK = [
  ['Add Design', '/inventory-management'],
  ['Scan Article', '/billing-pos'],
  ['New Sale', '/billing-pos'],
  ['Print Tags', '/print-tags'],
  ['Stock Audit', '/inventory-management'],
  ['Receive Payment', '/customer-ledger'],
];
const STOCK_ROOM = [
  ['Inventory', '/inventory-management'],
  ['Add Design', '/add-design'],
  ['Edit Stock', '/edit-stock'],
  ['Print Tags', '/print-tags'],
];
const tiles = (who: Holder | null) => quickActionsFor(who).map((a) => [a.label, a.href]);
const BILLING_TILES = ['qa-scan', 'qa-new-sale', 'qa-payment'];

describe('the quick actions: the three roles of today get the lists they got', () => {
  it('the Owner and the Biller get the six actions of the sales desk, in their order', () => {
    expect(tiles(holderFor('owner'))).toEqual(SALES_DESK);
    expect(tiles(holderFor('biller'))).toEqual(SALES_DESK);
  });

  it('Staff get the four of the stock room', () => {
    expect(tiles(holderFor('staff'))).toEqual(STOCK_ROOM);
  });

  it('a Super Admin gets the sales desk, like the Owner', () => {
    expect(tiles(holderFor({ ticks: TICK_KEYS, superAdmin: true }))).toEqual(SALES_DESK);
  });

  it('nobody who is not known gets an action', () => {
    expect(quickActionsFor(null)).toEqual([]);
  });
});

describe('the quick actions: an action is offered for the tick of what it does', () => {
  const ids = (who: Holder) => quickActionsFor(who).map((a) => a.id);

  it('a person with only the Order Book gets none of the billing items, nor any action that needs a tick: the two screens that are open to everybody', () => {
    const list = ids(holderFor(ticks('order_view')));
    for (const billing of BILLING_TILES) expect(list).not.toContain(billing);
    expect(list).toEqual(['qa-inventory', 'qa-print-tags']);
  });

  it('a person who makes bills and takes no payment gets no Receive Payment', () => {
    const list = ids(holderFor(ticks('customer_view', 'bill_view', 'bill_make')));
    expect(list).toContain('qa-new-sale');
    expect(list).toContain('qa-scan');
    expect(list).not.toContain('qa-payment');
  });

  it('a person who takes payments and makes no bills works the sales desk too: Receive Payment, and not New Sale or Scan Article', () => {
    const list = ids(holderFor(ticks('customer_view', 'bill_view', 'payment_receive')));
    expect(list).toContain('qa-payment');
    expect(list).not.toContain('qa-new-sale');
    expect(list).not.toContain('qa-scan');
    // and the stock room's tiles are not theirs
    expect(list).not.toContain('qa-inventory');
    expect(list).not.toContain('qa-edit-stock');
  });

  it('a person who may add designs and not edit stock gets Add Design (the screen) and no Edit Stock; one who may edit stock and not add designs gets the reverse', () => {
    expect(tiles(holderFor(ticks('stock_add')))).toEqual([
      ['Inventory', '/inventory-management'],
      ['Add Design', '/add-design'],
      ['Print Tags', '/print-tags'],
    ]);
    expect(tiles(holderFor(ticks('stock_edit')))).toEqual([
      ['Inventory', '/inventory-management'],
      ['Edit Stock', '/edit-stock'],
      ['Print Tags', '/print-tags'],
    ]);
  });

  it('an action never sends a person to a screen that is closed to them: the three roles, each tick alone, and a few mixed sets', () => {
    const holders: Holder[] = [
      holderFor('owner'),
      holderFor('biller'),
      holderFor('staff'),
      ...TICK_KEYS.map((tick) => holderFor(ticks(tick))),
      holderFor(ticks('bill_make', 'stock_add')),
      holderFor(ticks('payment_receive', 'stock_edit', 'order_view')),
      holderFor(ticks('customer_view', 'bill_view', 'payment_receive')),
    ];
    for (const holder of holders)
      for (const action of quickActionsFor(holder))
        expect(
          canAccessPath(holder, action.href),
          `${action.id} for ${[...holder.permissions]}`
        ).toBe(true);
  });
});

describe('the quick actions as drawn: the component draws the list of the holder it is given', () => {
  const draw = (holder: Holder | null) =>
    renderToStaticMarkup(createElement(QuickActions, { holder }));
  const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

  it('draws the links of the sales desk for the Owner and the Biller, the stock room for Staff, nothing before the person is known', () => {
    const salesLinks = SALES_DESK.map(([, href]) => href);
    expect(hrefs(draw(holderFor('owner')))).toEqual(salesLinks);
    expect(hrefs(draw(holderFor('biller')))).toEqual(salesLinks);
    expect(hrefs(draw(holderFor('staff')))).toEqual(STOCK_ROOM.map(([, href]) => href));
    expect(hrefs(draw(null))).toEqual([]);
  });

  it('writes the label of each action', () => {
    const html = draw(holderFor('staff'));
    for (const [label] of STOCK_ROOM) expect(html).toContain(`>${label}<`);
    expect(html).not.toContain('>New Sale<');
  });
});

// ================================================================================================ the orders card

// "Orders due" is mounted for whoever reads the orders; the customer on a row is a second tick. The card is drawn here over the real stores with the Asia/Kolkata day fixed (it says nothing on
// the server without a day), the session being the one thing stood in for.
describe('the orders card: the customer is named for the person who may see customers', () => {
  const TODAY = '2026-11-15';
  const CUSTOMER = uuid(7002);

  afterEach(() => {
    vi.doUnmock('@/lib/authStore');
    vi.doUnmock('@/lib/businessClock');
    vi.unstubAllEnvs();
  });

  const order: OrderRow = {
    id: uuid(7001),
    order_no: 'ORD-2026-0001',
    customer_id: CUSTOMER,
    description: 'Gold chain, 22K',
    delivery_date: '2026-11-16',
    status: 'open',
    photo_ids: [],
    notes: null,
    created_at: at(0),
    updated_at: at(1),
    created_by: null,
    updated_by: null,
  };

  async function draw(who: RoleSpec | null): Promise<string> {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
    vi.doMock('@/lib/authStore', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/authStore')>()),
      useSession: () => sessionFor(who),
    }));
    vi.doMock('@/lib/businessClock', async (importOriginal) => ({
      ...(await importOriginal<typeof import('@/lib/businessClock')>()),
      useBusinessToday: () => TODAY,
    }));
    const [{ rowCache }, { default: Panel }] = await Promise.all([
      import('@/lib/cache/cache'),
      import('@/app/components/DashboardOrdersPanel'),
    ]);
    rowCache.merge('customers', [customerRow(CUSTOMER, { name: 'Meera Jain' })]);
    rowCache.merge('orders', [order]);
    return renderToStaticMarkup(createElement(Panel));
  }

  it('the Owner and the Biller see the order and the customer', async () => {
    for (const who of ['owner', 'biller'] as const) {
      const html = await draw(who);
      expect(html, who).toContain('data-testid="orders-due-row"');
      expect(html, who).toContain('ORD-2026-0001');
      expect(html, who).toContain('Meera Jain');
    }
  });

  it('Staff see the order and no customer, and no word about one', async () => {
    const html = await draw('staff');
    expect(html).toContain('ORD-2026-0001');
    expect(html).toContain('Gold chain, 22K');
    expect(html).not.toContain('Meera Jain');
    expect(html).not.toContain('Unknown customer');
  });

  it('a role follows the tick: the Order Book alone shows no customer, with the customers it does', async () => {
    const without = await draw({ ticks: ['order_view'] });
    expect(without).toContain('ORD-2026-0001');
    expect(without).not.toContain('Meera Jain');
    const withCustomers = await draw({ ticks: ['order_view', 'customer_view'] });
    expect(withCustomers).toContain('Meera Jain');
  });
});

// ================================================================================================ the page

describe('the page: each block is mounted for its tick and no role is tested', () => {
  const page = readFileSync(path.resolve(__dirname, '../../src/app/page.tsx'), 'utf8');

  it.each([
    ['healthLine', 'DashboardHealthLine'],
    ['downloadCard', 'DashboardDownloadCard'],
    ['rateCard', 'DashboardRateCard'],
    ['ordersPanel', 'DashboardOrdersPanel'],
    ['overduePanel', 'DashboardOverduePanel'],
    ['eveningCheck', 'DashboardEveningCheck'],
    ['charts', 'DashboardCharts'],
    ['activityPanels', 'DashboardActivityPanels'],
  ])('%s mounts %s, and only that', (flag, card) => {
    expect(page).toContain(`{show.${flag} && <${card} />}`);
  });

  it('the quick actions and the KPI grid are given the holder and decide for themselves; the recent designs are for everybody', () => {
    expect(page).toContain('<DashboardQuickActions holder={holder} />');
    expect(page).toContain('<DashboardKpiGrid holder={holder} />');
    expect(page).toContain('<RecentDesignsGrid />');
  });

  it("the page names no role: it does not test the session's role key", () => {
    expect(page).not.toMatch(/'(owner|biller|staff)'/);
    expect(page).not.toMatch(/session\??\.role/);
  });
});
