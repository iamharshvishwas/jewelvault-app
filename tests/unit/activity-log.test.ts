// FB-D4 (Siddhi #12): the owner's activity log, `/activity-log`, over `GET /v1/audit-log` (newest first, 200 a page, owner only).
//   - `describeAudit(row, users)`: the time in India as `14 Nov 2026, 7:05 pm`, the person by name (`System` when the actor is not known) and the change in plain words: a login, a logout and a change of
//     password (`event` rows of the table `users`), `New estimate <bill_no>`, `Payment <amount>`, `Stock edited <design_no or sku_no>`, and `<Action> <table>` for the rest
//   - `readAuditPage(beforeId?)` asks for one page of 200, after the id the server last sent
//   - the screen asks for ONE page when it opens and one more for each press of "Load more": a log of 10,000 rows draws 200 rows, then 400 (Review Focus 5), and a page that fails keeps the rows already drawn
//   - the screen is the owner's: the route table, the menu (Settings) and the page itself
//
// The pure parts are tested as they are; the screen's pages by a paging controller over a fake server (the screen draws what the controller holds, drawn here on the server side of React).
//
// Run: npm test -- tests/unit/activity-log.test.ts      (or: npm test -- -t FB-D4)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { canAccessPath } from '@/lib/authStore';
import { createAuditFeed, describeAudit } from '@/lib/activityLog';
import { AUDIT_PAGE_ROWS, createBooksServer } from '@/lib/cache/booksServer';
import type { AuditPageResponse, AuditRow } from '@/lib/api/types';
import { uuid } from './support/rows';

const SRC = path.resolve(__dirname, '../../src');

const asha = uuid(901);
const owner = uuid(902);
const users = new Map([
  [asha, 'Asha Verma'],
  [owner, 'Siddhi Jain'],
]);

let n = 0;
function row(over: Partial<AuditRow> = {}): AuditRow {
  n += 1;
  return {
    id: n,
    at: '2026-11-14T13:35:12.123456Z',
    actor: owner,
    actor_role: 'owner',
    request_id: uuid(7000 + n),
    table_name: 'settings',
    row_id: 'business',
    action: 'update',
    old_row: null,
    new_row: null,
    ...over,
  };
}

// ================================================================================================ describeAudit

