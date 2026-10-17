import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as e2e from '../../scripts/e2e-lane.mjs';
import globalSetup, { e2eLane, e2eLogin } from '../e2e/global-setup';

// WEB00: the pure parts of the end-to-end lane (scripts/e2e-lane.mjs): ports, the environment of the API, the admin
// command's input and output, the lane's env file. None of these tests needs Docker, the API or a browser: the whole
// chain is proved by the Playwright smoke test (tests/e2e/harness.spec.ts, PT-W0).

const root = path.resolve(__dirname, '../..');
const made: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jv-e2e-lane-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('lanes and ports', () => {
  it('knows the four lanes main, a, b and c, the same as the API repository', () => {
    expect([...e2e.LANES]).toEqual(['main', 'a', 'b', 'c']);
  });

  it('refuses a missing or unknown lane, and a name that is a path', () => {
    expect(() => e2e.assertLane(undefined)).toThrow(/LANE/);
    expect(() => e2e.assertLane('')).toThrow(/main, a, b, c/);
    expect(() => e2e.assertLane('d')).toThrow(/main, a, b, c/);
    expect(() => e2e.assertLane('../a')).toThrow(/main, a, b, c/);
    expect(e2e.assertLane('b')).toBe('b');
  });

  it('gives each lane its own site port (main 4028, a 4128, b 4228, c 4328) and the API the next one', () => {
    const ports = e2e.LANES.map((lane: string) => e2e.lanePorts({ LANE: lane }));
    expect(ports.map((p: { web: number }) => p.web)).toEqual([4028, 4128, 4228, 4328]);
    expect(ports.map((p: { api: number }) => p.api)).toEqual([4029, 4129, 4229, 4329]);
  });

  it('keeps all eight ports distinct, valid and below the range the system hands out', () => {
    const all = e2e.LANES.flatMap((lane: string) => {
      const p = e2e.lanePorts({ LANE: lane });
      return [p.web, p.api];
    });
    expect(new Set(all).size).toBe(all.length);
    for (const port of all) {
      expect(port).toBeGreaterThanOrEqual(1024);
      expect(port).toBeLessThan(49152);
    }
  });

  it('takes the site port from PORT when it is set, and still puts the API one above it', () => {
    expect(e2e.lanePorts({ LANE: 'b', PORT: '4321' })).toMatchObject({ web: 4321, api: 4322 });
    expect(e2e.lanePorts({ PORT: '4321' })).toMatchObject({ web: 4321, api: 4322 });
  });

  it('uses 4028 with no lane and no PORT', () => {
    expect(e2e.lanePorts({})).toMatchObject({ web: 4028, api: 4029 });
    expect(e2e.lanePorts({ PORT: '', LANE: '' })).toMatchObject({ web: 4028, api: 4029 });
  });

  it('refuses a PORT that is not a whole number in the valid range, or leaves no room for the API', () => {
    for (const port of ['abc', '4028.5', '80', '49151', '70000', '-1']) {
      expect(() => e2e.lanePorts({ PORT: port }), port).toThrow(/PORT/);
    }
  });

  it('writes the origins exactly as a browser sends them (the API refuses anything else in ALLOWED_ORIGINS)', () => {
    const p = e2e.lanePorts({ LANE: 'b' });
    expect(p.webOrigin).toBe('http://localhost:4228');
    expect(p.apiOrigin).toBe('http://localhost:4229');
    for (const origin of [p.webOrigin, p.apiOrigin]) expect(new URL(origin).origin).toBe(origin);
  });
});

