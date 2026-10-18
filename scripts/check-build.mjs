#!/usr/bin/env node
// The build check (spec H1 to H4, C10, U10; task WEB14, test T-D12). `npm run build && npm run check:build`.
// It fails the build when
//   out/    holds `mysql://`, `mariadb://`, `DB_PASSWORD`, `DATABASE_URL`, `admin123` or `staff123` in any file, or any `.map` file (no source maps, H2, H3);
//   out/    lacks the static page of a route of src/app, the home page or the 404 page (every route is a static page, C10; a page that touched `window` while it was prerendered would not build);
//   src/    uses `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or `document.writeln` (H3: React's escaping is the protection that a static
//           export's policy cannot give, H1), found with the TypeScript parser, so a comment or a text that merely mentions the word is not a use. The one exception is named in
//           RAW_HTML_ALLOWED: the print window of the reports, src/lib/exportUtils.ts, may call document.write (RV1c);
//   src/    reads a build-time variable other than NEXT_PUBLIC_API_URL (H4, U10), or any variable that does not start with NEXT_PUBLIC_ (it would be empty in the browser, and a secret must
//           never be written there). NEXT_PUBLIC_PREVIEW_MODE (the preview build) and the NEXT_PUBLIC_SUPABASE_* names of the Supabase build are tolerated and NOTED until WEB15 removes them
//           (edit TOLERATED below then, and the strict check of H4 is complete);
//   vercel.json   lacks one of the security headers of H1, or the content security policy names an outside origin other than the API's, lacks the API origin in connect-src or img-src,
//           allows eval, a wildcard or a bare scheme, or names Supabase.
//   node scripts/check-build.mjs [--out out] [--src src] [--vercel vercel.json] [--no-headers]
// Exit code: 0 passed, 1 a problem (also: there is no build to check), 2 the command line is wrong.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FORBIDDEN_IN_OUT = [
  'mysql://',
  'mariadb://',
  'DB_PASSWORD',
  'DATABASE_URL',
  'admin123',
  'staff123',
];
/**
 * The browser's ways to put text into a page as HTML (H3). A name with no dot is found as a word (a property, a destructured name, a JSX attribute, a string key); `document.write`
 * and `document.writeln` are found as a member of a document: `document`, `window.document`, `frame.contentDocument`, `el.ownerDocument`, by name, by ['name'] or destructured.
 * The check reads one file at a time and follows no variable, so `const d = document; d.write(x)` is not seen: it stops the plain spellings, not a determined bypass (RV1c).
 */
export const RAW_HTML_NAMES = [
  'dangerouslySetInnerHTML',
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'document.writeln',
];
/**
 * The files that may use a raw-HTML name, by path from the project root, each with the names it may use (nothing else in the file is allowed). A test pins this list (PT-RV1c).
 * src/lib/exportUtils.ts: printPdf writes reportTableHtml(...) into the window it has just opened; every value in that page (a title, a subtitle, a column name, a cell)
 * passes through escapeHtml, and a test (PT-RV1c) reads reportTableHtml and fails on a value that does not. Put a new file here only with a reason like that one.
 */
export const RAW_HTML_ALLOWED = {
  'src/lib/exportUtils.ts': ['document.write'],
};
export const ALLOWED_PUBLIC_ENV = ['NEXT_PUBLIC_API_URL'];
/** Read today, removed by WEB15 (the Supabase build, the preview build): tolerated, and printed as a note. */
export const TOLERATED = [
  'NEXT_PUBLIC_PREVIEW_MODE',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];

// ---------------------------------------------------------------- files

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (st.isFile()) yield full;
  }
}
const posix = (p) => p.split(path.sep).join('/');

const PAGE_FILE = /^page\.(tsx|ts|jsx|js)$/;

/**
 * The routes of src/app from its page files: a route group (a folder in parentheses) is not part of the address; a dynamic segment ([id]) cannot be listed and is returned apart.
 * @param {string} srcDir
 * @returns {{ routes: string[], dynamic: string[] }}
 */