describe('FB-D4 describeAudit: the time in India, the person, the change in plain words', () => {
  it('a login, a logout and a change of password are events of the table users', () => {
    const login = describeAudit(
      row({ action: 'event', table_name: 'users', row_id: owner, new_row: { event: 'login' } }),
      users
    );
    expect(login).toEqual({ when: '14 Nov 2026, 7:05 pm', who: 'Siddhi Jain', what: 'Logged in' });
    expect(
      describeAudit(
        row({ action: 'event', table_name: 'users', new_row: { event: 'logout' } }),
        users
      ).what
    ).toBe('Logged out');
    expect(
      describeAudit(
        row({ action: 'event', table_name: 'users', new_row: { event: 'change_password' } }),
        users
      ).what
    ).toBe('Changed password');
  });

  it('a new bill is "New estimate" with its number; a receipt is "Payment" with the amount in rupees', () => {
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'bills',
          new_row: { bill_no: 'JV-0021', grand_total: '9000.00' },
        }),
        users
      ).what
    ).toBe('New estimate JV-0021');
    expect(
      describeAudit(
        row({
          actor: asha,
          action: 'insert',
          table_name: 'receipts',
          new_row: { amount: '2500.00' },
        }),
        users
      )
    ).toMatchObject({ who: 'Asha Verma', what: 'Payment ₹2,500' });
    expect(
      describeAudit(
        row({ action: 'insert', table_name: 'receipts', new_row: { amount: '1000.50' } }),
        users
      ).what
    ).toBe('Payment ₹1,000.50');
    // an amount that is not there leaves no stray space
    expect(
      describeAudit(row({ action: 'insert', table_name: 'bills', new_row: {} }), users).what
    ).toBe('New estimate');
    expect(
      describeAudit(row({ action: 'insert', table_name: 'receipts', new_row: null }), users).what
    ).toBe('Payment');
  });

  // Wave 2 fix 2 (I1): the words follow the row's kind, so a refund is never read as money coming in
  it('a refund is "Money handed back", not "Payment": money going out is read as money going out', () => {
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'refund', amount: '5000.00', fine_grams: '0.000' },
        }),
        users
      ).what
    ).toBe('Money handed back ₹5,000');
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'refund', amount: '1000.50' },
        }),
        users
      ).what
    ).toBe('Money handed back ₹1,000.50');
    // no amount leaves no stray space
    expect(
      describeAudit(
        row({ action: 'insert', table_name: 'receipts', new_row: { kind: 'refund' } }),
        users
      ).what
    ).toBe('Money handed back');
  });

  it('silver paid in cash is "Silver paid in cash" with the rupees; silver received is "Silver received" with the grams from fine_grams', () => {
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'fine_cash', amount: '2500.00', fine_grams: '10.000' },
        }),
        users
      ).what
    ).toBe('Silver paid in cash ₹2,500');
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'fine_silver', amount: '0.00', fine_grams: '2.500' },
        }),
        users
      ).what
    ).toBe('Silver received 2.500 g');
    // whole milligrams, no float maths: a long weight keeps every digit, and the smallest one is not lost
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'fine_silver', amount: '0.00', fine_grams: '123456.789' },
        }),
        users
      ).what
    ).toBe('Silver received 123456.789 g');
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'fine_silver', amount: '0.00', fine_grams: '0.001' },
        }),
        users
      ).what
    ).toBe('Silver received 0.001 g');
    // a silver row with no grams (or ones that cannot be read) is not "Payment ₹0"
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'fine_silver', amount: '0.00' },
        }),
        users
      ).what
    ).toBe('Silver received');
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'fine_silver', fine_grams: 'lots' },
        }),
        users
      ).what
    ).toBe('Silver received');
  });

  it('a receipt of kind money (or with no kind) is still "Payment" with the amount', () => {
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'receipts',
          new_row: { kind: 'money', amount: '2500.00' },
        }),
        users
      ).what
    ).toBe('Payment ₹2,500');
  });

  it('dues brought forward (doc_type opening_balance) are "Opening balance" with the number; an estimate is still "New estimate"', () => {
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'bills',
          new_row: { bill_no: 'OB-0001', doc_type: 'opening_balance', grand_total: '7000.00' },
        }),
        users
      ).what
    ).toBe('Opening balance OB-0001');
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'bills',
          new_row: { bill_no: 'JV-0022', doc_type: 'estimate' },
        }),
        users
      ).what
    ).toBe('New estimate JV-0022');
    expect(
      describeAudit(
        row({
          action: 'insert',
          table_name: 'bills',
          new_row: { doc_type: 'opening_balance' },
        }),
        users
      ).what
    ).toBe('Opening balance');
  });

  it('a change to a piece or a design is "Stock edited" with the piece number or the design number', () => {
    expect(
      describeAudit(
        row({
          action: 'update',
          table_name: 'skus',
          new_row: { sku_no: 'RING-00001-002', status: 'Sold' },
        }),
        users
      ).what
    ).toBe('Stock edited RING-00001-002');
    expect(
      describeAudit(
        row({ action: 'update', table_name: 'designs', new_row: { design_no: 'RING-00001' } }),
        users
      ).what
    ).toBe('Stock edited RING-00001');
    // only an update is a stock edit: a new piece or design is "<Action> <table>"
    expect(
      describeAudit(
        row({ action: 'insert', table_name: 'skus', new_row: { sku_no: 'X-1' } }),
        users
      ).what
    ).toBe('Insert skus');
  });

  it('anything else is "<Action> <table>", in plain words', () => {
    expect(describeAudit(row({ action: 'update', table_name: 'settings' }), users).what).toBe(
      'Update settings'
    );
    expect(describeAudit(row({ action: 'insert', table_name: 'customers' }), users).what).toBe(
      'Insert customers'
    );
    expect(describeAudit(row({ action: 'update', table_name: 'receipts' }), users).what).toBe(
      'Update receipts'
    );
    expect(describeAudit(row({ action: 'insert', table_name: 'bill_items' }), users).what).toBe(
      'Insert bill items'
    );
    // an event the screen has no words for: the event, and what it is about
    expect(
      describeAudit(
        row({ action: 'event', table_name: 'login_failures', new_row: { event: 'summary' } }),
        users
      ).what
    ).toBe('Event login failures');
    // an event row with no facts at all
    expect(
      describeAudit(row({ action: 'event', table_name: 'users', new_row: null }), users).what
    ).toBe('Event users');
  });

  it('a person who is not known is "System": no actor (a job, the admin door, a statement run by hand) or an id with no user', () => {
    expect(describeAudit(row({ actor: null, actor_role: 'job' }), users).who).toBe('System');
    expect(describeAudit(row({ actor: uuid(999) }), users).who).toBe('System');
    expect(describeAudit(row({ actor: asha }), users).who).toBe('Asha Verma');
  });

  it("writes the time in India, whatever the computer's time zone is, 12-hour with am and pm", () => {
    const at = (text: string) => describeAudit(row({ at: text }), users).when;
    expect(at('2026-11-14T13:35:12.123456Z')).toBe('14 Nov 2026, 7:05 pm');
    expect(at('2026-11-14T13:35:12Z')).toBe('14 Nov 2026, 7:05 pm');
    // midnight and noon in India
    expect(at('2026-11-13T18:30:00.000000Z')).toBe('14 Nov 2026, 12:00 am');
    expect(at('2026-11-14T06:30:00.000000Z')).toBe('14 Nov 2026, 12:00 pm');
    // late in the evening in UTC is the next morning in India, across a month and a year
    expect(at('2026-12-31T19:00:00.000000Z')).toBe('1 Jan 2027, 12:30 am');
    expect(at('2026-09-05T03:04:00.000000Z')).toBe('5 Sep 2026, 8:34 am');
    expect(at('2026-03-31T18:29:59.999999Z')).toBe('31 Mar 2026, 11:59 pm');
  });

  it('a time that cannot be read is a dash, not a crash', () => {
    expect(describeAudit(row({ at: 'yesterday' }), users).when).toBe('-');
  });
});

