import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as lane from '../../scripts/lane.mjs';
import dbConfig from '../db/vitest.config';

// DB01: the per-agent lane tool and what it wires into the repository (PT-H1, T-F04, H5).
// None of these tests needs Docker: the stack itself is proved by tests/db and supabase/tests/database.

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const committedConfig = () => read('supabase/config.toml');

/** Value of `key` in `[section]` of a TOML text; commented lines never count. */
function tomlValue(text: string, section: string, key: string): string | undefined {
  let current = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#') || line === '') continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(line);
    if (kv && current === section && kv[1] === key) return kv[2].replace(/\s+#.*$/, '').trim();
  }
  return undefined;
}

describe('lanes and ports', () => {
  it('knows exactly the four lanes main, a, b and c', () => {
    expect([...lane.LANES]).toEqual(['main', 'a', 'b', 'c']);
  });

  it('refuses a missing or unknown lane with a message that names the valid ones', () => {
    expect(() => lane.assertLane(undefined)).toThrow(/LANE/);
    expect(() => lane.assertLane('')).toThrow(/main, a, b, c/);
    expect(() => lane.assertLane('d')).toThrow(/main, a, b, c/);
    expect(lane.assertLane('a')).toBe('a');
  });

  it('gives each lane its own project id', () => {
    expect(lane.LANES.map((l: string) => lane.projectId(l))).toEqual([
      'jv-main',
      'jv-a',
      'jv-b',
      'jv-c',
    ]);
  });

  it('puts the lanes in the blocks main 443xx, a 453xx, b 463xx and c 473xx', () => {
    const blocks = lane.LANES.map((l: string) => {
      const ports = lane.lanePorts(l, committedConfig());
      return [ports.api, ports.db];
    });
    expect(blocks).toEqual([
      [44321, 44322],
      [45321, 45322],
      [46321, 46322],
      [47321, 47322],
    ]);
  });

  it('keeps every port of every lane distinct, valid, below the dynamic range and clear of 543xx', () => {
    const seen = new Map<number, string>();
    for (const l of lane.LANES as string[]) {
      const ports = lane.lanePorts(l, committedConfig()) as Record<string, number>;
      for (const [name, port] of Object.entries(ports)) {
        expect(port, `${l} ${name}`).toBeGreaterThanOrEqual(1024);
        expect(port, `${l} ${name}`).toBeLessThan(49152);
        expect(
          port >= 54320 && port <= 54329,
          `${l} ${name} is in Harsh's other project's block`
        ).toBe(false);
        const clash = seen.get(port);
        expect(clash, `${l} ${name} (${port}) clashes with ${clash}`).toBeUndefined();
        seen.set(port, `${l} ${name}`);
      }
    }
  });

  it('gives each lane its own dev-server port, main keeping 4028', () => {
    expect(lane.LANES.map((l: string) => lane.devPort(l))).toEqual([4028, 4128, 4228, 4328]);
  });

  it('can see whether a port is free', async () => {
    const net = await import('node:net');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const { port } = server.address() as import('node:net').AddressInfo;
    expect(await lane.isPortFree(port)).toBe(false);
    await new Promise((resolve) => server.close(resolve));
    expect(await lane.isPortFree(port)).toBe(true);
  });
});

describe('renderLaneConfig', () => {
  const sample = [
    '# comment with port = 11111',
    'project_id = "jewelvault"',
    '',
    '[api]',
    'port = 44321',
    '# port = 22222',
    '',
    '[db]',
    'port = 44322',
    'shadow_port = 44320',
    '',
    '[auth]',
    'site_url = "http://127.0.0.1:4028"',
    '',
  ].join('\n');

  it('gives lane a its own project id and shifts every active port by 1000', () => {
    const out = lane.renderLaneConfig(sample, 'a');
    expect(out).toContain('project_id = "jv-a"');
    expect(out).toMatch(/^port = 45321$/m);
    expect(out).toMatch(/^port = 45322$/m);
    expect(out).toMatch(/^shadow_port = 45320$/m);
    expect(out).not.toContain('44321');
    expect(out).not.toContain('jewelvault');
  });

  it('leaves commented lines alone', () => {
    const out = lane.renderLaneConfig(sample, 'b');
    expect(out).toContain('# comment with port = 11111');
    expect(out).toContain('# port = 22222');
  });

  it("points the auth site url at the lane's dev server", () => {
    expect(lane.renderLaneConfig(sample, 'c')).toContain('site_url = "http://127.0.0.1:4328"');
    expect(lane.renderLaneConfig(sample, 'main')).toContain('site_url = "http://127.0.0.1:4028"');
  });

  it('marks the file as generated so nobody edits it by hand', () => {
    expect(lane.renderLaneConfig(sample, 'a').split('\n')[0]).toMatch(
      /generated by scripts\/lane\.mjs/i
    );
  });

  it('keeps lane main on the committed ports', () => {
    const out = lane.renderLaneConfig(sample, 'main');
    expect(out).toMatch(/^port = 44321$/m);
    expect(out).toContain('project_id = "jv-main"');
  });

  it('refuses a config with no project id', () => {
    expect(() => lane.renderLaneConfig('[api]\nport = 1\n', 'a')).toThrow(/project_id/);
  });

  it('refuses to shift a port past the end of the valid range', () => {
    expect(() => lane.renderLaneConfig('project_id = "x"\n[api]\nport = 48400\n', 'c')).toThrow(
      /49152|range/
    );
  });
});