export function routesFromSrc(srcDir) {
  const app = path.join(srcDir, 'app');
  /** @type {string[]} */
  const routes = [];
  /** @type {string[]} */
  const dynamic = [];
  if (!existsSync(app)) return { routes, dynamic };
  for (const file of walk(app)) {
    if (!PAGE_FILE.test(path.basename(file))) continue;
    const segments = posix(path.relative(app, path.dirname(file)))
      .split('/')
      .filter((s) => s !== '' && s !== '.' && !/^\(.*\)$/.test(s));
    const route = `/${segments.join('/')}`;
    (segments.some((s) => s.startsWith('[') || s.startsWith('@')) ? dynamic : routes).push(route);
  }
  return { routes: [...new Set(routes)].sort(), dynamic: [...new Set(dynamic)].sort() };
}

// ---------------------------------------------------------------- out/

function checkOut(outDir, routes, problems) {
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
    problems.push(`there is no build to check: ${outDir} is not there (run npm run build first)`);
    return 0;
  }
  let scanned = 0;
  for (const file of walk(outDir)) {
    const rel = posix(path.relative(outDir, file));
    scanned += 1;
    if (/\.map$/i.test(rel))
      problems.push(`out/${rel}: a source map (H2: no source maps in the build)`);
    const data = readFileSync(file);
    for (const needle of FORBIDDEN_IN_OUT)
      if (data.includes(needle)) problems.push(`out/${rel}: contains "${needle}" (H3)`);
  }
  const has = (...candidates) => candidates.some((c) => existsSync(path.join(outDir, c)));
  for (const route of routes) {
    const base = route.slice(1);
    const ok = route === '/' ? has('index.html') : has(`${base}.html`, `${base}/index.html`);
    if (!ok)
      problems.push(
        `route ${route} has no static page in out/ (expected ${route === '/' ? 'index.html' : `${base}.html`}) (C10)`
      );
  }
  if (!has('index.html') && !routes.includes('/'))
    problems.push('out/index.html is missing: / has no static page (C10)');
  if (!has('404.html'))
    problems.push('out/404.html is missing: the not-found page was not built (C10)');
  return scanned;
}

// ---------------------------------------------------------------- src/

const WORD_NAMES = RAW_HTML_NAMES.filter((n) => !n.includes('.'));
const DOCUMENT_METHODS = RAW_HTML_NAMES.filter((n) => n.startsWith('document.')).map((n) =>
  n.slice('document.'.length)
);
const DOCUMENT_HOLDERS = ['document', 'contentDocument', 'ownerDocument'];

/** The expression without the casts and brackets around it: `(w as Window)!` is `w`. */
function unwrap(e) {
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  )
    e = e.expression;
  return e;
}
/** Is it a document: `document`, `x.document`, `x['document']`, `x.contentDocument`, `x.ownerDocument`? */
function isDocument(expression) {
  const e = unwrap(expression);
  if (ts.isIdentifier(e)) return e.text === 'document';
  if (ts.isPropertyAccessExpression(e)) return DOCUMENT_HOLDERS.includes(e.name.text);
  if (ts.isElementAccessExpression(e))
    return (
      ts.isStringLiteralLike(e.argumentExpression) &&
      DOCUMENT_HOLDERS.includes(e.argumentExpression.text)
    );
  return false;
}
/** `document.write` or `document.writeln` when the node is a member of a document, as a name or a string key, else undefined. */
function documentWrite(node) {
  const member = ts.isPropertyAccessExpression(node)
    ? node.name.text
    : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      ? node.argumentExpression.text
      : undefined;
  return member !== undefined && DOCUMENT_METHODS.includes(member) && isDocument(node.expression)
    ? `document.${member}`
    : undefined;
}