// ================================================================================================ the read

// FB-F1 (F-extra-4): the Order Book's rows and the three money and photo changes that had no words. The facts are the API's audit rows: an insert or update of `orders` carries the whole
// row (order_no, status) in new_row and, for an update, old_row; a void of a receipt and a cancel of a bill are updates whose new_row has the new `status`; the removal of a photo is an `event`
// of the table `design_photos` whose new_row names `photo_removed` (src/photos/photoStore.ts of the API).
describe('FB-F1 describeAudit: the Order Book, a voided payment, a cancelled bill and a removed photo', () => {
  const order = (status: string) => ({ order_no: 'ORD-2026-0007', status, description: 'Ring' });

  it('a new order is "New order <order_no>"', () => {
    expect(
      describeAudit(row({ action: 'insert', table_name: 'orders', new_row: order('open') }), users)
        .what
    ).toBe('New order ORD-2026-0007');
  });

  it('a change of status is "Order <order_no> marked <Status>", in the words of the screen', () => {
    expect(
      describeAudit(
        row({
          action: 'update',
          table_name: 'orders',
          old_row: order('in_progress'),
          new_row: order('ready'),
        }),
        users
      ).what
    ).toBe('Order ORD-2026-0007 marked Ready');
    expect(
      describeAudit(
        row({
          action: 'update',
          table_name: 'orders',
          old_row: order('open'),
          new_row: order('in_progress'),
        }),
        users
      ).what
    ).toBe('Order ORD-2026-0007 marked In progress');
  });

  it('any other change of an order is "Order <order_no> edited"', () => {
    expect(
      describeAudit(
        row({
          action: 'update',
          table_name: 'orders',
          old_row: order('open'),
          new_row: { ...order('open'), photo_ids: ['x'] },
        }),
        users
      ).what
    ).toBe('Order ORD-2026-0007 edited');
  });

  it('a receipt updated to voided is "Payment voided"', () => {
    expect(
      describeAudit(
        row({
          action: 'update',
          table_name: 'receipts',
          old_row: { status: 'active', amount: '500.00' },
          new_row: { status: 'voided', amount: '500.00', void_reason: 'No reason given' },
        }),
        users
      ).what
    ).toBe('Payment voided');
  });

  it('a bill updated to cancelled is "Bill cancelled"', () => {
    expect(
      describeAudit(
        row({
          action: 'update',
          table_name: 'bills',
          old_row: { status: 'active', bill_no: 'JV-0021' },
          new_row: { status: 'cancelled', bill_no: 'JV-0021' },
        }),
        users
      ).what
    ).toBe('Bill cancelled');
  });

  it('the removal of a photo is "Photo removed"', () => {
    expect(
      describeAudit(
        row({
          action: 'event',
          table_name: 'design_photos',
          new_row: { event: 'photo_removed', photo_id: uuid(1), order_id: uuid(2) },
        }),
        users
      ).what
    ).toBe('Photo removed');
  });
});

