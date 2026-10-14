import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backendPid,
  beginAs,
  connect,
  databaseUrl,
  redact,
  twoConnections,
  waitUntilBlocked,
  withRole,
} from './pg';

// PT-H1 (harness smoke, the two-connection half). DB01.
// The pgTAP half is supabase/tests/database/000_smoke.test.sql. Everything here talks to the lane's own stack
// (LANE=a npm run db:test:2) and cleans up what it commits.

const root = path.resolve(__dirname, '../..');
const seedsDir = path.join(root, 'supabase/seeds');

let admin: Client;
let a: Client;
let b: Client;
let closeBoth: () => Promise<void>;

beforeAll(async () => {
  admin = await connect('admin');
  const pair = await twoConnections();
  a = pair.a;
  b = pair.b;
  closeBoth = pair.close;
  await admin.query(`
    drop schema if exists jv_demo cascade;
    create schema jv_demo;
    create table jv_demo.t (id int primary key, v text);
    create function jv_demo.now_ts() returns timestamptz language sql as 'select clock_timestamp()';
    grant usage on schema jv_demo to authenticated, service_role;
    grant all on jv_demo.t to authenticated, service_role;
    drop table if exists public.jv_biz_demo;
    create table public.jv_biz_demo (id int primary key, v text);
  `);
});

afterAll(async () => {
  await closeBoth?.();
  await admin?.query(
    'drop schema if exists jv_demo cascade; drop table if exists public.jv_biz_demo;'
  );
  await admin?.end();
});