describe('the committed supabase/config.toml says what the spec says', () => {
  const text = () => committedConfig();

  it('uses the project id jewelvault and the main block 443xx', () => {
    expect(text()).toMatch(/^project_id = "jewelvault"$/m);
    expect(tomlValue(text(), 'api', 'port')).toBe('44321');
    expect(tomlValue(text(), 'db', 'port')).toBe('44322');
  });

  it('exposes only the public schema and caps a response at 1000 rows (S1, C3, H3)', () => {
    expect(tomlValue(text(), 'api', 'schemas')).toBe('["public"]');
    expect(tomlValue(text(), 'api', 'max_rows')).toBe('1000');
  });

  it('auto-exposes new tables, the worst case, so the access tests prove the revokes of 0001', () => {
    expect(tomlValue(text(), 'api', 'auto_expose_new_tables')).toBe('true');
  });

  it('has sign-up off and a 10 character minimum password (U2, U9)', () => {
    expect(tomlValue(text(), 'auth', 'enable_signup')).toBe('false');
    expect(tomlValue(text(), 'auth', 'minimum_password_length')).toBe('10');
  });

  it('runs the seeds in supabase/seeds, locally only', () => {
    expect(tomlValue(text(), 'db.seed', 'sql_paths')).toBe('["./seeds/*.sql"]');
    expect(tomlValue(text(), 'db.seed', 'enabled')).toBe('true');
  });

  it('is Postgres 17', () => {
    expect(tomlValue(text(), 'db', 'major_version')).toBe('17');
  });

  it('keeps every active port inside the main block', () => {
    const ports = Object.values(lane.lanePorts('main', text())) as number[];
    expect(ports.length).toBeGreaterThan(3);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(44320);
      expect(port).toBeLessThanOrEqual(44329);
    }
  });
});

describe('renderEnvLocal', () => {
  const env = () =>
    lane.renderEnvLocal('a', {
      apiUrl: 'http://127.0.0.1:45321',
      dbUrl: 'postgresql://user@127.0.0.1:45322/postgres',
      publishableKey: 'sb_publishable_example',
    });

  it('holds the API URL, the database URL, the publishable key and the dev-server port', () => {
    const text = env();
    expect(text).toMatch(/^NEXT_PUBLIC_SUPABASE_URL=http:\/\/127\.0\.0\.1:45321$/m);
    expect(text).toMatch(/^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_example$/m);
    expect(text).toMatch(/^DATABASE_URL=postgresql:\/\/user@127\.0\.0\.1:45322\/postgres$/m);
    expect(text).toMatch(/^PORT=4128$/m);
    expect(text).toMatch(/^JV_LANE=a$/m);
  });

  it('never carries a secret or service key', () => {
    expect(env()).not.toMatch(/secret|service_role/i);
  });

  it('starts with the marker that says the tool owns the file', () => {
    expect(env().split('\n')[0]).toBe(lane.ENV_MARKER);
  });
});

