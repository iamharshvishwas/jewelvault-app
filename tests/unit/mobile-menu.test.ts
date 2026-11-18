// FB-A1 (Siddhi #1, #2, #3): the phone menu. The ☰ of the top bar used to flip the collapse of the desktop sidebar, which is hidden under 1024 px, so on a phone it did nothing. It now opens the
// same Sidebar as a drawer. This file is the markup half: the drawer variant of Sidebar, with the menu each role is allowed (U5). The browser half (open, close on a link, on Escape and on the
// backdrop, a long menu that scrolls) is tests/e2e/mobile-menu.spec.ts.
// Access and roles (Task 18): the menu follows the person's ticks, so the markup is also drawn for a custom set of ticks and for a Super Admin (People & Roles, the person's line).
//
// Run: npm test -- tests/unit/mobile-menu.test.ts      (or: npm test -- -t PT-FBA1)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import MobileNav from '@/components/MobileNav';
import Sidebar from '@/components/Sidebar';
import type { AuthSession } from '@/lib/authStore';
import { PLAN_TICKS, sessionFor, type RoleSpec } from './support/access';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const noop = () => undefined;
const who = (spec: RoleSpec): AuthSession => ({
  ...(sessionFor(spec).session as AuthSession),
  userId: 'u-test',
  email: 'test@example.test',
  displayName: 'Test Person',
});
const drawer = (spec: RoleSpec) =>
  renderToStaticMarkup(
    createElement(Sidebar, {
      variant: 'drawer',
      collapsed: false,
      onToggle: noop,
      onNavigate: noop,
      session: who(spec),
    })
  );
const sideBar = (spec: RoleSpec) =>
  renderToStaticMarkup(
    createElement(Sidebar, { collapsed: false, onToggle: noop, session: who(spec) })
  );

describe('PT-FBA1 drawer markup', () => {
  it('the owner drawer has a Close menu button and every group and screen of the owner menu', () => {
    const html = drawer('owner');
    expect(html).toContain('aria-label="Close menu"');
    for (const label of [
      'Customers &amp; Ledger',
      'Saved Estimates',
      'Reports',
      'Business Settings',
    ]) {
      expect(html).toContain(label);
    }
  });

  it('the drawer has no collapse button: a phone has nothing to collapse to', () => {
    const html = drawer('owner');
    expect(html).not.toContain('Collapse sidebar');
    expect(html).not.toContain('Expand sidebar');
  });

  it('the staff drawer has no Saved Estimates and no Reports (the same role filter as the desktop sidebar)', () => {
    const html = drawer('staff');
    expect(html).toContain('aria-label="Close menu"');
    expect(html).not.toContain('Saved Estimates');
    expect(html).not.toContain('Reports');
  });

  it('the biller drawer has New Estimate and the ledger and no Settings', () => {
    const html = drawer('biller');
    expect(html).toContain('New Estimate');
    expect(html).toContain('Customers &amp; Ledger');
    expect(html).not.toContain('Settings');
  });

  it('the desktop variant is as it was: a Collapse sidebar button and no Close menu button', () => {
    const html = renderToStaticMarkup(
      createElement(Sidebar, { collapsed: false, onToggle: noop, session: who('owner') })
    );
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).not.toContain('aria-label="Close menu"');
    // the desktop sidebar keeps its starting state: Inventory and Sales open, Settings closed
    expect(html).toContain('Saved Estimates');
    expect(html).not.toContain('Business Settings');
  });
});

// FB-A2: the bottom bar of a phone has an Estimates button for the roles that may open /estimate (the same table as the route gate), and Scan stays the owner's.
const bottomBar = (spec: RoleSpec) =>
  renderToStaticMarkup(createElement(MobileNav, { session: who(spec) }));