describe('the API checkout (JV_API_DIR)', () => {
  const fakeApi = (dir: string) => {
    mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'jewelvault-api' }));
    for (const file of ['lane.mjs', 'admin.mjs']) {
      writeFileSync(path.join(dir, 'scripts', file), '// stand-in\n');
    }
  };

  it('is required, and the message names the variable', () => {
    expect(() => e2e.resolveApiDir({})).toThrow(/JV_API_DIR/);
    expect(() => e2e.resolveApiDir({ JV_API_DIR: '' })).toThrow(/JV_API_DIR/);
  });

  it('must be a folder that exists and is a checkout of jewelvault-api', () => {
    expect(() => e2e.resolveApiDir({ JV_API_DIR: path.join(scratch(), 'nope') })).toThrow(
      /does not exist|not a folder/
    );
    expect(() => e2e.resolveApiDir({ JV_API_DIR: scratch() })).toThrow(/jewelvault-api/);
    const other = scratch();
    writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'something-else' }));
    expect(() => e2e.resolveApiDir({ JV_API_DIR: other })).toThrow(/jewelvault-api/);
  });

  it('gives back the absolute path of a good checkout', () => {
    const dir = scratch();
    fakeApi(dir);
    expect(e2e.resolveApiDir({ JV_API_DIR: dir })).toBe(path.resolve(dir));
  });

  it('builds into a folder of its own per lane inside node_modules/.cache, so two lanes never delete each other’s code', () => {
    const a = e2e.apiBuildDir('/x/api', 'a');
    const b = e2e.apiBuildDir('/x/api', 'b');
    expect(a).not.toBe(b);
    for (const dir of [a, b]) expect(dir).toContain(path.join('node_modules', '.cache'));
    expect(path.relative('/x/api', a).startsWith('..')).toBe(false);
  });

  it('knows its own API process from the command line, and nobody else’s', () => {
    const own = `/Users/x/.node/bin/node /x/api/node_modules/.cache/jv-e2e/b/dist/server.js`;
    expect(e2e.isLaneApiCommand(own, 'b')).toBe(true);
    expect(e2e.isLaneApiCommand(own, 'a')).toBe(false);
    expect(e2e.isLaneApiCommand('node /x/api/dist/server.js', 'b')).toBe(false);
    expect(e2e.isLaneApiCommand('/usr/sbin/sshd -D', 'b')).toBe(false);
    expect(e2e.isLaneApiCommand('', 'b')).toBe(false);
  });
});