const KIND = {
  '.tsx': ts.ScriptKind.TSX,
  '.ts': ts.ScriptKind.TS,
  '.jsx': ts.ScriptKind.JSX,
  '.js': ts.ScriptKind.JS,
  '.mjs': ts.ScriptKind.JS,
};

function checkSrc(srcDir, problems, notes) {
  if (!existsSync(srcDir)) {
    problems.push(`there is no source folder to check: ${srcDir} is not there`);
    return;
  }
  const tolerated = new Map();
  for (const file of walk(srcDir)) {
    const kind = KIND[path.extname(file)];
    if (kind === undefined) continue;
    const rel = `src/${posix(path.relative(srcDir, file))}`;
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const line = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const readEnv = (name, node) => {
      if (name === 'NODE_ENV' || ALLOWED_PUBLIC_ENV.includes(name)) return;
      if (TOLERATED.includes(name)) {
        tolerated.set(name, [...new Set([...(tolerated.get(name) ?? []), rel])]);
        return;
      }
      problems.push(
        name.startsWith('NEXT_PUBLIC_')
          ? `${rel}:${line(node)}: reads the build-time variable ${name}; only NEXT_PUBLIC_API_URL may be set on Vercel (H4, U10)`
          : `${rel}:${line(node)}: reads process.env.${name}, which is empty in the browser and must never hold a secret (U10)`
      );
    };
    const isProcessEnv = (e) =>
      ts.isPropertyAccessExpression(e) &&
      e.expression.getText(sf) === 'process' &&
      e.name.text === 'env';
    const allowed = RAW_HTML_ALLOWED[rel] ?? [];
    const rawHtml = (name, node, by = '') => {
      if (!allowed.includes(name))
        problems.push(`${rel}:${line(node)}: uses ${name}${by} (H3: no raw HTML)`);
    };
    const visit = (node) => {
      if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && WORD_NAMES.includes(node.text))
        rawHtml(node.text, node);
      else if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        WORD_NAMES.includes(node.text)
      )
        rawHtml(node.text, node, ' by name');
      const written = documentWrite(node);
      if (written) rawHtml(written, node);
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isDocument(node.initializer)
      ) {
        // const { write } = document;
        for (const el of node.name.elements) {
          const key = el.propertyName ?? el.name;
          const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
          if (name !== undefined && DOCUMENT_METHODS.includes(name))
            rawHtml(`document.${name}`, el);
        }
      }
      if (ts.isPropertyAccessExpression(node) && isProcessEnv(node.expression))
        readEnv(node.name.text, node);
      else if (
        ts.isElementAccessExpression(node) &&
        isProcessEnv(node.expression) &&
        ts.isStringLiteralLike(node.argumentExpression)
      )
        readEnv(node.argumentExpression.text, node);
      else if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        isProcessEnv(node.initializer)
      ) {
        for (const el of node.name.elements) readEnv((el.propertyName ?? el.name).getText(sf), el);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  for (const [name, files] of tolerated)
    notes.push(
      `${name}: read in ${files.join(', ')} (a variable of the Supabase build or the preview build; WEB15 removes it and then only NEXT_PUBLIC_API_URL is left)`
    );
}

// ---------------------------------------------------------------- vercel.json (H1)

/**
 * A content security policy as { directive: [sources] }.
 * @param {string} policy
 * @returns {Record<string, string[]>}
 */
export function parseCsp(policy) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const part of String(policy).split(';')) {
    const words = part.trim().split(/\s+/).filter(Boolean);
    if (words.length) out[words[0].toLowerCase()] = words.slice(1);
  }
  return out;
}

const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+/i;

/**
 * Problems in the text of vercel.json (an empty list is a pass). apiOrigin, when given, is the one outside origin the policy may name.
 * @param {string} text
 * @param {{ apiOrigin?: string }} [options]
 * @returns {string[]}
 */
