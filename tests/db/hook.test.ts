import type { Client } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PAUSE_FN,
  createGate,
  dropClause,
  getFunctionDef,
  mutateFunction,
  withMutation,
} from './hook';
import { backendPid, connect, twoConnections, waitEvent, waitUntilBlocked } from './pg';

// PT-H1 (harness smoke): the test hook of X0 item 8 and the negative control behind T-C09 to T-C14. DB01.
//
// The real writing functions do not exist yet, so the harness is proved on a toy that has the same shape as one:
// it locks a "customer" row, calls the hook after it has read, then writes. The same test then runs against the toy with
// its lock cut out, and has to fail (this is what "the same test fails without the lock" means in the spec).

const PAUSE = 'jv_hook.test_pause';
let admin: Client;
let a: Client;
let b: Client;
let closeBoth: () => Promise<void>;

beforeAll(async () => {
  admin = await connect('hook-admin');
  const pair = await twoConnections();
  a = pair.a;
  b = pair.b;
  closeBoth = pair.close;
  await admin.query(`
    drop schema if exists jv_hook cascade;
    create schema jv_hook;
    create table jv_hook.cust (id int primary key, n int not null);
    create function jv_hook.test_pause(p_point text) returns void language plpgsql as $f$ begin null; end $f$;
    create function jv_hook.pay() returns int language plpgsql set lock_timeout = '15s' as $f$
    declare v int;
    begin
      select n into v from jv_hook.cust where id = 1 for update;
      perform jv_hook.test_pause('pay.after_read');
      update jv_hook.cust set n = v + 1 where id = 1;
      return v + 1;
    end $f$;
    create function jv_hook.other() returns int language plpgsql as $f$
    begin
      perform jv_hook.test_pause('other.point');
      return 1;
    end $f$;
  `);
});

beforeEach(async () => {
  await admin.query('truncate jv_hook.cust; insert into jv_hook.cust values (1, 0)');
});

afterEach(async () => {
  await admin.query('select pg_advisory_unlock_all()');
});

afterAll(async () => {
  await closeBoth?.();
  await admin?.query('drop schema if exists jv_hook cascade');
  await admin?.end();
});

/** The shape of T-C09: hold the first caller at the pause point, start the second, and see where each one is. */
async function twoCallersMeet(gateOpts: { fn: string }) {
  const gate = await createGate(admin, 'pay.after_read', gateOpts);
  await gate.hold();
  const first = a.query('select jv_hook.pay() as n');
  first.catch(() => undefined);
  await gate.waitForWaiters(admin, 1);
  const second = b.query('select jv_hook.pay() as n');
  second.catch(() => undefined);
  return { gate, first, second, pidA: await backendPid(a), pidB: await backendPid(b) };
}

describe('constants and helpers', () => {
  it('names private.test_pause as the default hook', () => {
    expect(DEFAULT_PAUSE_FN).toBe('private.test_pause');
  });

  it('dropClause removes a clause from a function definition', () => {
    expect(dropClause(/for update/gi)('select 1 from t for update; select 2 FOR UPDATE;')).toBe(
      'select 1 from t ; select 2 ;'
    );
  });
});

describe('the pause hook', () => {
  it('holds a caller at the named point while a gate is held, and lets it through when released', async () => {
    const gate = await createGate(admin, 'pay.after_read', { fn: PAUSE });
    await gate.hold();
    const call = a.query('select jv_hook.pay() as n');
    const [pid] = await gate.waitForWaiters(admin, 1);
    expect(pid).toBe(await backendPid(a));
    await gate.release();
    expect((await call).rows[0].n).toBe(1);
    await gate.dispose();
  });

  it('lets a caller at another point straight through', async () => {
    const gate = await createGate(admin, 'pay.after_read', { fn: PAUSE });
    await gate.hold();
    expect((await a.query('select jv_hook.other() as n')).rows[0].n).toBe(1);
    expect(await gate.waiters(admin)).toEqual([]);
    await gate.release();
    await gate.dispose();
  });

  it('puts the empty hook back when the gate is disposed of', async () => {
    const before = await getFunctionDef(admin, 'jv_hook.test_pause(text)');
    const gate = await createGate(admin, 'pay.after_read', { fn: PAUSE });
    expect(await getFunctionDef(admin, 'jv_hook.test_pause(text)')).not.toBe(before);
    await gate.dispose();
    expect(await getFunctionDef(admin, 'jv_hook.test_pause(text)')).toBe(before);
    await gate.hold();
    // with the gate gone nothing can wait any more, even though the lock is held
    expect((await a.query('select jv_hook.pay() as n')).rows[0].n).toBe(1);
    await gate.release();
  });
});

