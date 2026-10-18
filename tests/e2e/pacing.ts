import { test, type Page } from '@playwright/test';
import { e2eLane } from './global-setup';

// The API lets one person make 300 calls a minute (A13). A full hydrate is 15 calls on the small data of a lane and 40 to 80 on the volumes,
// and a test that signs in several times makes several; on a computer that is not busy the tests that follow each other can add up to more
// than 300 for the owner within one minute and the API answers "Too many attempts". A spec that signs in a lot therefore waits, before each
// test, until the minute behind it holds at most `most` calls of its pages and of the process. The wait counts all people together, which
// is stricter than the API's own rule (each person has 300) and so is safe.
const stamps: number[] = [];

/** A call to the API made by this process (not by a page): count it. */
export function noteApiCall(): void {
  stamps.push(Date.now());
}

/** Counts the API calls of this page from now on and waits until the last minute holds at most `most` of them. */
export async function roomInTheMinute(page: Page, most = 150): Promise<void> {
  const { apiUrl } = e2eLane();
  page.on('request', (request) => {
    if (request.url().startsWith(apiUrl)) stamps.push(Date.now());
  });
  for (;;) {
    const since = Date.now() - 60_000;
    while (stamps.length > 0 && stamps[0] < since) stamps.shift();
    if (stamps.length <= most) return;
    test.info().setTimeout(test.info().timeout + 2_000); // the time spent waiting here is not the test's own
    await page.waitForTimeout(2_000);
  }
}