export function checkHeaders(text, { apiOrigin } = {}) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return ['vercel.json is not valid JSON'];
  }
  /** @type {string[]} */
  const problems = [];
  const rule = (config.headers ?? []).find((h) => h.source === '/(.*)');
  if (!rule)
    return ['vercel.json has no rule that sets the headers on every path (source "/(.*)")'];
  const get = (key) => rule.headers?.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
  const want = (key, ok, hint) => {
    const v = get(key);
    if (v === undefined) problems.push(`${key} is missing (H1)`);
    else if (!ok(v)) problems.push(`${key} is "${v}"; ${hint} (H1)`);
  };
  want(
    'Strict-Transport-Security',
    (v) => Number(/max-age=(\d+)/.exec(v)?.[1] ?? 0) >= 31536000 && v.includes('includeSubDomains'),
    'it needs max-age of at least a year and includeSubDomains'
  );
  want('X-Content-Type-Options', (v) => v === 'nosniff', 'it must be nosniff');
  want(
    'Referrer-Policy',
    (v) => v === 'strict-origin-when-cross-origin',
    'it must be strict-origin-when-cross-origin'
  );
  want('X-Frame-Options', (v) => v === 'DENY', 'it must be DENY');
  want(
    'Permissions-Policy',
    (v) =>
      !v.includes('*') &&
      ['geolocation', 'microphone', 'payment', 'usb'].every((f) => v.includes(`${f}=()`)) &&
      /camera=\((self)?\)/.test(v),
    'it must switch geolocation, microphone, payment and usb off, allow the camera for the site itself only, and name no wildcard'
  );

  const cspKeys = ['Content-Security-Policy', 'Content-Security-Policy-Report-Only'].filter(
    (k) => get(k) !== undefined
  );
  if (cspKeys.length === 0)
    problems.push(
      'Content-Security-Policy-Report-Only is missing (H1: a content security policy, report-only first)'
    );
  for (const key of cspKeys) checkCsp(parseCsp(get(key)), key, apiOrigin, problems);
  if (/supabase/i.test(text))
    problems.push(
      'vercel.json names Supabase: a policy that still named the Supabase origin would break every call and every photo (H1)'
    );
  return problems;
}

function checkCsp(csp, key, apiOrigin, problems) {
  const has = (directive, token) => (csp[directive] ?? []).includes(token);
  const need = (directive, token) => {
    if (!has(directive, token)) problems.push(`${key}: ${directive} must contain ${token} (H1)`);
  };
  need('default-src', "'self'");
  need('script-src', "'self'");
  need('object-src', "'none'");
  need('base-uri', "'self'");
  need('form-action', "'self'");
  need('frame-ancestors', "'none'");
  need('connect-src', "'self'");
  need('img-src', "'self'");
  const outside = new Set();
  for (const [directive, tokens] of Object.entries(csp)) {
    for (const tok of tokens) {
      if (tok === "'unsafe-eval'" || tok === "'wasm-unsafe-eval'")
        problems.push(`${key}: ${directive} allows ${tok} (H1: no eval)`);
      else if (tok === '*' || /^(https?|wss?|ftp):$/.test(tok))
        problems.push(
          `${key}: ${directive} has the wildcard or bare-scheme source ${tok}, which allows every origin of that kind (H1)`
        );
      else if (ORIGIN.test(tok) || tok.startsWith('//')) {
        outside.add(tok);
        if (!tok.startsWith('https://'))
          problems.push(`${key}: ${directive} names ${tok}, which is not https (H1)`);
      }
    }
  }
  const connect = (csp['connect-src'] ?? []).filter((t) => ORIGIN.test(t));
  const img = (csp['img-src'] ?? []).filter((t) => ORIGIN.test(t));
  if (apiOrigin) {
    for (const tok of outside)
      if (tok !== apiOrigin)
        problems.push(
          `${key}: the outside origin ${tok} is named; only the API origin ${apiOrigin} may be (H1)`
        );
    if (!connect.includes(apiOrigin))
      problems.push(`${key}: connect-src does not name the API origin ${apiOrigin} (H1)`);
    if (!img.includes(apiOrigin))
      problems.push(
        `${key}: img-src does not name the API origin ${apiOrigin} (H1: the photos come from the API)`
      );
  } else {
    if (outside.size > 1)
      problems.push(
        `${key}: more than one outside origin is named (${[...outside].join(', ')}); only the API's may be (H1)`
      );
    if (connect.length !== 1)
      problems.push(
        `${key}: connect-src must name exactly the API origin (found ${connect.length} outside origins)`
      );
    if (img.length !== 1 || img[0] !== connect[0])
      problems.push(
        `${key}: connect-src and img-src name different origins (or img-src does not name the API origin) (H1)`
      );
  }
}