describe('two callers and the customer lock (the shape of T-C09)', () => {
  it('with the lock: the second caller waits for the first and never reaches the point beside it', async () => {
    const { gate, first, second, pidA, pidB } = await twoCallersMeet({ fn: PAUSE });
    const blockers = await waitUntilBlocked(admin, pidB, { timeoutMs: 5000 });
    expect(blockers).toEqual([pidA]);
    expect((await waitEvent(admin, pidB)).event).not.toBe('advisory');
    expect(await gate.waiters(admin)).toEqual([pidA]);
    await gate.release();
    expect((await first).rows[0].n).toBe(1);
    expect((await second).rows[0].n).toBe(2);
    expect((await admin.query('select n from jv_hook.cust where id = 1')).rows[0].n).toBe(2);
    await gate.dispose();
  });

  it('without the lock the same test fails: both callers reach the point and an update is lost', async () => {
    const original = await getFunctionDef(admin, 'jv_hook.pay()');
    await withMutation(admin, 'jv_hook.pay()', dropClause(/for update/gi), async () => {
      const { gate, first, second, pidA, pidB } = await twoCallersMeet({ fn: PAUSE });
      // the second caller is not held back by the first: both are at the point, and what holds the second is only the gate
      const waiters = await gate.waitForWaiters(admin, 2, { timeoutMs: 5000 });
      expect(waiters.sort()).toEqual([pidA, pidB].sort());
      expect((await waitEvent(admin, pidB)).event).toBe('advisory');
      await gate.release();
      await Promise.all([first, second]);
      // ... so both read 0 and both wrote 1: one payment is lost
      expect((await admin.query('select n from jv_hook.cust where id = 1')).rows[0].n).toBe(1);
      await gate.dispose();
    });
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).toBe(original);
  });

  it('works again as before once the function is restored', async () => {
    const { gate, first, second } = await twoCallersMeet({ fn: PAUSE });
    await gate.release();
    await Promise.all([first, second]);
    expect((await admin.query('select n from jv_hook.cust where id = 1')).rows[0].n).toBe(2);
    await gate.dispose();
  });
});

describe('mutateFunction and restore', () => {
  it('returns a restore function that puts the committed definition back', async () => {
    const original = await getFunctionDef(admin, 'jv_hook.pay()');
    const restore = await mutateFunction(admin, 'jv_hook.pay()', dropClause(/for update/gi));
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).not.toBe(original);
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).not.toMatch(/for update/i);
    await restore();
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).toBe(original);
  });

  it('is visible to the other connection, because it is committed', async () => {
    const restore = await mutateFunction(admin, 'jv_hook.pay()', dropClause(/for update/gi));
    try {
      const { rows } = await b.query(
        "select pg_get_functiondef('jv_hook.pay()'::regprocedure) as d"
      );
      expect(rows[0].d).not.toMatch(/for update/i);
    } finally {
      await restore();
    }
  });

  it('refuses a mutation that changes nothing, because a test of nothing would pass for the wrong reason', async () => {
    await expect(mutateFunction(admin, 'jv_hook.pay()', (def) => def)).rejects.toThrow(
      /did not change/i
    );
    await expect(
      mutateFunction(admin, 'jv_hook.pay()', dropClause(/this text is not in the function/g))
    ).rejects.toThrow(/did not change/i);
  });

  it('restores the function even when the code under test throws', async () => {
    const original = await getFunctionDef(admin, 'jv_hook.pay()');
    await expect(
      withMutation(admin, 'jv_hook.pay()', dropClause(/for update/gi), async () => {
        throw new Error('the test blew up');
      })
    ).rejects.toThrow(/blew up/);
    expect(await getFunctionDef(admin, 'jv_hook.pay()')).toBe(original);
  });

  it('refuses a function that does not exist', async () => {
    await expect(getFunctionDef(admin, 'jv_hook.nope()')).rejects.toThrow(/nope/);
  });
});