describe('FB-D4 readAuditPage', () => {
  function booksWith(get: (path: string, options?: unknown) => Promise<unknown>) {
    return createBooksServer({
      api: { get } as never,
      cache: { versionOf: () => '', subscribe: () => () => undefined } as never,
      registerLogoutHook: () => () => undefined,
    });
  }

  it('asks for 200 rows, newest first, with no cursor for the first page and the id the server last sent for the next', async () => {
    const answer: AuditPageResponse = { rows: [row()], next: { before_id: 4321 } };
    const get = vi.fn(async () => answer);
    const books = booksWith(get);
    expect(await books.readAuditPage()).toBe(answer);
    expect(get).toHaveBeenLastCalledWith('/v1/audit-log', { query: { limit: AUDIT_PAGE_ROWS } });
    await books.readAuditPage(4321);
    expect(get).toHaveBeenLastCalledWith('/v1/audit-log', {
      query: { limit: 200, before_id: 4321 },
    });
    expect(AUDIT_PAGE_ROWS).toBe(200);
  });
});

// ================================================================================================ the pages of the screen

/** A server with `total` audit rows, ids 1 to total; a page is the newest `limit` rows before the cursor, as the API answers (`next` is set when the page is full). */
function serverOf(total: number) {
  const calls: Array<number | undefined> = [];
  const all = Array.from({ length: total }, (_, i) =>
    row({
      id: total - i,
      table_name: 'bills',
      action: 'insert',
      new_row: { bill_no: `JV-${total - i}` },
    })
  );
  const read = async (beforeId?: number): Promise<AuditPageResponse> => {
    calls.push(beforeId);
    const rows = all.filter((r) => beforeId === undefined || r.id < beforeId).slice(0, 200);
    return { rows, next: rows.length === 200 ? { before_id: rows[199].id } : null };
  };
  return { calls, read };
}

describe('FB-D4 the screen draws one page at a time (Review Focus 5)', () => {
  it('a log of 10,000 rows: 200 rows when it opens and no second call; "Load more" makes 400, one page for each press', async () => {
    const server = serverOf(10_000);
    const feed = createAuditFeed(server.read);
    expect(feed.state().state).toBe('idle');
    await feed.open();
    expect(feed.state().rows).toHaveLength(200);
    expect(server.calls).toEqual([undefined]); // one call, no cursor
    expect(feed.state().rows[0].id).toBe(10_000); // the newest first
    expect(feed.state().rows[199].id).toBe(9_801);
    expect(feed.state().more).toBe(true);
    await feed.loadMore();
    expect(feed.state().rows).toHaveLength(400);
    expect(server.calls).toEqual([undefined, 9_801]); // after the id the server sent
    expect(feed.state().rows[200].id).toBe(9_800); // no row twice, none skipped
  });

  it('a log of 450 rows: 200, 400, then 450 and the end (no more button)', async () => {
    const server = serverOf(450);
    const feed = createAuditFeed(server.read);
    await feed.open();
    await feed.loadMore();
    expect(feed.state().rows).toHaveLength(400);
    expect(feed.state().more).toBe(true);
    await feed.loadMore();
    expect(feed.state().rows).toHaveLength(450);
    expect(feed.state().more).toBe(false);
    await feed.loadMore(); // at the end: nothing is asked
    expect(server.calls).toHaveLength(3);
    expect(new Set(feed.state().rows.map((r) => r.id)).size).toBe(450);
  });

  it('a second press while a page is on its way does not ask again', async () => {
    const server = serverOf(1000);
    const feed = createAuditFeed(server.read);
    await feed.open();
    await Promise.all([feed.loadMore(), feed.loadMore(), feed.loadMore()]);
    expect(server.calls).toHaveLength(2);
    expect(feed.state().rows).toHaveLength(400);
  });

  it('a page that fails keeps the rows already drawn, says why in plain words and can be asked again', async () => {
    const server = serverOf(1000);
    let fail = false;
    const feed = createAuditFeed(async (before) => {
      if (fail) throw new Error('network down');
      return server.read(before);
    });
    await feed.open();
    fail = true;
    await feed.loadMore();
    expect(feed.state().rows).toHaveLength(200);
    expect(feed.state().state).toBe('failed');
    expect(feed.state().message).toBe('The activity log could not be loaded. Try again.');
    expect(feed.state().more).toBe(true);
    fail = false;
    await feed.loadMore();
    expect(feed.state().rows).toHaveLength(400);
    expect(feed.state().state).toBe('ready');
    expect(feed.state().message).toBeNull();
  });

  it('a first page that fails is asked for again, by the same press', async () => {
    let fail = true;
    const server = serverOf(250);
    const feed = createAuditFeed(async (before) => {
      if (fail) throw new Error('network down');
      return server.read(before);
    });
    await feed.open();
    expect(feed.state()).toMatchObject({ state: 'failed', rows: [], more: false });
    fail = false;
    await feed.loadMore();
    expect(feed.state()).toMatchObject({ state: 'ready', more: true });
    expect(feed.state().rows).toHaveLength(200);
    expect(server.calls).toEqual([undefined]);
  });

  it('an empty log is ready and has no more', async () => {
    const feed = createAuditFeed(async () => ({ rows: [], next: null }));
    await feed.open();
    expect(feed.state()).toMatchObject({ state: 'ready', rows: [], more: false });
  });

  it('tells its listeners when it changes', async () => {
    const feed = createAuditFeed(serverOf(5).read);
    const seen: string[] = [];
    const stop = feed.subscribe(() => seen.push(feed.state().state));
    await feed.open();
    stop();
    expect(seen).toEqual(['loading', 'ready']);
  });
});

