import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkBuild, routesFromSrc } from '../../scripts/check-build.mjs';

// T-D12, the build half (spec H2, H3, H4, C10, U10; task WEB14): scripts/check-build.mjs fails the build if out/ holds a forbidden string or a .map file, if src/ uses a raw-HTML API,
// if a route has no static page, or if the code reads a build-time variable other than NEXT_PUBLIC_API_URL. These tests run it on small made-up folders, so each rule is shown
// failing on a planted violation and passing when it is removed; the real build (npm run build && npm run check:build) is run by hand and by `verify` (WEB00).

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Files = Record<string, string>;
const CLEAN_OUT: Files = {
  'index.html': '<html><body>JewelVault</body></html>',
  'billing-pos.html': '<html><body>billing</body></html>',
  'settings.html': '<html><body>settings</body></html>',
  '404.html': '<html><body>not found</body></html>',
  '_next/static/chunks/app.js': 'console.log("hello");',
};
const CLEAN_SRC: Files = {
  'app/page.tsx': 'export default function Page() { return <main>home</main>; }',
  'app/billing-pos/page.tsx': 'export default function Page() { return <main>bill</main>; }',
  'app/settings/page.tsx': 'export default function Page() { return <main>settings</main>; }',
  'lib/api.ts': 'export const API = process.env.NEXT_PUBLIC_API_URL;',
};