describe('PT-FBA2 bottom bar', () => {
  it('the owner has Home, Inventory, Scan, Sale and Estimates, the last one linking to /estimate', () => {
    const html = bottomBar('owner');
    for (const label of ['Home', 'Inventory', 'Scan', 'Sale', 'Estimates']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('href="/estimate"');
  });

  it('the biller has Estimates and no Scan', () => {
    const html = bottomBar('biller');
    expect(html).toContain('>Estimates<');
    expect(html).toContain('href="/estimate"');
    expect(html).not.toContain('>Scan<');
  });

  it('staff have no Estimates (they may not open the screen)', () => {
    const html = bottomBar('staff');
    expect(html).not.toContain('>Estimates<');
    expect(html).not.toContain('href="/estimate"');
  });
});

// FB-F1 (Siddhi #13): the Order Book is in the menu of every role (the side bar, so also the phone drawer) and in the bottom bar of a phone.
describe('FB-F1 Order Book in the menus', () => {
  it.each(['owner', 'biller', 'staff'] as const)(
    'the %s has Order Book in the side bar and the drawer, linking to /order-book',
    (role) => {
      for (const html of [
        drawer(role),
        renderToStaticMarkup(
          createElement(Sidebar, { collapsed: false, onToggle: noop, session: who(role) })
        ),
      ]) {
        expect(html).toContain('>Order Book<');
        expect(html).toContain('href="/order-book"');
      }
    }
  );

  it.each(['owner', 'biller', 'staff'] as const)('the %s has Orders in the bottom bar', (role) => {
    const html = bottomBar(role);
    expect(html).toContain('>Orders<');
    expect(html).toContain('href="/order-book"');
  });
});

// ------------------------------------------------------------------------------------------------ access and roles (Task 18)

const SUPER_ADMIN: RoleSpec = { ticks: PLAN_TICKS, superAdmin: true };
/** A role that holds the Order Book and nothing else (the always-on screens are open to every person who is signed in). */
const ORDER_BOOK_ONLY: RoleSpec = { ticks: ['order_view'], key: 'orders', name: 'Order desk' };
/** A role that makes bills: the sales group is the one to open first. */
const CASHIER: RoleSpec = {
  ticks: ['customer_view', 'bill_view', 'bill_make'],
  key: 'cashier',
  name: 'Cashier',
};

/** The groups of a menu with the state each one is in: the label and whether it is open (aria-expanded). */
function groupsOf(html: string): Array<[string, boolean]> {
  return [
    ...html.matchAll(
      /<button[^>]*aria-expanded="(true|false)"[^>]*>[\s\S]*?<span class="flex-1 text-left font-medium">([^<]*)<\/span>/g
    ),
  ].map((m) => [m[2], m[1] === 'true']);
}
const openGroups = (html: string) =>
  groupsOf(html)
    .filter(([, open]) => open)
    .map(([label]) => label);

describe('Task 18: People & Roles is in the menu of the Super Admin and of nobody else', () => {
  it('the Super Admin has it in the drawer and the side bar, linking to /people-roles', () => {
    for (const html of [drawer(SUPER_ADMIN), sideBar(SUPER_ADMIN)]) {
      expect(html).toContain('>People &amp; Roles<');
      expect(html).toContain('href="/people-roles"');
    }
  });

  it('the Owner, the Biller, Staff and a role with every tick but not the flag do not have it', () => {
    const everyTickNoFlag: RoleSpec = { ticks: PLAN_TICKS };
    for (const spec of ['owner', 'biller', 'staff', everyTickNoFlag] as const)
      for (const html of [drawer(spec), sideBar(spec)]) {
        expect(html).not.toContain('People &amp; Roles');
        expect(html).not.toContain('/people-roles');
      }
  });

  it('the Super Admin keeps every item of the Owner', () => {
    const html = drawer(SUPER_ADMIN);
    for (const label of ['Dashboard', 'Reports', 'Saved Estimates', 'Business Settings'])
      expect(html).toContain(label);
  });
});

describe("Task 18: the person's line says Super Admin for the Super Admin and the name of the role for everybody else", () => {
  const lineOf = (html: string) =>
    /data-testid="session-role"[^>]*>([^<]*)</.exec(html)?.[1] ?? null;

  it('is "Super Admin" for the Super Admin, though the login has the Owner role', () => {
    expect(lineOf(sideBar(SUPER_ADMIN))).toBe('Super Admin');
  });

  it("is the role's name for the Owner, the Biller, Staff and a role of the Super Admin's own", () => {
    expect(lineOf(sideBar('owner'))).toBe('Owner');
    expect(lineOf(sideBar('biller'))).toBe('Biller');
    expect(lineOf(sideBar('staff'))).toBe('Staff');
    expect(lineOf(sideBar(CASHIER))).toBe('Cashier');
  });
});

describe('Task 18: the side bar starts with Inventory and Sales open for a person who makes bills, and Inventory and Stock open for everybody else', () => {
  it('the Owner and the Biller: Inventory and Sales', () => {
    expect(openGroups(sideBar('owner'))).toEqual(['Inventory', 'Sales']);
    expect(openGroups(sideBar('biller'))).toEqual(['Inventory', 'Sales']);
  });

  it('Staff: Inventory and Stock', () => {
    expect(openGroups(sideBar('staff'))).toEqual(['Inventory', 'Stock']);
  });

  it('a role that makes bills (Cashier): Inventory and Sales; a role that holds the Order Book only: Inventory and Stock', () => {
    expect(openGroups(sideBar(CASHIER))).toEqual(['Inventory', 'Sales']);
    expect(openGroups(sideBar(ORDER_BOOK_ONLY))).toEqual(['Inventory', 'Stock']);
  });

  it('the drawer has every group open, whoever it is for', () => {
    for (const spec of ['owner', 'biller', 'staff', CASHIER, ORDER_BOOK_ONLY] as const) {
      const groups = groupsOf(drawer(spec));
      expect(groups.length).toBeGreaterThan(0);
      expect(groups.every(([, open]) => open)).toBe(true);
    }
  });
});

describe('Task 18: the menus offer a person the screens they may open and no other', () => {
  it('a role that holds the Order Book only gets the screens that are open to everybody, and the Order Book', () => {
    const html = drawer(ORDER_BOOK_ONLY);
    for (const label of ['Dashboard', 'Designs', 'Print Tags', 'Stock List', 'Order Book'])
      expect(html).toContain(label);
    for (const label of [
      'New Estimate',
      'Saved Estimates',
      'Customers &amp; Ledger',
      'Receive Payment',
      'Scan Article',
      'Add Design',
      'Edit Stock',
      'Reports',
      'Settings',
      'Activity Log',
    ])
      expect(html, label).not.toContain(label);
    const bar = bottomBar(ORDER_BOOK_ONLY);
    for (const label of ['Home', 'Inventory', 'Orders']) expect(bar).toContain(`>${label}<`);
    for (const label of ['Scan', 'Sale', 'Estimates']) expect(bar).not.toContain(`>${label}<`);
  });

  it('a role that makes bills (Cashier) has Sales and the ledger, and not Reports or Settings; the same drawer for the Biller', () => {
    const html = drawer(CASHIER);
    for (const label of ['New Estimate', 'Saved Estimates', 'Customers &amp; Ledger'])
      expect(html).toContain(label);
    expect(html).not.toContain('Reports');
    expect(html).not.toContain('Settings');
  });
});