describe('the connection helpers (pg.ts)', () => {
  it('reaches the lane database as postgres, PostgreSQL 17', async () => {
    const { rows } = await admin.query(
      "select current_user as u, current_setting('server_version_num')::int / 10000 as major"
    );
    expect(rows[0]).toEqual({ u: 'postgres', major: 17 });
  });

  it('hides the password when it has to print a URL', () => {
    expect(redact('postgresql://postgres:not-a-real-password@127.0.0.1:45322/postgres')).toBe(
      'postgresql://postgres:***@127.0.0.1:45322/postgres'
    );
    expect(databaseUrl()).toMatch(/^postgres(ql)?:\/\//);
  });

  it('says how to start the stack when it cannot connect, without printing the password', async () => {
    const failure = await connect('nowhere', {
      connectionString: 'postgresql://postgres:not-a-real-password@127.0.0.1:1/postgres',
    }).then(
      () => undefined,
      (error: Error) => error
    );
    expect(failure?.message).toMatch(/db:start/);
    expect(failure?.message).not.toContain('not-a-real-password');
  });

  it('bounds every test connection with a statement timeout, so a hung test cannot freeze the suite', async () => {
    const { rows } = await a.query("select current_setting('statement_timeout') as t");
    expect(rows[0].t).not.toBe('0');
  });

  it('gives two connections that are two backends, each with its own name', async () => {
    const [pa, pb] = [await backendPid(a), await backendPid(b)];
    expect(pa).not.toBe(pb);
    const { rows } = await admin.query(
      'select pid, application_name from pg_stat_activity where pid = any($1) order by application_name',
      [[pa, pb]]
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.application_name).toMatch(/^jv-test:/);
  });

  it("keeps one connection's uncommitted work out of sight of the other", async () => {
    await a.query('begin');
    await a.query("insert into jv_demo.t values (1, 'a')");
    expect((await b.query('select count(*)::int as n from jv_demo.t')).rows[0].n).toBe(0);
    await a.query('commit');
    expect((await b.query('select count(*)::int as n from jv_demo.t')).rows[0].n).toBe(1);
  });

  it('hands an advisory lock from one connection to the other', async () => {
    await a.query('select pg_advisory_lock(7001, 1)');
    expect((await b.query('select pg_try_advisory_lock(7001, 1) as got')).rows[0].got).toBe(false);
    await a.query('select pg_advisory_unlock(7001, 1)');
    expect((await b.query('select pg_try_advisory_lock(7001, 1) as got')).rows[0].got).toBe(true);
    await b.query('select pg_advisory_unlock(7001, 1)');
  });

  it('shows who blocks whom without sleeping', async () => {
    await a.query('begin');
    await a.query("update jv_demo.t set v = 'a2' where id = 1");
    const pendingB = b.query("update jv_demo.t set v = 'b2' where id = 1");
    const pidA = await backendPid(a);
    const pidB = await backendPid(b);
    const blockers = await waitUntilBlocked(admin, pidB, { timeoutMs: 5000 });
    expect(blockers).toEqual([pidA]);
    await a.query('rollback');
    await pendingB;
    expect((await b.query('select v from jv_demo.t where id = 1')).rows[0].v).toBe('b2');
  });

  it('reports a wait that never comes instead of waiting for ever', async () => {
    await expect(waitUntilBlocked(admin, await backendPid(b), { timeoutMs: 300 })).rejects.toThrow(
      /not blocked/i
    );
  });
});

describe('withRole and beginAs: the identity of a request', () => {
  it('runs as authenticated with the user in the JWT claims, then puts everything back', async () => {
    const user = randomUUID();
    const seen = await withRole(a, { role: 'authenticated', userId: user }, async (c) => {
      const { rows } = await c.query(
        "select auth.uid() as uid, current_user as u, auth.role() as role, current_setting('request.jwt.claims', true)::jsonb ->> 'sub' as sub"
      );
      return rows[0];
    });
    expect(seen).toEqual({ uid: user, u: 'authenticated', role: 'authenticated', sub: user });
    const after = await a.query('select current_user as u, auth.uid() as uid');
    expect(after.rows[0]).toEqual({ u: 'postgres', uid: null });
  });

  it('runs as anon', async () => {
    const seen = await withRole(
      a,
      { role: 'anon' },
      async (c) => (await c.query('select current_user as u, auth.uid() as uid')).rows[0]
    );
    expect(seen).toEqual({ u: 'anon', uid: null });
  });

  it('rolls the work back unless it is told to commit', async () => {
    await withRole(a, { role: 'service_role' }, async (c) => {
      await c.query("insert into jv_demo.t values (50, 'gone')");
    });
    expect(
      (await a.query('select count(*)::int as n from jv_demo.t where id = 50')).rows[0].n
    ).toBe(0);
    await withRole(
      a,
      { role: 'service_role' },
      async (c) => {
        await c.query("insert into jv_demo.t values (51, 'kept')");
      },
      { commit: true }
    );
    expect(
      (await a.query('select count(*)::int as n from jv_demo.t where id = 51')).rows[0].n
    ).toBe(1);
    await a.query('delete from jv_demo.t where id = 51');
  });

  it('rolls back and resets the role when the work throws', async () => {
    await expect(
      withRole(a, { role: 'authenticated', userId: randomUUID() }, async (c) => {
        await c.query('select 1/0');
      })
    ).rejects.toThrow(/division by zero/);
    expect((await a.query('select current_user as u')).rows[0].u).toBe('postgres');
  });

  it('beginAs leaves the transaction open so a second connection can be tested against it', async () => {
    const tx = await beginAs(a, { role: 'authenticated', userId: randomUUID() });
    await tx.query("insert into jv_demo.t values (60, 'open')");
    expect(
      (await b.query('select count(*)::int as n from jv_demo.t where id = 60')).rows[0].n
    ).toBe(0);
    await tx.rollback();
    expect((await a.query('select current_user as u')).rows[0].u).toBe('postgres');
    expect(
      (await a.query('select count(*)::int as n from jv_demo.t where id = 60')).rows[0].n
    ).toBe(0);
  });
});

describe('the clock seam stays inside the transaction that sets it', () => {
  it('shows the fixed time to its own transaction and the real time to the other connection', async () => {
    const fixed = '2026-12-31T18:29:59.000Z';
    await a.query('begin');
    await a.query('select tests.set_clock($1::timestamptz, $2)', [fixed, 'jv_demo.now_ts']);
    const mine = (await a.query('select jv_demo.now_ts() as t')).rows[0].t as Date;
    const theirs = (await b.query('select jv_demo.now_ts() as t')).rows[0].t as Date;
    expect(mine.toISOString()).toBe(fixed);
    expect(Math.abs(theirs.getTime() - Date.now())).toBeLessThan(10_000);
    await a.query('rollback');
    const afterRollback = (await a.query('select jv_demo.now_ts() as t')).rows[0].t as Date;
    expect(Math.abs(afterRollback.getTime() - Date.now())).toBeLessThan(10_000);
  });
});

describe('tests.reset_business_data with other sessions around', () => {
  it('ends a session that leaked an open transaction, leaves idle ones alone, and empties the business tables', async () => {
    await admin.query("insert into public.jv_biz_demo values (1, 'committed')");
    const leaker = await connect('leak');
    await leaker.query('begin');
    await leaker.query("insert into public.jv_biz_demo values (2, 'leaked')");

    const { rows } = await admin.query('select tests.reset_business_data(true) as r');
    expect(rows[0].r.terminated_backends).toBe(1);
    expect((await admin.query('select count(*)::int as n from public.jv_biz_demo')).rows[0].n).toBe(
      0
    );
    await expect(leaker.query('select 1')).rejects.toThrow(
      /connection error|terminat|closed|ended/i
    );
    await leaker.end().catch(() => undefined);
    // the two idle connections of this file are still alive
    expect((await a.query('select 1 as ok')).rows[0].ok).toBe(1);
    expect((await b.query('select 1 as ok')).rows[0].ok).toBe(1);
  });

  it('gives up after its lock timeout instead of hanging behind a busy session', async () => {
    const busy = await connect('busy');
    const busyPid = await backendPid(busy);
    // A running session (not one idle in a transaction) is left alone: the reset must wait for its lock, then fail fast.
    const sleeping = busy.query(
      'begin; lock table public.jv_biz_demo in access exclusive mode; select pg_sleep(30);'
    );
    sleeping.catch(() => undefined);
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await admin.query(
        "select 1 from pg_locks l join pg_class c on c.oid = l.relation where l.pid = $1 and c.relname = 'jv_biz_demo' and l.mode = 'AccessExclusiveLock' and l.granted",
        [busyPid]
      );
      if (rows.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const started = Date.now();
    await expect(admin.query("select tests.reset_business_data(true, '700ms')")).rejects.toThrow(
      /lock timeout|lock_not_available|could not obtain lock/i
    );
    expect(Date.now() - started).toBeLessThan(8000);
    expect(
      (await admin.query('select state from pg_stat_activity where pid = $1', [busyPid])).rows[0]
        ?.state
    ).toBe('active');
    await admin.query('select pg_cancel_backend($1)', [busyPid]);
    await sleeping.catch(() => undefined);
    await busy.query('rollback').catch(() => undefined);
    await busy.end().catch(() => undefined);
  });
});

describe('the seed guard (00_guard.sql)', () => {
  const guard = () => readFileSync(path.join(seedsDir, '00_guard.sql'), 'utf8');
  const digestIn = (sql: string) => /\b([0-9a-f]{64})\b/.exec(sql)?.[1];

  it('runs before the helpers: 00_ sorts first in the folder the config reads', () => {
    const files = readdirSync(seedsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(files.slice(0, 2)).toEqual(['00_guard.sql', '10_test_helpers.sql']);
  });

  it('lets a local stack through', async () => {
    await expect(admin.query(guard())).resolves.toBeDefined();
  });

  it('refuses a database whose JWT secret is not the local default', async () => {
    const probe = await connect('guard');
    try {
      await probe.query("set app.settings.jwt_secret = 'not-the-local-default'");
      await expect(probe.query(guard())).rejects.toThrow(/seed guard/i);
    } finally {
      await probe.end();
    }
  });

  it('refuses a near miss: the local default with one character added', async () => {
    const probe = await connect('guard');
    try {
      await probe.query(
        "select set_config('app.settings.jwt_secret', current_setting('app.settings.jwt_secret') || ' ', false)"
      );
      await expect(probe.query(guard())).rejects.toThrow(/seed guard/i);
    } finally {
      await probe.end();
    }
  });

  it('refuses a database that has no JWT secret setting at all, as a hosted project may not', async () => {
    await admin.query('drop database if exists jv_guard_probe with (force)');
    await admin.query('create database jv_guard_probe');
    const url = new URL(databaseUrl());
    url.pathname = '/jv_guard_probe';
    const probe = await connect('guard-db', { connectionString: url.toString() });
    try {
      await expect(probe.query(guard())).rejects.toThrow(/seed guard/i);
    } finally {
      await probe.end();
      await admin.query('drop database if exists jv_guard_probe with (force)');
    }
  });

  it('is repeated at the top of the helpers file, in case that file is ever run alone', () => {
    const helpers = readFileSync(path.join(seedsDir, '10_test_helpers.sql'), 'utf8');
    expect(digestIn(helpers)).toBeDefined();
    expect(digestIn(helpers)).toBe(digestIn(guard()));
    const check = helpers.indexOf("raise exception 'seed guard");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(helpers.indexOf('create schema if not exists tests'));
  });

  it('holds no secret, only the SHA-256 digest of the published default', () => {
    expect(guard()).not.toMatch(/super-secret/i);
    expect(digestIn(guard())).toBeDefined();
  });
});
