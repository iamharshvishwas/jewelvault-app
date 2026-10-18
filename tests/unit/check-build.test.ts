import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_PUBLIC_ENV,
  RAW_HTML_ALLOWED,
  RAW_HTML_NAMES,
  TOLERATED,
  checkBuild,
  routesFromSrc,
} from '../../scripts/check-build.mjs';

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

// PT-RV1c (implementation review 1, RV1-8; H3, H4, U10; task RV1c). The review's mutation A18 added a second name to ALLOWED_PUBLIC_ENV and none of the 46 tests of the build check
// failed: every test planted a name that was NOT on the list, and none read the list itself. So the lists are pinned here, and the raw-HTML names that the check missed
// (outerHTML, insertAdjacentHTML, document.write, document.writeln: RV1-8 (b)) fail like innerHTML does. These tests live in THIS file because the review's mutation runs name it.
describe('PT-RV1c the build check cannot lose its pin: the lists (RV1-8 (a), A18)', () => {
  it('the one build-time variable the code may read is NEXT_PUBLIC_API_URL, and the list says exactly that (H4, U10)', () => {
    expect(ALLOWED_PUBLIC_ENV).toEqual(['NEXT_PUBLIC_API_URL']);
  });

  it('the names tolerated until WEB15 are these three and no more; WEB15 sets TOLERATED to [] and changes this line with it', () => {
    expect(TOLERATED).toEqual([
      'NEXT_PUBLIC_PREVIEW_MODE',
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    ]);
  });

  it('no name is on both lists, so a tolerated name never becomes a silent one', () => {
    for (const name of TOLERATED) expect(ALLOWED_PUBLIC_ENV).not.toContain(name);
  });

  it.each([
    'NEXT_PUBLIC_SECRET_THING',
    'NEXT_PUBLIC_API_URL_OLD',
    'NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY',
    'API_URL',
  ])('reading %s fails: only the pinned name is silent, and a name next to it is not', (name) => {
    const r = run(CLEAN_OUT, {
      ...CLEAN_SRC,
      'lib/env.ts': `export const x = process.env.${name};`,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toContain(name);
  });

  it('the raw-HTML names include all six, so none can be dropped quietly (a name may be added, never removed)', () => {
    expect(RAW_HTML_NAMES).toEqual(
      expect.arrayContaining([
        'dangerouslySetInnerHTML',
        'innerHTML',
        'outerHTML',
        'insertAdjacentHTML',
        'document.write',
        'document.writeln',
      ])
    );
  });

  it('the files allowed to use a raw-HTML name are exactly the print window, and only for document.write: the list cannot grow without this line changing', () => {
    expect(RAW_HTML_ALLOWED).toEqual({ 'src/lib/exportUtils.ts': ['document.write'] });
  });
});

describe('PT-RV1c the build check cannot lose its pin: raw HTML names (RV1-8 (b), H3)', () => {
  const withSrc = (name: string, code: string) => ({ ...CLEAN_SRC, [name]: code });
  const line2 = (use: string) =>
    `export function f(el: HTMLElement, w: Window, h: string) {\n  ${use}\n}`;

  it.each([
    ['outerHTML', 'a property write', line2('el.outerHTML = h;')],
    ['outerHTML', 'an element access with a string', line2("el['outerHTML'] = h;")],
    ['outerHTML', 'a destructured name', line2('const { outerHTML } = el;')],
    ['insertAdjacentHTML', 'a call', line2("el.insertAdjacentHTML('beforeend', h);")],
    [
      'insertAdjacentHTML',
      'an element access with a string',
      line2("el['insertAdjacentHTML']('afterbegin', h);"),
    ],
    ['document.write', 'a call on document', line2('document.write(h);')],
    [
      'document.write',
      'a call on the document of another window (the shape of the print window)',
      line2('w.document.write(h);'),
    ],
    ['document.write', 'a call on window.document', line2('window.document.write(h);')],
    ['document.write', 'an element access with a string', line2("document['write'](h);")],
    ['document.write', 'a destructured name', line2('const { write } = document;')],
    [
      'document.write',
      'a copy that is not called there',
      line2('const put = document.write.bind(document);'),
    ],
    ['document.write', 'a call through a cast', line2('(w as Window).document.write(h);')],
    [
      'document.write',
      'a call on the contentDocument of a frame',
      line2('(el as HTMLIFrameElement).contentDocument?.write(h);'),
    ],
    ['document.writeln', 'a call on document', line2('document.writeln(h);')],
    [
      'document.writeln',
      'a call on the document of another window',
      line2('w.document.writeln(h);'),
    ],
    ['document.writeln', 'an element access with a string', line2("w.document['writeln'](h);")],
  ])('%s fails as %s, with the file, the line and the name', (name, _what, code) => {
    const r = run(CLEAN_OUT, withSrc('lib/dom.ts', code));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(
      new RegExp(`lib/dom\\.ts:\\d+.*uses ${name.replace('.', '\\.')}( |\\b).*H3`)
    );
  });

  it('the line number is the line of the use', () => {
    const r = run(CLEAN_OUT, withSrc('lib/dom.ts', line2('w.document.write(h);')));
    expect(r.problems).toEqual([
      expect.stringMatching(/^src\/lib\/dom\.ts:2: uses document\.write /),
    ]);
  });

  it('a comment, a text or another object that merely has a write method is not a use', () => {
    const r = run(
      CLEAN_OUT,
      withSrc(
        'lib/note.ts',
        [
          '// never use outerHTML, insertAdjacentHTML, document.write or document.writeln here',
          '/* document.write(x); el.outerHTML = x; */',
          'export const note = "document.write is banned, and so is outerHTML in a sentence";',
          'export async function copy(items: ClipboardItem[], out: { write(s: string): void; writeln(s: string): void }) {',
          '  await navigator.clipboard.write(items);',
          "  out.write('a');",
          "  out.writeln('b');",
          "  const p = document.createElement('p');",
          "  p.textContent = 'plain';",
          '  document.body.append(p);',
          '}',
        ].join('\n')
      )
    );
    expect(r.problems).toEqual([]);
  });
});

describe('PT-RV1c the print window is allowed by name, and only it (RV1-8 (b))', () => {
  const realFile = path.resolve(__dirname, '../../src/lib/exportUtils.ts');
  const real = readFileSync(realFile, 'utf8');
  const withSrc = (name: string, code: string) => ({ ...CLEAN_SRC, [name]: code });

  it('the real src/lib/exportUtils.ts passes in its own place and uses document.write (an allowance for a file that no longer needs it must be removed)', () => {
    expect(real).toContain('document.write(');
    const r = run(CLEAN_OUT, withSrc('lib/exportUtils.ts', real));
    expect(r.problems).toEqual([]);
  });

  it('the same text under another name fails: the allowance is the file, not the code', () => {
    const r = run(CLEAN_OUT, withSrc('lib/printReport.ts', real));
    expect(r.ok).toBe(false);
    expect(r.problems.join('\n')).toMatch(/lib\/printReport\.ts:\d+.*uses document\.write/);
  });

  it.each([
    ['innerHTML', 'el.innerHTML = h;'],
    ['outerHTML', 'el.outerHTML = h;'],
    ['insertAdjacentHTML', "el.insertAdjacentHTML('beforeend', h);"],
    ['document.writeln', 'document.writeln(h);'],
    ['dangerouslySetInnerHTML', 'const x = { dangerouslySetInnerHTML: { __html: h } };'],
  ])(
    'the allowed file is not allowed %s: the allowance is for document.write alone',
    (name, use) => {
      const code = `${real}\nexport function extra(el: HTMLElement, h: string) {\n  ${use}\n}\n`;
      const r = run(CLEAN_OUT, withSrc('lib/exportUtils.ts', code));
      expect(r.ok).toBe(false);
      expect(r.problems.join('\n')).toContain(`uses ${name}`);
    }
  );

  // WHY the allowance is safe: reportTableHtml builds the page that document.write receives, and every value that goes into it passes through escapeHtml (a title, a subtitle,
  // a column name, a cell). This reads the function with the TypeScript parser and fails on a value that is put in as it is, so the allowance cannot hide a raw value (the review's worry).
  const rawValues = (text: string) => {
    const sf = ts.createSourceFile(
      'exportUtils.ts',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    let fn: ts.FunctionDeclaration | undefined;
    sf.forEachChild((n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'reportTableHtml') fn = n;
    });
    if (!fn)
      throw new Error(
        'reportTableHtml is not in src/lib/exportUtils.ts any more: move this test, and the RAW_HTML_ALLOWED entry of scripts/check-build.mjs, with the code that builds the print window'
      );
    const called = (e: ts.Node, name: string) =>
      ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === name;
    const safe = (e: ts.Expression): boolean => {
      if (ts.isParenthesizedExpression(e)) return safe(e.expression);
      if (called(e, 'escapeHtml')) return true;
      if (ts.isTemplateExpression(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true; // its own values are checked on their own
      if (ts.isConditionalExpression(e)) return safe(e.whenTrue) && safe(e.whenFalse);
      if (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.name.text === 'join' &&
        ts.isCallExpression(e.expression.expression) &&
        ts.isPropertyAccessExpression(e.expression.expression.expression) &&
        e.expression.expression.expression.name.text === 'map'
      ) {
        // rows.map((row) => `...`).join(''): the callback must give a template or an escaped value
        const cb = e.expression.expression.arguments[0];
        return !!cb && ts.isArrowFunction(cb) && ts.isExpression(cb.body) && safe(cb.body);
      }
      // Math.max(1, columns.length): a number
      return (
        ts.isCallExpression(e) &&
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.expression.getText(sf) === 'Math' &&
        e.expression.name.text === 'max'
      );
    };
    const raw: string[] = [];
    let spans = 0;
    const visit = (n: ts.Node) => {
      if (called(n, 'escapeHtml')) return; // what is inside the call is escaped as a whole
      if (ts.isTemplateExpression(n))
        for (const span of n.templateSpans) {
          spans += 1;
          if (!safe(span.expression)) raw.push(span.expression.getText(sf));
        }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    return { raw, spans };
  };

  it('every value put into the report page by reportTableHtml passes through escapeHtml', () => {
    const { raw, spans } = rawValues(real);
    expect(spans).toBeGreaterThan(5); // the test did read the page
    expect(raw).toEqual([]);
  });

  it('negative control: a title, a column name or a cell put in without escapeHtml is found', () => {
    for (const [from, to, found] of [
      ['<title>${escapeHtml(title)}</title>', '<title>${title}</title>', 'title'],
      ['<th>${escapeHtml(column)}</th>', '<th>${column}</th>', 'column'],
      ['<td>${escapeHtml(row[column])}</td>', '<td>${row[column]}</td>', 'row[column]'],
      [
        '<p>${escapeHtml(subtitle ? `${subtitle} · Generated ${generated}` : `Generated ${generated}`)}</p>',
        '<p>${subtitle}</p>',
        'subtitle',
      ],
    ]) {
      expect(real, from).toContain(from);
      expect(rawValues(real.replace(from, to)).raw, from).toContain(found);
    }
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