describe('the verify plan', () => {
  const scripts = {
    typecheck: 'x',
    'lint:changed': 'x',
    test: 'x',
    'db:check': 'x',
    'db:test': 'x',
    'db:test:2': 'x',
    build: 'x',
  };

  it('runs the steps in the order of the brief', () => {
    const names = lane
      .planVerify({ ...scripts, 'build:check': 'x', 'test:e2e': 'x' })
      .map((s: { name: string }) => s.name);
    expect(names).toEqual([
      'typecheck',
      'lint (changed files)',
      'unit',
      'db:check',
      'db:test',
      'db:test:2',
      'build',
      'build check',
      'e2e',
    ]);
  });

  it('skips a step whose script does not exist yet and names the task that adds it', () => {
    const plan = lane.planVerify(scripts) as Array<{ name: string; skip?: string }>;
    expect(plan.find((s) => s.name === 'build check')?.skip).toBe('skipped (task FE06)');
    expect(plan.find((s) => s.name === 'e2e')?.skip).toBe('skipped (task FE02)');
    expect(plan.find((s) => s.name === 'typecheck')?.skip).toBeUndefined();
  });

  it('runs the step as soon as its script exists', () => {
    const plan = lane.planVerify({ ...scripts, 'build:check': 'x' }) as Array<{
      name: string;
      skip?: string;
    }>;
    expect(plan.find((s) => s.name === 'build check')?.skip).toBeUndefined();
  });

  it('marks the steps that need the lane stack', () => {
    const plan = lane.planVerify(scripts) as Array<{ name: string; needsLane: boolean }>;
    expect(plan.filter((s) => s.needsLane).map((s) => s.name)).toEqual([
      'db:check',
      'db:test',
      'db:test:2',
    ]);
  });
});

describe('lint targets', () => {
  it('keeps only the lintable source files that still exist', () => {
    const files = [
      'src/lib/a.ts',
      'src/app/page.tsx',
      'scripts/lane.mjs',
      'README.md',
      'package.json',
      'supabase/config.toml',
      'src/gone.ts',
    ];
    const kept = lane.lintTargets(files, (f: string) => f !== 'src/gone.ts');
    expect(kept).toEqual(['src/lib/a.ts', 'src/app/page.tsx', 'scripts/lane.mjs']);
  });
});

describe('repository wiring', () => {
  const pkg = () => JSON.parse(read('package.json'));

  it('pins the Supabase CLI to one exact version', () => {
    expect(pkg().devDependencies.supabase).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('adds pg and its types', () => {
    expect(pkg().devDependencies.pg).toBeTruthy();
    expect(pkg().devDependencies['@types/pg']).toBeTruthy();
  });

  it('has the database scripts and verify', () => {
    const scripts = pkg().scripts;
    for (const name of [
      'db:start',
      'db:stop',
      'db:reset',
      'db:test',
      'db:test:2',
      'db:check',
      'verify',
      'lint:changed',
    ]) {
      expect(scripts[name], name).toBeTruthy();
    }
  });

  it('stops without deleting volumes unless --no-backup is passed explicitly', () => {
    expect(pkg().scripts['db:stop']).not.toMatch(/no-backup/);
  });

  it('takes the dev-server port from PORT, 4028 when it is not set', () => {
    expect(pkg().scripts.dev).toMatch(/\$\{PORT:-4028\}/);
  });

  it('ignores .lanes/ and lets .env.*.example files in', () => {
    const ignored = (file: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', file], { cwd: root });
        return true;
      } catch {
        return false;
      }
    };
    expect(ignored('.lanes/a/supabase/config.toml')).toBe(true);
    expect(ignored('.env.local')).toBe(true);
    expect(ignored('.env')).toBe(true);
    expect(ignored('.env.test.example')).toBe(false);
  });
});

describe('playwright.config.ts', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('runs one worker, not fully parallel, on the port from PORT', async () => {
    vi.stubEnv('PORT', '4321');
    vi.resetModules();
    const config = (await import('../../playwright.config')).default;
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
    expect(config.use?.baseURL).toBe('http://localhost:4321');
    const server = config.webServer as { url: string; env?: Record<string, string> };
    expect(server.url).toBe('http://localhost:4321');
    expect(server.env?.PORT).toBe('4321');
  });

  it('falls back to 4028 when PORT is not set', async () => {
    vi.stubEnv('PORT', '');
    vi.resetModules();
    const config = (await import('../../playwright.config')).default;
    expect(config.use?.baseURL).toBe('http://localhost:4028');
  });
});

describe('tests/db/vitest.config.ts', () => {
  it('runs the database test files one at a time, because they share one database per lane', () => {
    expect(dbConfig.test?.fileParallelism).toBe(false);
    expect(dbConfig.test?.include).toEqual(['tests/db/**/*.test.ts']);
  });

  it('gives a slow two-session test room to finish', () => {
    expect(dbConfig.test?.testTimeout).toBeGreaterThanOrEqual(60_000);
  });
});
