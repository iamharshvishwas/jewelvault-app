import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backendPid, connect, twoConnections, waitUntilBlocked } from './pg';

// DB05, the two-connection half of the counters and of repeat-safety: T-C01 (the counter: no repeat, no gap, also when a
// number is rolled back while another session waits for it) and T-C14 (two identical requests in flight: one executes, the
// other waits for it and gets the stored result, not an error). The pgTAP half is supabase/tests/database/040_audit_counters.test.sql.
// Also: tests.reset_business_data() puts the seeds of D20 back (a test that had to commit leaves a database the next test can use).
// Everything here commits, so each test cleans up after itself with tests.reset_business_data().

let admin: Client;
let a: Client;
let b: Client;
let closePair: () => Promise<void>;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

beforeAll(async () => {
  admin = await connect('admin');
  const pair = await twoConnections();
  a = pair.a;
  b = pair.b;
  closePair = pair.close;
  await admin.query('select tests.reset_business_data()');
});

afterAll(async () => {
  await a?.query('rollback').catch(() => undefined);
  await b?.query('rollback').catch(() => undefined);
  await admin?.query('select tests.reset_business_data()').catch(() => undefined);
  await closePair?.();
  await admin?.end();
});

describe('T-C01: private.next_number across sessions (L3)', () => {
  it('gives 10 concurrent sessions 10 different numbers, 1 to 10, with no gap', async () => {
    const sessions = await Promise.all(
      Array.from({ length: 10 }, (_, i) => connect(`counter-${i}`))
    );
    try {
      const numbers = await Promise.all(
        sessions.map(async (session) => {
          await session.query('begin');
          const { rows } = await session.query(
            "select private.next_number('design:CON')::int as n"
          );
          await session.query('commit');
          return rows[0].n as number;
        })
      );
      expect([...numbers].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const { rows } = await admin.query(
        "select last_value::int as last from private.counters where series = 'design:CON'"
      );
      expect(rows[0].last).toBe(10);
    } finally {
      await Promise.allSettled(sessions.map((session) => session.end()));
    }
  });

  it('serialises two callers: the second waits for the first, and gets 1 when the first rolls back', async () => {
    await a.query('begin');
    expect((await a.query("select private.next_number('design:RBK')::int as n")).rows[0].n).toBe(1);
    await b.query('begin');
    const pendingB = b.query("select private.next_number('design:RBK')::int as n");
    const pidB = await backendPid(b);
    const blockers = await waitUntilBlocked(admin, pidB, { timeoutMs: 5000 });
    expect(blockers).toEqual([await backendPid(a)]);
    await a.query('rollback');
    expect((await pendingB).rows[0].n).toBe(1);
    await b.query('commit');
    // the next caller gets 2: the number of the rolled-back call was not lost, and the kept one was not reused
    expect(
      (await admin.query("select private.next_number('design:RBK')::int as n")).rows[0].n
    ).toBe(2);
  });

  it('serialises two callers: the second gets the next number when the first commits', async () => {
    await a.query('begin');
    expect((await a.query("select private.next_number('design:CMT')::int as n")).rows[0].n).toBe(1);
    await b.query('begin');
    const pendingB = b.query("select private.next_number('design:CMT')::int as n");
    await waitUntilBlocked(admin, await backendPid(b), { timeoutMs: 5000 });
    await a.query('commit');
    expect((await pendingB).rows[0].n).toBe(2);
    await b.query('commit');
  });
});

describe('T-C14: private.idem_begin with a twin in flight (L5)', () => {
  it('makes the second of two identical requests wait for the first and return its stored result', async () => {
    const id = uuid(1);
    await a.query('begin');
    expect(
      (await a.query('select private.idem_begin($1, $2, $3) as r', [id, 'create_bill', 'h1']))
        .rows[0].r
    ).toBeNull();
    await b.query('begin');
    const pendingB = b.query('select private.idem_begin($1, $2, $3) as r', [
      id,
      'create_bill',
      'h1',
    ]);
    const blockers = await waitUntilBlocked(admin, await backendPid(b), { timeoutMs: 5000 });
    expect(blockers).toEqual([await backendPid(a)]);
    await a.query('select private.idem_finish($1, $2::jsonb)', [id, '{"bill":"JV-2026-0001"}']);
    await a.query('commit');
    // not an error, and not a second execution: the stored result
    expect((await pendingB).rows[0].r).toEqual({ bill: 'JV-2026-0001' });
    await b.query('commit');
    const { rows } = await admin.query(
      'select count(*)::int as n from private.idempotency where request_id = $1',
      [id]
    );
    expect(rows[0].n).toBe(1);
  });

  it('lets the twin carry on as the first when the original is rolled back', async () => {
    const id = uuid(2);
    await a.query('begin');
    await a.query('select private.idem_begin($1, $2, $3)', [id, 'create_bill', 'h1']);
    await b.query('begin');
    const pendingB = b.query('select private.idem_begin($1, $2, $3) as r', [
      id,
      'create_bill',
      'h1',
    ]);
    await waitUntilBlocked(admin, await backendPid(b), { timeoutMs: 5000 });
    await a.query('rollback');
    expect((await pendingB).rows[0].r).toBeNull();
    await b.query('select private.idem_finish($1, $2::jsonb)', [id, '{"done":true}']);
    await b.query('commit');
    const { rows } = await admin.query(
      'select result from private.idempotency where request_id = $1',
      [id]
    );
    expect(rows[0].result).toEqual({ done: true });
  });

  it('refuses the twin that comes with another payload once the original has committed', async () => {
    const id = uuid(3);
    await a.query('begin');
    await a.query('select private.idem_begin($1, $2, $3)', [id, 'create_bill', 'cart-1']);
    await b.query('begin');
    const pendingB = b.query('select private.idem_begin($1, $2, $3) as r', [
      id,
      'create_bill',
      'cart-2',
    ]);
    // attach the handler first: the rejection must not be "unhandled" while the original is still open
    const outcome = pendingB.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await waitUntilBlocked(admin, await backendPid(b), { timeoutMs: 5000 });
    await a.query('select private.idem_finish($1, $2::jsonb)', [id, '{"ok":1}']);
    await a.query('commit');
    expect(await outcome).toMatch(/^JV_INVALID_INPUT:/);
    await b.query('rollback');
  });

  it('is cut by the lock_timeout of the function while the twin is held, so JV_BUSY can be raised (X0 item 7)', async () => {
    const id = uuid(4);
    await a.query('begin');
    await a.query('select private.idem_begin($1, $2, $3)', [id, 'create_bill', 'h1']);
    await b.query('begin');
    await b.query("set local lock_timeout = '300ms'");
    await expect(
      b.query('select private.idem_begin($1, $2, $3)', [id, 'create_bill', 'h1'])
    ).rejects.toMatchObject({ code: '55P03' });
    await b.query('rollback');
    await a.query('rollback');
  });
});

describe('tests.reset_business_data puts the seeds of D20 back', () => {
  it('empties the business tables and the counters, keeps private.limits, and seeds the settings, the categories and the walk-in', async () => {
    await admin.query("select private.next_number('opening')");
    await admin.query(
      "insert into public.customers (name, mobile) values ('Reset probe', '9876543210')"
    );
    await admin.query(
      'update public.settings set value = \'{"prefix":"XX"}\' where key = \'estimate\''
    );
    const limitsBefore = (await admin.query('select count(*)::int as n from private.limits'))
      .rows[0].n;

    const { rows: result } = await admin.query('select tests.reset_business_data() as r');
    expect(result[0].r.seeded).toBe(true);

    const count = async (sql: string) => (await admin.query(sql)).rows[0].n as number;
    expect(await count('select count(*)::int as n from private.counters')).toBe(0);
    expect(await count('select count(*)::int as n from private.idempotency')).toBe(0);
    expect(await count('select count(*)::int as n from private.limits')).toBe(limitsBefore);
    expect(
      await count("select count(*)::int as n from public.customers where name = 'Reset probe'")
    ).toBe(0);
    expect(await count('select count(*)::int as n from public.customers')).toBe(1);
    expect(
      await count(
        "select count(*)::int as n from public.customers where is_walkin and id = '00000000-0000-4000-8000-000000000001'"
      )
    ).toBe(1);
    expect(await count('select count(*)::int as n from public.settings')).toBe(9);
    expect(
      (
        await admin.query(
          "select value ->> 'prefix' as p from public.settings where key = 'estimate'"
        )
      ).rows[0].p
    ).toBe('JV');
    expect(await count('select count(*)::int as n from public.categories')).toBe(15);
    expect(await count('select count(*)::int as n from public.subcategories')).toBe(60);
    expect(await count('select count(*)::int as n from public.designs')).toBe(0);
    expect(await count('select count(*)::int as n from public.skus')).toBe(0);
    expect(await count('select count(*)::int as n from public.bills')).toBe(0);
  });
});
