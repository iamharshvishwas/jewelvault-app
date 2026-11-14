import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// FB-D4 (Siddhi #12): the owner's activity log, `/activity-log`, over `GET /v1/audit-log`, in a real browser against the real API of a lane.
//   the owner signs in and opens it: the first row is `Logged in` by the owner, within the last minute; the changes the database's audit triggers wrote are in plain words (a bill is `New estimate`,
//   a receipt `Payment`, an update of a piece or a design `Stock edited`) and a person the log does not know is `System`; a log of more than 400 rows draws 200 rows, then 400 after one press of
//   "Load more", and Load more goes on to the end (Review Focus 5); the biller and the staff get `Not available for your role` and have no menu link to it.
//
// The audit log is append-only (a trigger stops every UPDATE and DELETE, even the database owner's), so what this file adds to it stays until the lane is torn down: 450 rows of a table of its own
// (`w18_seed`, 1 to 450) and the few rows the audit triggers write for the fixture below. They are written BEFORE any person signs in, so that the login of the test is the newest row. The
// fixture's customer, bill, receipt, piece and design are taken out again (their audit rows stay).
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/activity-log.spec.ts

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/** SQL as root in the lane's container (the password stays inside it); the statements go in through standard input. */
function laneSql(sql: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      laneContainer(),
      'sh',
      '-c',
      'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" jv_lane -N -B',
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(`the lane's database refused the SQL (${code}): ${err.slice(0, 500)}`)
        );
      resolve(
        out
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t'))
      );
    });
    child.stdin.end(sql);
  });
}

// ------------------------------------------------------------------------------------------------ the log of the test

const ids = {
  customer: randomUUID(),
  bill: randomUUID(),
  receipt: randomUUID(),
  design: randomUUID(),
  piece: randomUUID(),
};

/** What the audit triggers write for these statements: a bill, a receipt (inserts), a piece and a design (updates), all by "the database" (no actor). */
function fixtureSql(): string {
  return [
    // 450 rows of a table of their own, oldest id first: the newest row of the log after them is whatever comes next
    `INSERT INTO audit_log (actor, actor_role, table_name, row_id, action, new_row) SELECT NULL, 'sql', 'w18_seed', CAST(seq AS CHAR), 'insert', JSON_OBJECT('n', seq) FROM seq_1_to_450;`,
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${ids.customer}', 'W18 Log Customer', '9000180001', 'Retail');`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.design}', 'W18-D1', 'W18 ring', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.piece}', '${ids.design}', 'W18-S1', 'W18BC1', 12.500, 12.000, 'In Stock');`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) VALUES ('${ids.bill}', 'W18-0001', '${ids.customer}', CURDATE(), 'Retail', 9000.00, 9000.00);`,
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES ('${ids.receipt}', '${ids.customer}', 'money', 'Cash', 2500.00, CURDATE());`,
    `UPDATE skus SET location = 'Strong room' WHERE id = '${ids.piece}';`,
    `UPDATE designs SET name = 'W18 ring, renamed' WHERE id = '${ids.design}';`,
  ].join(' ');
}

async function cleanLane() {
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id = '${ids.customer}'; DELETE FROM receipts WHERE customer_id = '${ids.customer}'; ` +
      `DELETE FROM bill_items WHERE bill_id = '${ids.bill}'; DELETE FROM bills WHERE bill_no LIKE 'W18-%'; ` +
      `DELETE FROM customers WHERE name LIKE 'W18 %'; DELETE FROM skus WHERE sku_no LIKE 'W18-%'; DELETE FROM designs WHERE design_no LIKE 'W18-%';`
  );
}

test.beforeAll(async () => {
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterAll(async () => {
  await cleanLane();
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE 'W18 %'), (SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W18-%'), ` +
      `(SELECT COUNT(*) FROM receipts), (SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W18-%'), (SELECT COUNT(*) FROM designs WHERE design_no LIKE 'W18-%')`
  );
  expect(left).toEqual(['0', '0', '0', '0', '0']);
});
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});

// ------------------------------------------------------------------------------------------------ the page

