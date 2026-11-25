import type { Locator, Page } from '@playwright/test';

/**
 * Types a password into a field without Playwright writing it into a log: `fill` and `type` put their text in the call log of an action that fails, the keyboard does not. The field is clicked
 * first, so that the keys go to it. Nothing asserts on the value either (a failed assertion prints what it received). See "Where a typed password still ends up" in tests/e2e/README.md.
 */
export async function typeSecret(page: Page, field: Locator, secret: string): Promise<void> {
  await field.click();
  await page.keyboard.type(secret);
}
