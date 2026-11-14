// FB-A1 (Siddhi #1, #2, #3): the phone menu. The ☰ of the top bar used to flip the collapse of the desktop sidebar, which is hidden under 1024 px, so on a phone it did nothing. It now opens the
// same Sidebar as a drawer. This file is the markup half: the drawer variant of Sidebar, with the menu each role is allowed (U5). The browser half (open, close on a link, on Escape and on the
// backdrop, a long menu that scrolls) is tests/e2e/mobile-menu.spec.ts.
//
// Run: npm test -- tests/unit/mobile-menu.test.ts      (or: npm test -- -t PT-FBA1)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from '@/components/Sidebar';
import type { AuthRole, AuthSession } from '@/lib/authStore';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

const noop = () => undefined;
const who = (role: AuthRole): AuthSession => ({
  userId: `u-${role}`,
  email: `${role}@example.test`,
  displayName: 'Test Person',
  role,
  mustChangePassword: false,
});
const drawer = (role: AuthRole) =>
  renderToStaticMarkup(
    createElement(Sidebar, {
      variant: 'drawer',
      collapsed: false,
      onToggle: noop,
      onNavigate: noop,
      session: who(role),
    })
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