describe('FB-D4 the screen draws what the feed holds', () => {
  async function draw(total: number, loadMore = 0) {
    const feed = createAuditFeed(serverOf(total).read);
    await feed.open();
    for (let i = 0; i < loadMore; i += 1) await feed.loadMore();
    const screen = await import('@/app/activity-log/components/ActivityLogClient');
    return renderToStaticMarkup(
      React.createElement(screen.ActivityLogView, {
        state: feed.state(),
        users,
        onMore: () => undefined,
      })
    );
  }
  const rowsDrawn = (html: string) => (html.match(/data-testid="activity-row"/g) ?? []).length;

  it('200 rows of a log of 10,000, then 400 after one Load more, with the button while there is more', async () => {
    const first = await draw(10_000);
    expect(rowsDrawn(first)).toBe(200);
    expect(first).toContain('Load more');
    const second = await draw(10_000, 1);
    expect(rowsDrawn(second)).toBe(400);
    expect(second).toContain('Load more');
  });

  it('no Load more at the end of the log, and a line for an empty one', async () => {
    const end = await draw(450, 2);
    expect(rowsDrawn(end)).toBe(450);
    expect(end).not.toContain('Load more');
    const empty = await draw(0);
    expect(empty).toContain('Nothing has been logged yet.');
  });

  it('a row says when (India), who and what', async () => {
    const html = await draw(3);
    const first = /<tr[^>]*data-testid="activity-row"[^>]*>([\s\S]*?)<\/tr>/.exec(html)![1];
    const cells = [...first.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
      c[1].replace(/<[^>]*>/g, '').trim()
    );
    expect(cells).toEqual(['14 Nov 2026, 7:05 pm', 'Siddhi Jain', 'New estimate JV-3']);
  });
});

// ================================================================================================ the owner's screen

describe("FB-D4 the screen is the owner's", () => {
  it('the route table: the owner and nobody else', () => {
    expect(canAccessPath('owner', '/activity-log')).toBe(true);
    expect(canAccessPath('biller', '/activity-log')).toBe(false);
    expect(canAccessPath('staff', '/activity-log')).toBe(false);
    expect(canAccessPath(null, '/activity-log')).toBe(false);
  });

  it('the menu offers it in the Settings group, so only to the people who may open it, and keeps Business Settings last', () => {
    const sidebar = readFileSync(path.join(SRC, 'components/Sidebar.tsx'), 'utf8');
    expect(sidebar).toMatch(/label: 'Activity Log',\s*href: '\/activity-log'/);
    const settings = sidebar.slice(sidebar.indexOf("id: 'nav-settings'"));
    expect(settings.indexOf("'Activity Log'")).toBeGreaterThan(-1);
    expect(settings.indexOf("'Activity Log'")).toBeLessThan(
      settings.indexOf("'Business Settings'")
    );
  });
});
