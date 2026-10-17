import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkHeaders, parseCsp } from '../../scripts/check-build.mjs';

// T-D12, the headers half (spec H1, H4, U10; task WEB14): the security headers of the static site live in vercel.json, because Next.js lists `headers` in next.config as unsupported
// for a static export. They are asserted here on the TEXT of the file; the same headers on a real host (curl -I) are OPS04's, and on Siddhi's real domain OPS07's.
// The site's API is billing-api.jaishrigoldpalace.com (spec A12, production). The policy starts in report-only mode (H1): it reports what it would block and blocks nothing yet.

const PRODUCTION_API_ORIGIN = 'https://billing-api.jaishrigoldpalace.com';
const text = readFileSync(path.resolve(__dirname, '../../vercel.json'), 'utf8');
const config = JSON.parse(text) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const rule = config.headers.find((h) => h.source === '/(.*)');
const header = (key: string) =>
  rule?.headers.find((h) => h.key.toLowerCase() === key.toLowerCase())?.value;
const csp = parseCsp(header('Content-Security-Policy-Report-Only') ?? '');

describe('T-D12 vercel.json security headers (H1)', () => {
  it('is valid JSON and sets the headers on every path of the site', () => {
    expect(rule).toBeDefined();
    expect(Object.keys(config)).toEqual(['headers']); // nothing else in the file: no rewrites, no redirects, no build or env settings
  });

  it('sets the four plain headers exactly', () => {
    expect(header('X-Content-Type-Options')).toBe('nosniff');
    expect(header('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(header('X-Frame-Options')).toBe('DENY');
    const hsts = header('Strict-Transport-Security')!;
    expect(Number(/max-age=(\d+)/.exec(hsts)![1])).toBeGreaterThanOrEqual(31536000);
    expect(hsts).toContain('includeSubDomains');
  });

  it('has a restrictive Permissions-Policy: the camera for the site itself (the scanner of scan-detail) and nothing else', () => {
    const policy = header('Permissions-Policy')!;
    expect(policy).toContain('camera=(self)');
    for (const feature of [
      'geolocation',
      'microphone',
      'payment',
      'usb',
      'bluetooth',
      'midi',
      'display-capture',
      'xr-spatial-tracking',
    ])
      expect(policy, feature).toContain(`${feature}=()`);
    expect(policy).not.toContain('*');
  });

  it('starts the content security policy in report-only mode: the report-only header is there and the enforcing one is not yet', () => {
    expect(header('Content-Security-Policy-Report-Only')).toBeTruthy();
    expect(header('Content-Security-Policy')).toBeUndefined();
  });

  it('allows only the site itself, the API origin in connect-src AND img-src, and the inline scripts and styles the static export needs', () => {
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['connect-src']).toEqual(["'self'", PRODUCTION_API_ORIGIN]);
    expect(csp['img-src']).toEqual(["'self'", 'data:', 'blob:', PRODUCTION_API_ORIGIN]); // data: for the QR codes and barcodes, blob: for photos picked on the device
    expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'"]); // a static export cannot use nonces (H1); no eval
    expect(csp['style-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(csp['font-src']).toEqual(["'self'", 'data:']);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'self'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
  });

  it('names no outside origin but the API and no Supabase origin anywhere in the file (a policy that still named Supabase would break every call and every photo)', () => {
    const origins = new Set(text.match(/https?:\/\/[^\s"';,)]+/g) ?? []);
    expect([...origins]).toEqual([PRODUCTION_API_ORIGIN]);
    expect(text.toLowerCase()).not.toContain('supabase');
    expect(rule!.headers.map((h) => h.value).join(' ')).not.toContain('*'); // no wildcard in any header value (the only * in the file is the path pattern)
    expect(PRODUCTION_API_ORIGIN).toBe(new URL(PRODUCTION_API_ORIGIN).origin);
  });

  it('passes the checker that npm run check:build runs, with the production API origin', () => {
    expect(checkHeaders(text, { apiOrigin: PRODUCTION_API_ORIGIN })).toEqual([]);
    expect(checkHeaders(text)).toEqual([]); // and without being told the origin: one origin, the same in connect-src and img-src
  });
});

describe('T-D12 the headers checker finds what is wrong (negative controls)', () => {
  const mutate = (fn: (c: typeof config) => void) => {
    const c = JSON.parse(text) as typeof config;
    fn(c);
    return JSON.stringify(c);
  };
  const setHeader = (c: typeof config, key: string, value: string | null) => {
    const list = c.headers[0].headers;
    const i = list.findIndex((h) => h.key.toLowerCase() === key.toLowerCase());
    if (i >= 0) list.splice(i, 1);
    if (value !== null) list.push({ key, value });
  };
  const csp0 = header('Content-Security-Policy-Report-Only')!;

  it.each([
    ['Strict-Transport-Security', /Strict-Transport-Security/],
    ['X-Content-Type-Options', /X-Content-Type-Options/],
    ['Referrer-Policy', /Referrer-Policy/],
    ['X-Frame-Options', /X-Frame-Options/],
    ['Permissions-Policy', /Permissions-Policy/],
    ['Content-Security-Policy-Report-Only', /Content-Security-Policy/],
  ])('a missing %s is reported', (key, pattern) => {
    expect(checkHeaders(mutate((c) => setHeader(c, key, null))).join('\n')).toMatch(pattern);
  });

  it('a Supabase origin in the policy is reported, wherever it is', () => {
    const planted = mutate((c) =>
      setHeader(
        c,
        'Content-Security-Policy-Report-Only',
        csp0.replace("connect-src 'self'", "connect-src 'self' https://abc.supabase.co")
      )
    );
    const problems = checkHeaders(planted, { apiOrigin: PRODUCTION_API_ORIGIN }).join('\n');
    expect(problems).toMatch(/supabase/i);
    expect(problems).toMatch(/outside origin/);
  });

  it('the API origin missing from img-src or from connect-src is reported (the photos or the calls would break)', () => {
    const noImg = mutate((c) =>
      setHeader(
        c,
        'Content-Security-Policy-Report-Only',
        csp0.replace(` ${PRODUCTION_API_ORIGIN}; font-src`, '; font-src')
      )
    );
    expect(checkHeaders(noImg, { apiOrigin: PRODUCTION_API_ORIGIN }).join('\n')).toMatch(
      /img-src does not name the API origin/
    );
    const noConnect = mutate((c) =>
      setHeader(
        c,
        'Content-Security-Policy-Report-Only',
        csp0.replace(`connect-src 'self' ${PRODUCTION_API_ORIGIN}`, "connect-src 'self'")
      )
    );
    expect(checkHeaders(noConnect, { apiOrigin: PRODUCTION_API_ORIGIN }).join('\n')).toMatch(
      /connect-src does not name the API origin/
    );
  });

  it('a second outside origin, a wildcard, a bare scheme, unsafe-eval and plain http are reported', () => {
    const add = (from: string, to: string) =>
      mutate((c) => setHeader(c, 'Content-Security-Policy-Report-Only', csp0.replace(from, to)));
    expect(
      checkHeaders(add("script-src 'self'", "script-src 'self' https://cdn.example.com")).join('\n')
    ).toMatch(/outside origin/);
    expect(checkHeaders(add("img-src 'self'", "img-src * 'self'")).join('\n')).toMatch(/wildcard/);
    expect(checkHeaders(add("img-src 'self'", "img-src https: 'self'")).join('\n')).toMatch(
      /wildcard|scheme/
    );
    expect(
      checkHeaders(add("'unsafe-inline'", "'unsafe-inline' 'unsafe-eval'")).join('\n')
    ).toMatch(/unsafe-eval/);
    expect(
      checkHeaders(add(PRODUCTION_API_ORIGIN, 'http://billing-api.jaishrigoldpalace.com')).join(
        '\n'
      )
    ).toMatch(/https/);
  });

  it('a different origin in connect-src and img-src is reported even when the checker is not told which one is right', () => {
    const planted = mutate((c) =>
      setHeader(
        c,
        'Content-Security-Policy-Report-Only',
        csp0.replace(
          `img-src 'self' data: blob: ${PRODUCTION_API_ORIGIN}`,
          "img-src 'self' data: blob: https://other.jaishrigoldpalace.com"
        )
      )
    );
    expect(checkHeaders(planted).join('\n')).toMatch(
      /connect-src and img-src name different origins|outside origin/
    );
  });

  it('a file that is not JSON, or has no rule for every path, is reported', () => {
    expect(checkHeaders('{ not json').join('\n')).toMatch(/not valid JSON/);
    expect(
      checkHeaders(JSON.stringify({ headers: [{ source: '/only-here', headers: [] }] })).join('\n')
    ).toMatch(/every path/);
  });
});

describe('T-D12 pending (not buildable yet, each is listed in the report of WEB14)', () => {
  it.todo(
    'the content security policy lets the API client of WEB01 reach the API and the photos load, in a real browser against a lane (E2E of WEB00 with WEB02): no violation is reported'
  );
  it.todo(
    "the headers answer a curl -I on the host in use, Vercel today (OPS04), and again on Siddhi's real website host before go-live (OPS07)"
  );
  it.todo(
    'the enforcing Content-Security-Policy replaces the report-only one after the reports of staging are read (a decision of Harsh, not of the build)'
  );
});
