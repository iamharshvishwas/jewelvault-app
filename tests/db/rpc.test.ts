import { randomBytes } from 'node:crypto';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect } from './pg';
import { apiEnv, createLogin, deleteLogin, restFetch, rpc, signIn, type Login } from './rpc';

// PT-H1 (harness smoke): a real login through the Auth admin API and calls over HTTP. DB01.
// The pgTAP way of impersonating a user does not go through the API's gateway, JWT check and role settings; this does.
// That is what lets a later test see the role's 15-second statement timeout (DB18c).

let admin: Client;
const logins: Login[] = [];
let usersBefore = 0;

beforeAll(async () => {
  admin = await connect('rpc-admin');
  usersBefore = (await admin.query('select count(*)::int as n from auth.users')).rows[0].n;
  await admin.query(`
    create or replace function public.jv_harness_whoami() returns jsonb
      language sql stable set search_path = ''
      as $f$
        select jsonb_build_object(
          'uid', auth.uid(),
          'role', current_user,
          'statement_timeout', current_setting('statement_timeout'),
          'claims_role', auth.role());
      $f$;
    revoke all on function public.jv_harness_whoami() from public, anon;
    grant execute on function public.jv_harness_whoami() to authenticated;
    notify pgrst, 'reload schema';
  `);
});

afterAll(async () => {
  for (const login of logins) await deleteLogin(login.id).catch(() => undefined);
  await admin?.query(
    "drop function if exists public.jv_harness_whoami(); notify pgrst, 'reload schema';"
  );
  await admin?.end();
});

describe('apiEnv', () => {
  it('knows the lane API URL and keys without any of them being written to a file', () => {
    const env = apiEnv();
    expect(env.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.publishableKey).toBeTruthy();
    expect(env.secretKey).toBeTruthy();
  });
});

describe('a real login through the Auth admin API', () => {
  it('creates a confirmed user with a random password and signs in', async () => {
    const login = await createLogin();
    logins.push(login);
    expect(login.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(login.email).toMatch(/@jv-test\.local$/);
    expect(login.accessToken.split('.')).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString());
    expect(claims.sub).toBe(login.id);
    expect(claims.role).toBe('authenticated');
  });

  it('gives each login its own password, never a fixed one', async () => {
    const one = await createLogin();
    const two = await createLogin();
    logins.push(one, two);
    expect(one.password).not.toBe(two.password);
    expect(one.password.length).toBeGreaterThanOrEqual(16);
  });

  it('deletes the login again', async () => {
    const login = await createLogin();
    await deleteLogin(login.id);
    const { rows } = await admin.query('select count(*)::int as n from auth.users where id = $1', [
      login.id,
    ]);
    expect(rows[0].n).toBe(0);
  });
});

describe('a login made by tests.make_user', () => {
  it('is a row the Auth service accepts: with a password set, the user can sign in', async () => {
    const { rows } = await admin.query("select tests.make_user('staff') as id");
    const id = rows[0].id as string;
    const password = `${randomBytes(18).toString('base64url')}Aa1`;
    try {
      await admin.query(
        "update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')) where id = $1",
        [id, password]
      );
      const email = (await admin.query('select email from auth.users where id = $1', [id])).rows[0]
        .email;
      const tokens = await signIn(email, password);
      expect(tokens.id).toBe(id);
    } finally {
      await deleteLogin(id);
    }
  });

  it('is not a login while it keeps the random password make_user gave it', async () => {
    const { rows } = await admin.query("select tests.make_user('owner') as id");
    const id = rows[0].id as string;
    try {
      const email = (await admin.query('select email from auth.users where id = $1', [id])).rows[0]
        .email;
      await expect(signIn(email, 'a-guess-that-is-long-enough-1')).rejects.toThrow(
        /sign-in .* failed: 400/
      );
    } finally {
      await deleteLogin(id);
    }
  });
});

describe('calling a function over HTTP as that login', () => {
  let login: Login;
  beforeAll(async () => {
    login = await createLogin();
    logins.push(login);
  });

  it('arrives as role authenticated with the login in auth.uid()', async () => {
    const res = await rpc(login, 'jv_harness_whoami');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      uid: login.id,
      role: 'authenticated',
      claims_role: 'authenticated',
    });
    expect(res.ms).toBeGreaterThanOrEqual(0);
  });

  it("sees the role's own statement timeout, which a pgTAP test cannot", async () => {
    const res = await rpc(login, 'jv_harness_whoami');
    const { rows } = await admin.query(
      "select split_part(c, '=', 2) as t from pg_roles r, unnest(r.rolconfig) c where r.rolname = 'authenticated' and c like 'statement_timeout=%'"
    );
    expect(rows).toHaveLength(1);
    expect((res.body as { statement_timeout: string }).statement_timeout).toBe(rows[0].t);
  });

  it('is refused for a caller with no login: the function is granted to authenticated only', async () => {
    const res = await rpc(null, 'jv_harness_whoami');
    expect([401, 403]).toContain(res.status);
    expect((res.body as { code: string }).code).toBe('42501');
  });

  it('waits for the API to learn about a function that was just created', async () => {
    await admin.query(`
      create or replace function public.jv_harness_late() returns int language sql stable set search_path = '' as 'select 7';
      grant execute on function public.jv_harness_late() to authenticated;
      notify pgrst, 'reload schema';
    `);
    try {
      const res = await rpc(login, 'jv_harness_late');
      expect(res.status).toBe(200);
      expect(res.body).toBe(7);
    } finally {
      await admin.query("drop function public.jv_harness_late(); notify pgrst, 'reload schema'");
    }
  });
});

describe('what the local API is set up to refuse (config.toml)', () => {
  it('refuses a public sign-up (U2: auth.enable_signup = false)', async () => {
    const env = apiEnv();
    const res = await fetch(`${env.apiUrl}/auth/v1/signup`, {
      method: 'POST',
      headers: { apikey: env.publishableKey, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@jv-test.local', password: 'a-long-enough-password-1' }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/signups not allowed/i);
  });

  it('refuses a password shorter than 10 characters (U9)', async () => {
    const env = apiEnv();
    const res = await fetch(`${env.apiUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        apikey: env.secretKey,
        authorization: `Bearer ${env.secretKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'short@jv-test.local',
        password: 'short1',
        email_confirm: true,
      }),
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/10 characters/);
  });

  it('exposes the public schema only: tests and private are refused (S1)', async () => {
    for (const schema of ['tests', 'private']) {
      const res = await restFetch('/rest/v1/', { headers: { 'accept-profile': schema } });
      expect(res.status, schema).toBe(406);
      expect(JSON.stringify(res.body)).toMatch(/PGRST106|invalid schema/i);
    }
  });
});

describe('cleaning up', () => {
  it('leaves no login behind', async () => {
    for (const login of logins.splice(0)) await deleteLogin(login.id);
    const { rows } = await admin.query('select count(*)::int as n from auth.users');
    expect(rows[0].n).toBe(usersBefore);
  });
});
