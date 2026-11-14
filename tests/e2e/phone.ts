import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';

// The phone width under test (Global Constraint of the feedback plan): 375 x 812. Shared by the phone cases of print.spec.ts, stock-catalogue.spec.ts, dashboard.spec.ts and activity-log.spec.ts.
export const PHONE = { width: 375, height: 812 } as const;

/**
 * The control is whole inside the screen and takes a tap: it is scrolled into view, visible, its box is between the left and right edges of the phone, and a trial click (Playwright's own
 * check that it is enabled, steady and that it, and not the bottom bar or a drawer, would receive the click at its centre) passes.
 */
export async function expectTappable(control: Locator): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const box = await control.boundingBox();
  expect(box, 'the control has a box').not.toBeNull();
  expect(box!.x, 'the control starts inside the screen').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'the control ends inside the screen').toBeLessThanOrEqual(
    PHONE.width
  );
  await control.click({ trial: true });
}

/** The screen itself does not scroll sideways: what is wider than the phone scrolls inside its own box (a table in its wrapper), never the page. */
export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const sideways = await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(sideways, '`main` scrolls sideways by this many pixels').toBeLessThanOrEqual(0);
  const whole = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(whole, 'the document scrolls sideways by this many pixels').toBeLessThanOrEqual(0);
}

/** With JV_PRINT_PDF_DIR set, a screenshot of the phone screen is written there (to look at it); otherwise nothing. */
export async function shoot(page: Page, name: string): Promise<void> {
  const dir = process.env.JV_PRINT_PDF_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `phone-${name}.png`) });
}