// ---------------------------------------------------------------- all together

/**
 * The whole check. `vercelJson` is a path (or undefined to skip the headers).
 * @param {{ outDir: string, srcDir: string, vercelJson?: string, apiUrl?: string, routes?: string[] }} options
 * @returns {{ ok: boolean, problems: string[], notes: string[], routes: string[], scanned: number }}
 */
export function checkBuild({ outDir, srcDir, vercelJson, apiUrl, routes }) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  const found = routes ?? routesFromSrc(srcDir).routes;
  if (!routes) {
    const dyn = routesFromSrc(srcDir).dynamic;
    if (dyn.length)
      notes.push(`dynamic routes cannot be listed and are not checked: ${dyn.join(', ')}`);
  }
  const scanned = checkOut(outDir, found, problems);
  checkSrc(srcDir, problems, notes);
  if (vercelJson) {
    if (!existsSync(vercelJson))
      problems.push(`${vercelJson} is not there (H1: the security headers live in vercel.json)`);
    else {
      const text = readFileSync(vercelJson, 'utf8');
      problems.push(...checkHeaders(text));
      // this build talks to NEXT_PUBLIC_API_URL; a policy that names another origin only reports (it is report-only), so it is a note, not a failure
      if (apiUrl) {
        try {
          const origin = new URL(apiUrl).origin;
          if (!text.includes(origin))
            notes.push(
              `NEXT_PUBLIC_API_URL is ${origin}, which vercel.json does not name: the report-only policy will report every call; fix it before the policy is enforced (H1)`
            );
        } catch {
          problems.push('NEXT_PUBLIC_API_URL is not a URL (H4)');
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, notes, routes: found, scanned };
}

function main(argv) {
  const opts = {
    out: path.join(ROOT, 'out'),
    src: path.join(ROOT, 'src'),
    vercel: path.join(ROOT, 'vercel.json'),
  };
  let headers = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-headers') headers = false;
    else if (['--out', '--src', '--vercel'].includes(a)) {
      if (i + 1 >= argv.length) {
        console.error(`${a} needs a value`);
        return 2;
      }
      opts[a.slice(2)] = path.resolve(argv[++i]);
    } else {
      console.error(
        `unknown option ${a}\nusage: node scripts/check-build.mjs [--out out] [--src src] [--vercel vercel.json] [--no-headers]`
      );
      return 2;
    }
  }
  const r = checkBuild({
    outDir: opts.out,
    srcDir: opts.src,
    vercelJson: headers ? opts.vercel : undefined,
    apiUrl: process.env.NEXT_PUBLIC_API_URL,
  });
  for (const n of r.notes) console.info(`note: ${n}`);
  if (!r.ok) {
    for (const p of r.problems) console.error(`build check: ${p}`);
    console.error(
      `build check failed: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`
    );
    return 1;
  }
  console.info(
    `build check passed: ${r.routes.length} routes have a static page, ${r.scanned} files in out/ scanned (no forbidden string, no source map), src/ has no raw HTML and reads no other variable${headers ? ', vercel.json: the security headers and the content security policy are in order' : ''}`
  );
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = main(process.argv.slice(2));
