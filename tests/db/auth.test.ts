import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginAs, connect } from './pg';
import { apiEnv, createLogin, deleteLogin, restFetch, rpc, signIn, type Login } from './rpc';

// T-D13, and the HTTP halves of T-D06, T-D17 and T-E09. DB02.
// The database halves of these tests are the pgTAP files 010_privileges, 011_profiles and 012_common_triggers. What only a
// real login can show is here: the Auth service with sign-up off, the token a user gets after changing their own metadata,
// the REST API as a signed-in user, and the role's statement timeout as a request sees it.
// Every login made here is deleted again (the profile goes with it).

const root = path.resolve(__dirname, '../..');
let admin: Client;
const logins: Login[] = [];

async function login(appRole?: 'owner' | 'biller' | 'staff'): Promise<Login> {
  const made = await createLogin({ appRole });
  logins.push(made);
  return made;
}

async function usersCount(): Promise<number> {
  return (await admin.query('select count(*)::int as n from auth.users')).rows[0].n;
}

async function profileOf(id: string) {
  const { rows } = await admin.query(
    'select role, active, full_name from public.profiles where id = $1',
    [id]
  );
  return rows[0] as { role: string; active: boolean; full_name: string } | undefined;
}

function tokenClaims(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
}

async function authFetch(
  pathAndQuery: string,
  options: { token?: string; method?: string; body?: unknown } = {}
) {
  const env = apiEnv();
  const response = await fetch(`${env.apiUrl}${pathAndQuery}`, {
    method: options.method ?? 'POST',
    headers: {
      apikey: env.publishableKey,
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

beforeAll(async () => {
  admin = await connect('auth-admin');
});

afterAll(async () => {
  for (const made of logins.splice(0)) await deleteLogin(made.id).catch(() => undefined);
  await admin?.end();
});

describe('T-D13: an anonymous sign-up fails (U2: sign-up is off)', () => {
  it('refuses an email and password sign-up, and makes no login', async () => {
    const before = await usersCount();
    const email = `signup-${Date.now()}@jv-test.local`;
    const res = await authFetch('/auth/v1/signup', {
      body: { email, password: 'a-long-enough-password-1' },
    });
    expect(res.status).toBe(422);
    expect(res.body.error_code).toBe('signup_disabled');
    expect(JSON.stringify(res.body)).toMatch(/signups not allowed/i);
    expect(await usersCount()).toBe(before);
    expect(
      (await admin.query('select count(*)::int as n from auth.users where email = $1', [email]))
        .rows[0].n
    ).toBe(0);
  });

  it('refuses an anonymous sign-in (a sign-up call with no email and no password)', async () => {
    const before = await usersCount();
    const res = await authFetch('/auth/v1/signup', { body: {} });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(res.body.access_token).toBeUndefined();
    expect(await usersCount()).toBe(before);
  });

  it('refuses a one-time-code request that would make a new login', async () => {
    const before = await usersCount();
    const res = await authFetch('/auth/v1/otp', {
      body: { email: `otp-${Date.now()}@jv-test.local`, create_user: true },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await usersCount()).toBe(before);
  });

  it('refuses a phone sign-up', async () => {
    const before = await usersCount();
    const res = await authFetch('/auth/v1/signup', {
      body: { phone: '+910000000099', password: 'a-long-enough-password-1' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await usersCount()).toBe(before);
  });

  it('still lets the person who holds the secret key make a login (the dashboard does the same)', async () => {
    const made = await login();
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('T-D17: only the public schema is exposed and GraphQL is off', () => {
  it('has api.schemas = ["public"] in the committed config', () => {
    const toml = readFileSync(path.join(root, 'supabase/config.toml'), 'utf8');
    const section = /^\[api\]\s*$([\s\S]*?)(?=^\[)/m.exec(toml)?.[1] ?? '';
    const line = /^schemas\s*=\s*(\[.*\])\s*$/m.exec(section)?.[1];
    expect(line).toBeDefined();
    expect(JSON.parse(line as string)).toEqual(['public']);
  });

  it('refuses every other schema as a profile: graphql_public, storage, auth, private, tests, extensions', async () => {
    for (const schema of ['graphql_public', 'storage', 'auth', 'private', 'tests', 'extensions']) {
      const read = await restFetch('/rest/v1/', { headers: { 'accept-profile': schema } });
      expect(read.status, `read ${schema}`).toBe(406);
      const write = await restFetch('/rest/v1/rpc/now_ts', {
        method: 'POST',
        headers: { 'content-profile': schema },
        body: {},
      });
      expect(write.status, `call in ${schema}`).toBe(406);
    }
  });

  it('answers a GraphQL introspection query from anon with an error, never a schema', async () => {
    const res = await authFetch('/graphql/v1', {
      body: { query: '{ __schema { queryType { name } types { name } } }' },
    });
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('__schema');
    expect(JSON.stringify(res.body)).not.toContain('queryType');
  });

  it('has no GraphQL extension in the database', async () => {
    const { rows } = await admin.query(
      "select count(*)::int as n from pg_extension where extname = 'pg_graphql'"
    );
    expect(rows[0].n).toBe(0);
  });

  it('does not offer the helpers of private or tests as functions of the API', async () => {
    const owner = await login('owner');
    for (const fn of [
      'now_ts',
      'today',
      'app_role',
      'activate_user',
      'jv_error',
      'set_updated_at',
      'force_person_columns',
      'handle_new_user',
      'protect_own_profile',
      'enable_rls_on_new_tables',
      'make_user',
      'set_clock',
    ]) {
      const res = await rpc(owner, fn, {}, { schemaWaitMs: 0 });
      expect(res.status, fn).toBe(404);
      expect((res.body as { code: string }).code, fn).toBe('PGRST202');
    }
  });
});

describe('T-D06: a user cannot change their own role or active; user metadata has no effect', () => {
  let owner: Login;
  let biller: Login;
  let staff: Login;
  let other: Login;

  beforeAll(async () => {
    owner = await login('owner');
    biller = await login('biller');
    staff = await login('staff');
    other = await login('biller');
  });

  it('a biller who writes role = owner into her own user metadata is still a biller', async () => {
    const put = await authFetch('/auth/v1/user', {
      method: 'PUT',
      token: biller.accessToken,
      body: { data: { role: 'owner', active: true } },
    });
    expect(put.status).toBe(200);
    expect((put.body.user_metadata as { role?: string }).role).toBe('owner');

    // a fresh token now carries the metadata the user wrote
    const fresh = await signIn(biller.email, biller.password);
    expect((tokenClaims(fresh.accessToken).user_metadata as { role?: string }).role).toBe('owner');

    const mine = await restFetch(`/rest/v1/profiles?id=eq.${biller.id}&select=role,active`, {
      token: fresh.accessToken,
    });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual([{ role: 'biller', active: true }]);

    // and the database helper, called with exactly that token's claims, still says biller
    const tx = await beginAs(admin, {
      role: 'authenticated',
      userId: biller.id,
      claims: {
        user_metadata: tokenClaims(fresh.accessToken).user_metadata as Record<string, unknown>,
        app_metadata: tokenClaims(fresh.accessToken).app_metadata as Record<string, unknown>,
      },
    });
    try {
      expect((await tx.query('select private.app_role() as r')).rows[0].r).toBe('biller');
    } finally {
      await tx.rollback();
    }
    expect((await profileOf(biller.id))?.role).toBe('biller');
  });

  it('a biller who patches her own role changes nothing: she has no update policy', async () => {
    const res = await restFetch(`/rest/v1/profiles?id=eq.${biller.id}`, {
      method: 'PATCH',
      token: biller.accessToken,
      headers: { prefer: 'return=representation' },
      body: { role: 'owner' },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.body).toEqual([]);
    expect((await profileOf(biller.id))?.role).toBe('biller');
  });

  it('staff cannot patch anyone either', async () => {
    const res = await restFetch(`/rest/v1/profiles?id=eq.${other.id}`, {
      method: 'PATCH',
      token: staff.accessToken,
      headers: { prefer: 'return=representation' },
      body: { full_name: 'Hacked', active: false },
    });
    expect(res.status).toBeLessThan(300);
    expect(res.body).toEqual([]);
    expect((await profileOf(other.id))?.full_name).not.toBe('Hacked');
  });

  it('the owner cannot change her own role or active: the database refuses with JV_FORBIDDEN', async () => {
    for (const change of [{ role: 'biller' }, { active: false }]) {
      const res = await restFetch(`/rest/v1/profiles?id=eq.${owner.id}`, {
        method: 'PATCH',
        token: owner.accessToken,
        headers: { prefer: 'return=representation' },
        body: change,
      });
      expect(res.status, JSON.stringify(change)).toBe(400);
      expect((res.body as unknown as { message: string }).message).toMatch(/^JV_FORBIDDEN/);
    }
    expect(await profileOf(owner.id)).toMatchObject({ role: 'owner', active: true });
  });

  it('the owner can change another profile over the API, and her own name', async () => {
    const one = await restFetch(`/rest/v1/profiles?id=eq.${other.id}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { prefer: 'return=representation' },
      body: { role: 'staff', active: false },
    });
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject([{ role: 'staff', active: false }]);
    expect(await profileOf(other.id)).toMatchObject({ role: 'staff', active: false });

    const two = await restFetch(`/rest/v1/profiles?id=eq.${owner.id}`, {
      method: 'PATCH',
      token: owner.accessToken,
      headers: { prefer: 'return=representation' },
      body: { full_name: 'The owner' },
    });
    expect(two.status).toBe(200);
    expect(two.body).toMatchObject([{ full_name: 'The owner' }]);
  });

  it('an inactive login reads no profile, and anon is refused', async () => {
    const inactive = await login();
    const own = await restFetch('/rest/v1/profiles?select=id', { token: inactive.accessToken });
    expect(own.status).toBe(200);
    expect(own.body).toEqual([]);
    const anon = await restFetch('/rest/v1/profiles?select=id');
    expect([401, 403]).toContain(anon.status);
    expect((anon.body as unknown as { code: string }).code).toBe('42501');
  });

  it('every active role reads every profile', async () => {
    const total = (await admin.query('select count(*)::int as n from public.profiles')).rows[0].n;
    for (const who of [owner, biller, staff]) {
      const res = await restFetch('/rest/v1/profiles?select=id', { token: who.accessToken });
      expect(res.status).toBe(200);
      expect((res.body as unknown[]).length).toBe(total);
    }
  });
});

describe('T-E09: a login made the way the dashboard makes it', () => {
  it('gets a profile of inactive staff, named by the part of its email before the @', async () => {
    const made = await login();
    const profile = await profileOf(made.id);
    expect(profile).toEqual({
      role: 'staff',
      active: false,
      full_name: made.email.split('@')[0],
    });
  });

  it('reads nothing until the runbook snippet activates it, and then reads', async () => {
    const made = await login();
    const before = await restFetch('/rest/v1/profiles?select=id', { token: made.accessToken });
    expect(before.status).toBe(200);
    expect(before.body).toEqual([]);

    // the snippet of the runbook: three values to change
    const run = await admin.query('select private.activate_user($1, $2, $3) as r', [
      made.email,
      'biller',
      'Ramesh Kumar',
    ]);
    expect(run.rows[0].r).toMatchObject({
      id: made.id,
      email: made.email,
      role: 'biller',
      full_name: 'Ramesh Kumar',
      active: true,
    });

    // the same token, with no new sign-in: the role is looked up on every request
    const after = await restFetch(
      `/rest/v1/profiles?id=eq.${made.id}&select=role,full_name,active`,
      {
        token: made.accessToken,
      }
    );
    expect(after.status).toBe(200);
    expect(after.body).toEqual([{ role: 'biller', full_name: 'Ramesh Kumar', active: true }]);
  });

  it('removes the profile with the login, so a test login leaves nothing behind', async () => {
    const made = await createLogin();
    expect(await profileOf(made.id)).toBeDefined();
    await deleteLogin(made.id);
    expect(await profileOf(made.id)).toBeUndefined();
  });
});

describe("C4: the role's statement timeout as a request sees it", () => {
  const FN = 'jv_auth_timeout';

  beforeAll(async () => {
    await admin.query(`
      create or replace function public.${FN}() returns text language sql stable set search_path = ''
        as $f$ select current_setting('statement_timeout') $f$;
      revoke all on function public.${FN}() from public, anon;
      grant execute on function public.${FN}() to authenticated;
      notify pgrst, 'reload schema';
    `);
  });

  afterAll(async () => {
    await admin?.query(`drop function if exists public.${FN}(); notify pgrst, 'reload schema';`);
  });

  const seenTimeout = async (who: Login) => (await rpc<string>(who, FN)).body;

  it('is 15 seconds for a signed-in request, the setting of migration 0001', async () => {
    const who = await login();
    expect(await seenTimeout(who)).toBe('15s');
    const { rows } = await admin.query(
      "select c from pg_roles r, unnest(r.rolconfig) c where r.rolname = 'authenticated' and c like 'statement_timeout=%'"
    );
    expect(rows.map((r) => r.c)).toEqual(['statement_timeout=15s']);
  });

  it('follows a change of the setting once the API is told with notify pgrst, reload config', async () => {
    const who = await login();
    try {
      await admin.query("alter role authenticated set statement_timeout = '9s'");
      await admin.query("notify pgrst, 'reload config'");
      let seen = await seenTimeout(who);
      for (let i = 0; i < 40 && seen !== '9s'; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        seen = await seenTimeout(who);
      }
      expect(seen).toBe('9s');
    } finally {
      await admin.query("alter role authenticated set statement_timeout = '15s'");
      await admin.query("notify pgrst, 'reload config'");
    }
    let back = await seenTimeout(who);
    for (let i = 0; i < 40 && back !== '15s'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      back = await seenTimeout(who);
    }
    expect(back).toBe('15s');
  });
});