function fixture(out: Files = CLEAN_OUT, src: Files = CLEAN_SRC) {
  const root = mkdtempSync(path.join(tmpdir(), 'jv-checkbuild-'));
  dirs.push(root);
  for (const [base, files] of [
    ['out', out],
    ['src', src],
  ] as const) {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(root, base, name);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  return { outDir: path.join(root, 'out'), srcDir: path.join(root, 'src'), root };
}
const run = (out: Files, src: Files = CLEAN_SRC) => {
  const f = fixture(out, src);
  return checkBuild({ outDir: f.outDir, srcDir: f.srcDir });
};

describe('T-D12 check-build: a clean build passes', () => {
  it('finds nothing wrong in a build that has every route, no map, no forbidden string, and clean sources', () => {
    const r = run(CLEAN_OUT);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('works out the routes from the page files of src/app (route groups do not count, dynamic segments are listed apart)', () => {
    const f = fixture(CLEAN_OUT, {
      ...CLEAN_SRC,
      'app/(shell)/reports/page.tsx': 'export default function P() { return null; }',
      'app/design/[id]/page.tsx': 'export default function P() { return null; }',
    });
    expect(routesFromSrc(f.srcDir)).toEqual({
      routes: ['/', '/billing-pos', '/reports', '/settings'],
      dynamic: ['/design/[id]'],
    });
  });
});

describe('T-D12 check-build: out/ (H2, H3)', () => {
  it.each(['mysql://', 'mariadb://', 'DB_PASSWORD', 'DATABASE_URL', 'admin123', 'staff123'])(
    'a planted %s in a built file fails, naming the file and the string',
    (needle) => {
      const r = run({ ...CLEAN_OUT, '_next/static/chunks/app.js': `var x = "${needle}";` });
      expect(r.ok).toBe(false);
      expect(r.problems).toContainEqual(expect.stringContaining(`_next/static/chunks/app.js`));
      expect(r.problems.join('\n')).toContain(needle);
    }
  );

  it('a planted .map file fails (no source maps), and so does one with a capital', () => {
    for (const name of ['_next/static/chunks/app.js.map', '_next/static/chunks/APP.JS.MAP']) {
      const r = run({ ...CLEAN_OUT, [name]: '{"version":3}' });
      expect(r.ok, name).toBe(false);
      expect(r.problems.join('\n')).toMatch(/source map/);
    }
  });

  it('the strings are found in html and text files as well as scripts', () => {
    expect(run({ ...CLEAN_OUT, 'settings.html': '<p>admin123</p>' }).ok).toBe(false);
    expect(run({ ...CLEAN_OUT, '__next.settings.txt': 'DATABASE_URL=x' }).ok).toBe(false);
  });
});

describe('T-D12 check-build: every route exists as a static page (C10)', () => {
  it('a route with no page in out/ fails, naming the route', () => {
    const { 'settings.html': _gone, ...rest } = CLEAN_OUT;
    const r = run(rest);
    expect(r.ok).toBe(false);
    expect(r.problems).toContainEqual(expect.stringContaining('/settings'));
  });

  it('a page as <route>/index.html counts too; the home page and the 404 page are required', () => {
    const { 'settings.html': _s, ...rest } = CLEAN_OUT;
    expect(run({ ...rest, 'settings/index.html': '<html></html>' }).ok).toBe(true);
    const { 'index.html': _i, ...noHome } = CLEAN_OUT;
    expect(run(noHome).problems.join('\n')).toMatch(/\/ has no static page|index\.html/);
    const { '404.html': _n, ...no404 } = CLEAN_OUT;
    expect(run(no404).problems.join('\n')).toMatch(/404/);
  });
});

describe('T-D12 check-build: src/ (H3, H4, U10)', () => {
  const withSrc = (name: string, code: string) => ({ ...CLEAN_SRC, [name]: code });

  it('dangerouslySetInnerHTML fails, as a JSX attribute', () => {
    const r = run(
      CLEAN_OUT,
      withSrc(
        'components/Raw.tsx',
        'export const Raw = ({ h }: { h: string }) => <div dangerouslySetInnerHTML={{ __html: h }} />;'
      )
    );
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/components\/Raw\.tsx:1.*dangerouslySetInnerHTML/);
  });

  it.each([
    ['a property write', 'export function f(el: HTMLElement, h: string) {\n  el.innerHTML = h;\n}'],
    [
      'an element access with a string',
      "export function f(el: HTMLElement, h: string) {\n  el['innerHTML'] = h;\n}",
    ],
    [
      'a destructured name',
      'export const read = (el: HTMLElement) => { const { innerHTML } = el; return innerHTML; };',
    ],
  ])('innerHTML fails as %s, with the line number', (_what, code) => {
    const r = run(CLEAN_OUT, withSrc('lib/dom.ts', code));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/lib\/dom\.ts:\d+.*innerHTML/);
  });

  it('a comment or a test-only word that merely mentions it is not a use', () => {
    const r = run(
      CLEAN_OUT,
      withSrc(
        'lib/note.ts',
        '// never use innerHTML or dangerouslySetInnerHTML here\n/* innerHTML */\nexport const note = "we do not call it";'
      )
    );
    expect(r.problems).toEqual([]);
  });

  it('reads a build-time variable other than NEXT_PUBLIC_API_URL: fails; the preview switch and the legacy Supabase names (until WEB15) are noted, not failed', () => {
    const planted = run(
      CLEAN_OUT,
      withSrc('lib/env.ts', 'export const x = process.env.NEXT_PUBLIC_ANALYTICS_ID;')
    );
    expect(planted.ok).toBe(false);
    expect(planted.problems.join('\n')).toMatch(/NEXT_PUBLIC_ANALYTICS_ID/);
    const priv = run(
      CLEAN_OUT,
      withSrc('lib/env.ts', "export const x = process.env['SERVICE_ROLE_KEY'];")
    );
    expect(priv.ok).toBe(false);
    expect(priv.problems.join('\n')).toMatch(/SERVICE_ROLE_KEY/);
    const destructured = run(
      CLEAN_OUT,
      withSrc(
        'lib/env.ts',
        'const { NEXT_PUBLIC_OTHER } = process.env;\nexport const x = NEXT_PUBLIC_OTHER;'
      )
    );
    expect(destructured.ok).toBe(false);
    const fine = run(
      CLEAN_OUT,
      withSrc(
        'lib/env.ts',
        "export const a = process.env.NEXT_PUBLIC_PREVIEW_MODE === '1'; export const b = process.env.NODE_ENV; export const c = process.env.NEXT_PUBLIC_SUPABASE_URL;"
      )
    );
    expect(fine.problems).toEqual([]);
    expect(fine.notes.join('\n')).toMatch(/NEXT_PUBLIC_SUPABASE_URL.*WEB15/);
    expect(fine.notes.join('\n')).toMatch(/NEXT_PUBLIC_PREVIEW_MODE/);
  });
});

describe('T-D12 check-build: the command (npm run check:build)', () => {
  const script = path.resolve(__dirname, '../../scripts/check-build.mjs');
  const cli = (args: string[]) => {
    const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  it('exits 0 and says so for a clean build, 1 and names each problem for a bad one, 2 for a wrong command line', () => {
    const good = fixture();
    const ok = cli(['--out', good.outDir, '--src', good.srcDir, '--no-headers']);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/build check passed/);
    const bad = fixture(
      { ...CLEAN_OUT, 'settings.html': 'admin123', '_next/a.js.map': '{}' },
      { ...CLEAN_SRC, 'lib/x.ts': 'document.body.innerHTML = "";' }
    );
    const r = cli(['--out', bad.outDir, '--src', bad.srcDir, '--no-headers']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/admin123/);
    expect(r.err).toMatch(/source map/);
    expect(r.err).toMatch(/innerHTML/);
    expect(r.err).toMatch(/3 problems/);
    expect(cli(['--out']).code).toBe(2);
    expect(cli(['--bogus']).code).toBe(2);
    expect(
      cli(['--out', path.join(good.root, 'nothing-here'), '--src', good.srcDir, '--no-headers'])
        .code
    ).toBe(1); // no build to check is a failure, not a pass
  });

  it('also checks vercel.json unless told not to (the real file of this repository)', () => {
    const good = fixture();
    const r = cli(['--out', good.outDir, '--src', good.srcDir]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/vercel\.json/);
  });
});

describe('T-D12 package.json', () => {
  it('has the build check as `npm run check:build`, and the build as `next build` (a static export, no server)', () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['check:build']).toBe('node scripts/check-build.mjs');
    expect(pkg.scripts.build).toBe('next build');
  });
});

describe('T-D12 next.config.mjs (H1, H2, C10)', () => {
  it('is a static export with no source maps and none of the server-only settings a static export does not have', async () => {
    const mod = await import('../../next.config.mjs');
    const config = mod.default as Record<string, unknown>;
    expect(config.output).toBe('export');
    expect(config.productionBrowserSourceMaps).toBe(false);
    for (const key of [
      'headers',
      'rewrites',
      'redirects',
      'env',
      'serverActions',
      'basePath',
      'assetPrefix',
    ])
      expect(config, key).not.toHaveProperty(key);
    expect((config.images as { unoptimized: boolean }).unoptimized).toBe(true);
  });
});

describe('T-D12 pending (each is listed in the report of WEB14)', () => {
  it.todo(
    'the only build-time variable read in src/ is NEXT_PUBLIC_API_URL: the Supabase names and the preview switch go with WEB15 (until then they are noted, not failed)'
  );
  it.todo(
    'the real build of the API-backed front end (WEB02 and WEB01 in place) passes npm run build && npm run check:build with and without NEXT_PUBLIC_PREVIEW_MODE, and the built login screen holds no credential or hint'
  );
  it.todo(
    "the API's own response headers on the API host (helmet, API07's test) and on the real API host (OPS04)"
  );
});
