import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as laneTool from '../../scripts/lane.mjs';
import { connect } from './pg';

// T-F04 (BUILD), the database half: the fingerprint that `npm run db:check` takes after each of two fresh applications
// of the migrations must see every kind of thing a migration can change. A fingerprint that missed a kind of change
// would let two different schemas look the same, so each kind is added to the lane database here, seen, and removed.
// (The file rules of S9 are tested in tests/unit/migrations-check.test.ts.)

const root = path.resolve(__dirname, '../..');
let admin: Client;

function fingerprint(): string {
  const lane = process.env.JV_LANE ?? process.env.LANE;
  return execFileSync('node', ['scripts/lane.mjs', 'fingerprint'], {
    cwd: root,
    env: { ...process.env, LANE: lane },
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
}

// postgres is not a superuser in the Supabase image: it may change the default privileges of, and drop what is owned
// by, a role only when it holds that role with SET, so the test role is granted to it as soon as it exists.
const ENSURE_ROLE = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'jv_fp_role') then create role jv_fp_role nologin; end if;
  end $$;
  grant jv_fp_role to postgres with inherit true, set true;
`;

const CLEAN = `
  drop event trigger if exists jv_fp_evt;
  drop schema if exists jv_fp cascade;
  drop owned by jv_fp_role;
  drop role if exists jv_fp_role;
`;

beforeAll(async () => {
  admin = await connect('fingerprint');
  // clear what a run that crashed may have left
  await admin.query(ENSURE_ROLE);
  await admin.query(CLEAN);
});

afterAll(async () => {
  await admin?.query(CLEAN).catch(() => undefined);
  await admin?.end();
});

describe('the schema fingerprint', () => {
  it('is the same when it is taken twice from an unchanged database', () => {
    const one = fingerprint();
    const two = fingerprint();
    expect(one.length).toBeGreaterThan(10_000);
    expect(laneTool.compareFingerprints(one, two)).toEqual({ same: true, diff: '' });
  });

  it('sees a table, its row-level security, an event trigger, a global default privilege and a role setting', async () => {
    const before = fingerprint();
    await admin.query(ENSURE_ROLE);
    await admin.query(`
      alter role jv_fp_role set statement_timeout = '3s';
      alter default privileges for role jv_fp_role revoke execute on functions from public;
      create schema jv_fp;
      create table jv_fp.t (id int);
      alter table jv_fp.t enable row level security;
      create function jv_fp.evt() returns event_trigger language plpgsql as $f$ begin null; end $f$;
      create event trigger jv_fp_evt on ddl_command_end execute function jv_fp.evt();
    `);
    try {
      const after = fingerprint();
      const result = laneTool.compareFingerprints(before, after) as { same: boolean; diff: string };
      expect(result.same).toBe(false);
      expect(result.diff).toMatch(/CREATE TABLE jv_fp\.t/i);
      expect(result.diff).toMatch(/ENABLE ROW LEVEL SECURITY/i);
      expect(result.diff).toMatch(/CREATE EVENT TRIGGER jv_fp_evt/i);
      expect(result.diff).toMatch(/DEFAULT PRIVILEGES FOR ROLE jv_fp_role/i);
      expect(result.diff).toMatch(/jv_fp_role.*statement_timeout=3s/i);
    } finally {
      await admin.query(CLEAN);
    }
    expect(laneTool.compareFingerprints(before, fingerprint())).toEqual({ same: true, diff: '' });
  });
});
