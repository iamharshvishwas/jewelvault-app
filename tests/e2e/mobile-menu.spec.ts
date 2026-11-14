import { expect, test, type Locator, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';

// FB-A1 (Siddhi's phone list #1, #2, #3): the ☰ of the top bar was dead on a phone. Under 1024 px it now opens the same Sidebar as a drawer, in a real browser at 375 x 812 against the
// real API of a lane.
//   - the owner taps Open menu: a dialog named Menu appears with the whole owner menu; a tap on Saved Estimates goes to /estimate and the drawer is gone;
//   - Escape closes it; a tap on the dark backdrop closes it;
//   - a long menu: every group open, the last Settings link (Business Settings) is reached by scrolling the drawer and a tap on it opens /settings?tab=business (the drawer is not stuck
//     behind or in front of anything that would eat the tap); once it has closed, the Sale button of the bottom bar is tappable;
//   - a biller's drawer has New Estimate and Customers & Ledger and no Settings;
//   - from 1280 px up there is no ☰, and the sidebar is the desktop one.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/mobile-menu.spec.ts

const owner = e2eLogin('owner');
const biller = e2eLogin('biller');

test.use({ viewport: { width: 375, height: 812 } });
// a first request to the dev server compiles the page, and the sign-in loads all the data
test.setTimeout(120_000);

test.beforeEach(async () => {
  await clearLoginCounters();
});

// ------------------------------------------------------------------------------------------------ the page

/** Signs in on the login screen and waits for the top bar: the data gate has opened. */
async function openApp(page: Page, who: E2eLogin, target = '/') {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible({ timeout: 60_000 });
}

const menuButton = (page: Page) => page.getByRole('button', { name: 'Open menu' });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Menu' });

async function openMenu(page: Page): Promise<Locator> {
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();
  return drawer(page);
}

/** Opens every group of the drawer (the drawer starts with them open; this makes the test the same if that changes). */
async function expandEveryGroup(menu: Locator) {
  for (;;) {
    const closed = menu.locator('button[aria-expanded="false"]');
    if ((await closed.count()) === 0) return;
    await closed.first().click();
  }
}

// ------------------------------------------------------------------------------------------------ FB-A1

test.describe('FB-A1 the phone menu', () => {
  test('the owner opens the menu, taps Saved Estimates and lands on /estimate with the drawer gone', async ({
    page,
  }) => {
    await openApp(page, owner);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    const menu = await openMenu(page);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['Customers & Ledger', 'Saved Estimates', 'Reports']) {
      await expect(menu.getByRole('link', { name: label })).toBeVisible();
    }
    await menu.getByRole('link', { name: 'Saved Estimates' }).click();
    await expect(page).toHaveURL(/\/estimate$/);
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Saved Estimates' })).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the drawer', async ({ page }) => {
    await openApp(page, owner);
    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    // and it opens again
    await openMenu(page);
  });

  test('a tap on the backdrop closes the drawer', async ({ page }) => {
    await openApp(page, owner);
    await openMenu(page);
    // the panel is 288 px wide at this width: x = 350 is the dark part beside it
    await page.mouse.click(350, 400);
    await expect(drawer(page)).toHaveCount(0);
  });

  test('the Close menu button of the drawer closes it', async ({ page }) => {
    await openApp(page, owner);
    const menu = await openMenu(page);
    await menu.getByRole('button', { name: 'Close menu' }).last().click();
    await expect(drawer(page)).toHaveCount(0);
  });

  test('with every group open the long owner menu scrolls and its last link, Business Settings, opens its tab; the Sale button is tappable after the drawer closes', async ({
    page,
  }) => {
    await openApp(page, owner);
    const menu = await openMenu(page);
    await expandEveryGroup(menu);
    // Review Focus 3: the menu is longer than the screen, so it must scroll inside the drawer
    const nav = menu.locator('nav');
    const sizes = await nav.evaluate((el) => ({ scroll: el.scrollHeight, shown: el.clientHeight }));
    expect(sizes.scroll).toBeGreaterThan(sizes.shown);
    const last = menu.getByRole('link', { name: 'Business Settings' });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page).toHaveURL(/\/settings\?tab=business$/);
    await expect(drawer(page)).toHaveCount(0);
    // nothing of the drawer is left over the bottom bar
    await page.getByRole('link', { name: 'Sale', exact: true }).click();
    await expect(page).toHaveURL(/\/billing-pos/);
  });

  test('a biller drawer has New Estimate and Customers & Ledger and no Settings', async ({
    page,
  }) => {
    await openApp(page, biller);
    const menu = await openMenu(page);
    await expect(menu.getByRole('link', { name: 'New Estimate' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Customers & Ledger' })).toBeVisible();
    await expandEveryGroup(menu);
    await expect(menu.getByText('Settings')).toHaveCount(0);
    await expect(menu.getByText('Reports')).toHaveCount(0);
  });

  test('from 1280 px up there is no ☰ and the sidebar is the desktop one', async ({ page }) => {
    await openApp(page, owner);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(menuButton(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
  });
});