describe('the environment of the API process', () => {
  const db = {
    host: '127.0.0.1',
    port: 33312,
    name: 'jv_lane',
    user: 'jv_lane',
    password: 'pw-from-docker',
  };
  const make = (base: Record<string, string> = { PATH: '/usr/bin' }) =>
    e2e.apiProcessEnv({
      base,
      db,
      apiPort: 4229,
      webOrigin: 'http://localhost:4228',
      adminTokenHash: 'a'.repeat(64),
    }) as Record<string, string>;

  it('carries the six variables the API requires, the admin door hash and the lane port', () => {
    const env = make();
    expect(env).toMatchObject({
      DB_HOST: '127.0.0.1',
      DB_PORT: '33312',
      DB_NAME: 'jv_lane',
      DB_USER: 'jv_lane',
      DB_PASSWORD: 'pw-from-docker',
      ALLOWED_ORIGINS: 'http://localhost:4228',
      JV_ADMIN_TOKEN_HASH: 'a'.repeat(64),
      PORT: '4229',
    });
  });

  it('allows the origin of the site and no other, never a wildcard (A12)', () => {
    const origins = make().ALLOWED_ORIGINS;
    expect(origins).not.toMatch(/[*,]/);
    expect(origins.endsWith('/')).toBe(false);
  });

  it('keeps the program path but none of the other variables of the shell (no stray secret reaches the API)', () => {
    const env = make({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      SOME_TOKEN: 'abc',
      DB_PASSWORD: 'other',
      JV_ADMIN_TOKEN: 'zzz',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/Users/x');
    expect(env).not.toHaveProperty('SOME_TOKEN');
    expect(env).not.toHaveProperty('JV_ADMIN_TOKEN');
    expect(env.DB_PASSWORD).toBe('pw-from-docker');
  });

  it('asks for a log level that keeps request lines but no body', () => {
    expect(make().LOG_LEVEL).toBe('info');
  });
});

describe('the admin command (npm run admin -- add-user)', () => {
  it('hashes a token the way the door does: SHA-256 of its text, 64 hex characters', () => {
    expect(e2e.tokenHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(e2e.tokenHash(e2e.newToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makes a new random token every time, 43 characters of base64url like make-token', () => {
    const one = e2e.newToken();
    expect(one).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(e2e.newToken()).not.toBe(one);
  });

  it('answers the four questions of add-user in order: token, e-mail, name, role', () => {
    const input = e2e.addUserInput('the-token', {
      email: 'a@b.test',
      fullName: 'Test owner',
      role: 'owner',
    });
    expect(input).toBe('the-token\na@b.test\nTest owner\nowner\n');
  });

  it('reads the temporary password out of what the command prints, and nothing else', () => {
    const output = [
      'Made the user a@b.test (owner).',
      'Temporary password (shown only now, write it down): Xy-12_abcDEF',
      'They must change it when they sign in for the first time.',
      '',
    ].join('\n');
    expect(e2e.parseTemporaryPassword(output)).toBe('Xy-12_abcDEF');
    expect(e2e.parseTemporaryPassword('Made the user a@b.test (owner).\n')).toBeNull();
    expect(e2e.parseTemporaryPassword('')).toBeNull();
  });

  it('makes a password for the test users that is long, random and made of safe characters', () => {
    const one = e2e.newPassword();
    expect(one).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(e2e.newPassword()).not.toBe(one);
  });

  it('makes e-mail addresses that are valid, unique per run and per role, and contain no password', () => {
    const owner = e2e.testEmail('owner', 'ab12cd34');
    expect(owner).toBe('e2e-owner-ab12cd34@jv-test.local');
    expect(e2e.testEmail('biller', 'ab12cd34')).not.toBe(owner);
  });
});

describe('the lane env file (.lanes/<lane>/.env.local)', () => {
  const values = {
    JV_LANE: 'b',
    JV_E2E_API_URL: 'http://localhost:4229',
    JV_E2E_OWNER_EMAIL: 'e2e-owner-1@jv-test.local',
    JV_E2E_OWNER_PASSWORD: 'p=a_s-s',
  };

  it('starts with a marker that says the tool owns the file and that it is never committed', () => {
    const text = e2e.renderLaneEnv(values);
    expect(text.split('\n')[0]).toBe(e2e.ENV_MARKER);
    expect(e2e.ENV_MARKER).toMatch(/never committed/i);
  });

  it('reads back what it wrote, also a value that holds an equals sign', () => {
    expect(e2e.parseLaneEnv(e2e.renderLaneEnv(values))).toEqual(values);
  });

  it('refuses a value with a line break or a name that is not an upper-case variable (no injected line)', () => {
    expect(() => e2e.renderLaneEnv({ JV_X: 'a\nJV_Y=b' })).toThrow(/line break/);
    expect(() => e2e.renderLaneEnv({ 'bad name': 'a' })).toThrow(/name/);
  });

  it('is written inside .lanes/<lane>/ with a mode that only the owner can read', () => {
    const dir = scratch();
    const file = e2e.writeLaneEnv('b', values, { root: dir });
    expect(file).toBe(path.join(dir, '.lanes', 'b', '.env.local'));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(e2e.readLaneEnv('b', { root: dir })).toEqual(values);
  });

  it('is ignored by git, with everything else in .lanes/', () => {
    for (const file of ['.lanes/b/.env.local', '.lanes/b/logs/api.log', '.lanes/b/api.pid']) {
      let ignored = false;
      try {
        execFileSync('git', ['check-ignore', '-q', file], { cwd: root });
        ignored = true;
      } catch {
        ignored = false;
      }
      expect(ignored, file).toBe(true);
    }
  });
});

describe('repository wiring (WEB00)', () => {
  const scripts = () =>
    JSON.parse(execFileSync('cat', [path.join(root, 'package.json')], { encoding: 'utf8' }))
      .scripts;

  it('runs the end-to-end tests with Playwright itself: the global setup starts and stops the lane', () => {
    expect(scripts()['test:e2e']).toBe('playwright test');
  });

  it('has a command to start, stop and look at a lane by hand', () => {
    expect(scripts()['e2e:lane']).toBe('node scripts/e2e-lane.mjs');
  });
});

describe('the global setup of the Playwright tests (tests/e2e/global-setup.ts)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('starts nothing unless E2E=1 says so (it would start Docker containers and servers)', async () => {
    vi.stubEnv('E2E', '');
    vi.stubEnv('LANE', 'b');
    await expect(globalSetup()).rejects.toThrow(/start a MariaDB container and an API/);
    vi.stubEnv('E2E', 'yes');
    await expect(globalSetup()).rejects.toThrow(/start a MariaDB container and an API/);
  });

  it('needs a lane once E2E=1 is set, and says which ones exist', async () => {
    vi.stubEnv('E2E', '1');
    vi.stubEnv('LANE', '');
    await expect(globalSetup()).rejects.toThrow(/main, a, b, c/);
  });

  it('gives a test the login of a role, and a plain message when the lane did not start', () => {
    vi.stubEnv('JV_E2E_OWNER_EMAIL', 'e2e-owner-1@jv-test.local');
    vi.stubEnv('JV_E2E_OWNER_PASSWORD', 'a-test-password-value');
    expect(e2eLogin('owner')).toEqual({
      email: 'e2e-owner-1@jv-test.local',
      password: 'a-test-password-value',
      fullName: 'Test owner',
    });
    vi.stubEnv('JV_E2E_BILLER_EMAIL', '');
    expect(() => e2eLogin('biller')).toThrow(/JV_E2E_BILLER_EMAIL.*global setup did not run/);
  });

  it('gives a test the addresses and the admin token of the lane', () => {
    vi.stubEnv('JV_E2E_API_URL', 'http://localhost:4229');
    vi.stubEnv('JV_E2E_WEB_ORIGIN', 'http://localhost:4228');
    vi.stubEnv('JV_E2E_ADMIN_TOKEN', 'a-test-token-value');
    expect(e2eLane()).toEqual({
      apiUrl: 'http://localhost:4229',
      webOrigin: 'http://localhost:4228',
      adminToken: 'a-test-token-value',
    });
  });
});