async function openLog(page: Page, who: E2eLogin) {
  await page.goto('/activity-log');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

const rows = (page: Page) => page.getByTestId('activity-row');
const cellsOf = (page: Page) =>
  rows(page).evaluateAll((trs) =>
    trs.map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())
    )
  );

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** An instant as the screen writes it, `14 Nov 2026, 7:05 pm` in India (written here in the test's own way, not with the application's code). */
function istText(ms: number): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: 'h12',
    })
      .formatToParts(ms)
      .map((p) => [p.type, p.value])
  );
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${Number(parts.hour)}:${parts.minute} ${String(parts.dayPeriod).toLowerCase()}`;
}

test.describe("FB-D4: the owner's activity log", () => {
  test.describe.configure({ timeout: 240_000 });

  test('the owner opens it: the first row is Logged in by the owner, within the last minute; 200 rows to a page', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await openLog(page, owner);
    await expect(page.getByRole('heading', { name: 'Activity Log', level: 1 })).toBeVisible({
      timeout: 60_000,
    });
    // one page of 200 rows (the log holds more than 450)
    await expect(rows(page)).toHaveCount(200, { timeout: 60_000 });
    const first = (await cellsOf(page))[0];
    expect(first[1]).toBe(owner.fullName);
    expect(first[2]).toBe('Logged in');
    // within the last minute: the time on the row is this minute or the one before it
    expect([istText(Date.now()), istText(Date.now() - 60_000)]).toContain(first[0]);
    await expect(page.getByTestId('activity-count')).toHaveText('200 entries shown');
    await expect(page.getByTestId('activity-load-more')).toBeVisible();
  });

  test('what the database wrote is in plain words: New estimate, Payment, Stock edited; no actor is System', async ({
    page,
  }) => {
    await openLog(page, e2eLogin('owner'));
    await expect(rows(page)).toHaveCount(200, { timeout: 60_000 });
    const all = await cellsOf(page);
    const find = (what: string) => all.find((cells) => cells[2] === what);
    // the fixture's statements were run by hand (no user): "System"
    expect(find('New estimate W18-0001')?.[1], 'a bill').toBe('System');
    expect(find('Payment ₹2,500')?.[1], 'a receipt').toBe('System');
    expect(find('Stock edited W18-S1')?.[1], 'a piece').toBe('System');
    expect(find('Stock edited W18-D1')?.[1], 'a design').toBe('System');
    // and the rows are in time order, newest first: the login is above them
    const at = (what: string) => all.findIndex((cells) => cells[2] === what);
    expect(at('Logged in')).toBeLessThan(at('Stock edited W18-D1'));
    expect(at('Stock edited W18-D1')).toBeLessThan(at('Stock edited W18-S1'));
    expect(at('Stock edited W18-S1')).toBeLessThan(at('Payment ₹2,500'));
    expect(at('Payment ₹2,500')).toBeLessThan(at('New estimate W18-0001'));
    // a statement that is not one of the three: "<Action> <table>"
    expect(find('Insert customers')?.[1]).toBe('System');
  });

  test('Load more appends the next page: 200 rows, then 400, and on to the end of the log', async ({
    page,
  }) => {
    await openLog(page, e2eLogin('owner'));
    await expect(rows(page)).toHaveCount(200, { timeout: 60_000 });
    const more = page.getByTestId('activity-load-more');
    await more.click();
    await expect(rows(page)).toHaveCount(400);
    await expect(page.getByTestId('activity-count')).toHaveText('400 entries shown');
    // on to the end: the button goes when the server has no more
    for (let i = 0; i < 20 && (await more.isVisible()); i += 1) {
      const before = await rows(page).count();
      await more.click();
      // a log whose size is a multiple of 200 ends with a page that has no rows: then the button goes and nothing is added
      await expect
        .poll(async () => (await rows(page).count()) > before || !(await more.isVisible()))
        .toBe(true);
    }
    await expect(more).toHaveCount(0);
    // every row of the log is drawn once: the count is the database's (the seed alone is 450 rows)
    const [[total]] = await laneSql('SELECT COUNT(*) FROM audit_log');
    const drawn = await rows(page).count();
    expect(drawn).toBeGreaterThanOrEqual(450);
    expect(drawn).toBe(Number(total));
  });

  for (const role of ['biller', 'staff'] as const) {
    test(`the ${role} gets "Not available for your role" and has no menu link to the log`, async ({
      page,
    }) => {
      await openLog(page, e2eLogin(role));
      await expect(page.getByText('Not available for your role')).toBeVisible({ timeout: 60_000 });
      await expect(rows(page)).toHaveCount(0);
      await expect(page.locator('aside').getByRole('link', { name: 'Activity Log' })).toHaveCount(
        0
      );
    });
  }

  test('the owner reaches it from the menu: Settings, Activity Log', async ({ page }) => {
    await page.goto('/');
    const owner = e2eLogin('owner');
    await page.getByLabel('Email').fill(owner.email);
    await page.getByLabel('Password').fill(owner.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('aside').first()).toContainText(owner.fullName, { timeout: 60_000 });
    await page.locator('aside').getByRole('button', { name: 'Settings' }).click();
    await page.locator('aside').getByRole('link', { name: 'Activity Log' }).click();
    await expect(page).toHaveURL(/\/activity-log$/);
    await expect(page.getByRole('heading', { name: 'Activity Log', level: 1 })).toBeVisible();
    await expect(rows(page).first()).toBeVisible({ timeout: 60_000 });
  });
});
