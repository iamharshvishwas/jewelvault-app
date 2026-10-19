import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as verify from '../../scripts/verify.mjs';

// WEB00, kept by WEB15: `npm run verify` and `npm run lint:changed` (scripts/verify.mjs; they lived in the old per-agent lane tool, which WEB15 deleted with the rest of the old
// database pieces). None of these tests needs Docker.

const root = path.resolve(__dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('the verify plan (WEB00)', () => {
  const scripts = {
    typecheck: 'x',
    'lint:changed': 'x',
    test: 'x',
    build: 'x',
    'check:build': 'x',
    'test:e2e': 'x',
  };
  type Step = {
    name: string;
    script: string;
    needsLane: boolean;
    skip?: string;
  };
  const plan = (env: Record<string, string | undefined>) =>
    verify.planVerify(scripts, env) as Step[];

  it('runs typecheck, changed-file lint, unit tests, build, build check and the e2e step, in that order', () => {
    expect(plan({ E2E: '1' }).map((s) => s.name)).toEqual([
      'typecheck',
      'lint (changed files)',
      'unit',
      'build',
      'build check',
      'e2e',
    ]);
  });

  it('runs the e2e step only when E2E=1, and says how to switch it on', () => {
    for (const env of [{}, { E2E: '' }, { E2E: '0' }, { E2E: 'true' }]) {
      expect(plan(env).find((s) => s.name === 'e2e')?.skip, JSON.stringify(env)).toBe(
        'skipped (set E2E=1 to run it)'
      );
    }
    expect(plan({ E2E: '1' }).find((s) => s.name === 'e2e')?.skip).toBeUndefined();
  });

  it('runs the build check (npm run check:build) and the e2e step (npm run test:e2e) by script name', () => {
    const byName = Object.fromEntries(plan({ E2E: '1' }).map((s) => [s.name, s.script]));
    expect(byName['build check']).toBe('check:build');
    expect(byName.e2e).toBe('test:e2e');
  });

  it('calls no database script of the old lanes', () => {
    for (const step of plan({ E2E: '1' })) {
      expect(step.script, step.name).not.toMatch(/^db:/);
    }
  });

  it('needs a lane (a MariaDB container and an API) for the e2e step alone', () => {
    expect(
      plan({ E2E: '1' })
        .filter((s) => s.needsLane)
        .map((s) => s.name)
    ).toEqual(['e2e']);
  });

  it('marks a step whose script is not in package.json, so that verify fails it by name', () => {
    const { typecheck: _removed, ...without } = scripts;
    const steps = verify.planVerify(without, { E2E: '1' }) as Array<{
      name: string;
      missing: boolean;
    }>;
    expect(steps.filter((s) => s.missing).map((s) => s.name)).toEqual(['typecheck']);
  });

  it('every script of the plan is a script of the real package.json', () => {
    const real = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    const steps = verify.planVerify(real, { E2E: '1' }) as Array<{
      name: string;
      missing: boolean;
    }>;
    expect(steps.filter((s) => s.missing)).toEqual([]);
  });

  it('is the package.json script verify, which runs scripts/verify.mjs', () => {
    const real = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(real.verify).toBe('node scripts/verify.mjs verify');
    expect(real['lint:changed']).toBe('node scripts/verify.mjs lint-changed');
  });
});

describe('lint targets', () => {
  it('keeps only the lintable source files that still exist', () => {
    const files = [
      'src/lib/a.ts',
      'src/app/page.tsx',
      'scripts/verify.mjs',
      'README.md',
      'package.json',
      'docs/handoffs.md',
      'src/gone.ts',
    ];
    const kept = verify.lintTargets(files, (f: string) => f !== 'src/gone.ts');
    expect(kept).toEqual(['src/lib/a.ts', 'src/app/page.tsx', 'scripts/verify.mjs']);
  });
});

describe('repository wiring', () => {
  const pkg = () => JSON.parse(read('package.json'));

  it('has the scripts the gates call', () => {
    const scripts = pkg().scripts;
    for (const name of [
      'typecheck',
      'lint',
      'lint:changed',
      'test',
      'build',
      'check:build',
      'test:e2e',
      'e2e:lane',
      'verify',
    ]) {
      expect(scripts[name], name).toBeTruthy();
    }
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
    expect(ignored('.lanes/a/api.log')).toBe(true);
    expect(ignored('.env.local')).toBe(true);
    expect(ignored('.env')).toBe(true);
    expect(ignored('.env.test.example')).toBe(false);
  });
});

describe('playwright.config.ts (WEB00)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  const load = async (env: Record<string, string>) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    return (await import('../../playwright.config')).default;
  };

  it('runs one worker, not fully parallel, on the port from PORT', async () => {
    const config = await load({ PORT: '4321', LANE: '' });
    expect(config.workers).toBe(1);
    expect(config.fullyParallel).toBe(false);
    expect(config.use?.baseURL).toBe('http://localhost:4321');
    const server = config.webServer as { url: string; env?: Record<string, string> };
    expect(server.url).toBe('http://localhost:4321');
    expect(server.env?.PORT).toBe('4321');
  });

  it('falls back to the lane dev-server port, and to 4028 with no lane', async () => {
    expect((await load({ PORT: '', LANE: 'b' })).use?.baseURL).toBe('http://localhost:4228');
    expect((await load({ PORT: '', LANE: '' })).use?.baseURL).toBe('http://localhost:4028');
  });

  it("builds the site with the lane's API address and nothing else from outside (H4)", async () => {
    const config = await load({ PORT: '4228', LANE: 'b' });
    const server = config.webServer as { env?: Record<string, string> };
    expect(server.env?.NEXT_PUBLIC_API_URL).toBe('http://localhost:4229');
    expect(Object.keys(server.env ?? {}).sort()).toEqual(['NEXT_PUBLIC_API_URL', 'PORT']);
  });

  it('never reuses a server that is already running on the lane port', async () => {
    const config = await load({ PORT: '4228', LANE: 'b' });
    expect((config.webServer as { reuseExistingServer: boolean }).reuseExistingServer).toBe(false);
  });

  it('starts and stops the lane in the global setup', async () => {
    const config = await load({ PORT: '4228', LANE: 'b' });
    expect(config.globalSetup).toMatch(/tests\/e2e\/global-setup\.ts$/);
  });
});
