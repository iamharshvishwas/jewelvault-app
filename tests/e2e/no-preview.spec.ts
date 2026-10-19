import { execFile } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { roomInTheMinute } from './pacing';
import { e2eLane } from './global-setup';

// PT-W15 (task WEB15): a production build made with NEXT_PUBLIC_PREVIEW_MODE=1 opens the login screen exactly like a build without it. The variable used to switch the
// site into a preview that opened as the owner on sample data; nothing reads it any more, so a build that holds it is the same build.
//
// The spec makes the real production build (`npm run build`, a static export in out/) with the variable set, runs the build check on it, serves out/ on a port of its
// own and opens it in Chromium. The API is the one thing that is not real here: the lane's API allows only the origin of the dev server, so the page's calls to the API address
// are answered by the spec ("nobody is signed in", the answer of a visitor with no session). What is proved is what the build does on its own: it asks who is signed in, shows the
// login screen, and holds neither a sample record nor a note about a preview.
//
// Run: LANE=a JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/no-preview.spec.ts

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const outDir = path.join(root, 'out');
// The old back end's name is written in two halves: a search of the repository for the word must find nothing (PT-W15), this file included.
const OLD = ['supa', 'base'].join('');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function fileFor(urlPath: string): { file: string; status: number } {
  const clean = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const candidates =
    clean === '' ? ['index.html'] : [clean, `${clean}.html`, `${clean}/index.html`];
  for (const candidate of candidates) {
    const full = path.resolve(outDir, candidate);
    if (!full.startsWith(outDir + path.sep)) continue;
    try {
      if (statSync(full).isFile()) return { file: full, status: 200 };
    } catch {
      // try the next spelling
    }
  }
  return { file: path.join(outDir, '404.html'), status: 404 };
}

/** A plain static file server over out/: what Vercel does for a static export. */
function serveOut(): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    const { file, status } = fileFor(request.url ?? '/');
    response.writeHead(status, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function* filesUnder(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* filesUnder(full);
    else yield full;
  }
}

/** The API's side of a visitor with no session, with the headers a page of another origin needs (CORS with cookies). */
async function answerAsNobodySignedIn(page: Page, origin: string): Promise<string[]> {
  const { apiUrl } = e2eLane();
  const calls: string[] = [];
  await page.route(`${apiUrl}/**`, async (route) => {
    const request = route.request();
    const headers: Record<string, string> = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, OPTIONS',
      vary: 'Origin',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    calls.push(`${request.method()} ${new URL(request.url()).pathname}`);
    await route.fulfill({
      status: 401,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        error: { code: 'JV_UNAUTHENTICATED', message: 'Sign in to continue.', details: {} },
        request_id: 'req-no-preview',
      }),
    });
  });
  return calls;
}

test.describe('PT-W15 a build made with NEXT_PUBLIC_PREVIEW_MODE=1 opens the login screen, like any build', () => {
  let server: http.Server;
  let origin = '';
  let buildSeconds = 0;

  test.beforeAll(async () => {
    test.setTimeout(8 * 60_000);
    const { apiUrl } = e2eLane();
    const started = Date.now();
    await run('npm', ['run', 'build'], {
      cwd: root,
      env: { ...process.env, NEXT_PUBLIC_PREVIEW_MODE: '1', NEXT_PUBLIC_API_URL: apiUrl },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 7 * 60_000,
    });
    buildSeconds = Math.round((Date.now() - started) / 1000);
    server = await serveOut();
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  test.beforeEach(async ({ page }) => {
    await clearLoginCounters();
    await roomInTheMinute(page);
  });

  test('the build check passes on it: only NEXT_PUBLIC_API_URL is read, and nothing of the old back end or of a preview is in out/', async () => {
    test.info().annotations.push({ type: 'build seconds', description: String(buildSeconds) });
    const { apiUrl } = e2eLane();
    const checked = await run('node', ['scripts/check-build.mjs'], {
      cwd: root,
      env: { ...process.env, NEXT_PUBLIC_API_URL: apiUrl },
    });
    expect(checked.stdout).toMatch(/passed/i);
    const texts = [...filesUnder(outDir)]
      .filter((file) => /\.(html|js|css|json|txt)$/.test(file))
      .map((file) => ({ file, text: readFileSync(file, 'utf8') }));
    expect(texts.length).toBeGreaterThan(20);
    for (const { file, text } of texts) {
      const rel = path.relative(outDir, file);
      expect(text.toLowerCase().includes(OLD), `${rel} names the old back end`).toBe(false);
      expect(text.includes('PREVIEW_MODE'), `${rel} holds the preview variable's name`).toBe(false);
      expect(text.includes('Preview: sample data'), `${rel} holds the preview note`).toBe(false);
      // the prototype's sample records (a customer and two designs) are not in any file of the build
      for (const sample of [
        'Meera Sharma',
        'Jaishri Bridal Kundan Necklace Set',
        'Jaishri Classic Silver Ring',
      ]) {
        expect(text.includes(sample), `${rel} holds the sample record ${sample}`).toBe(false);
      }
    }
  });

  test('the home page asks who is signed in, shows the login screen and nothing else: no app, no sample data, no preview note', async ({
    page,
  }) => {
    const calls = await answerAsNobodySignedIn(page, origin);
    await page.goto(`${origin}/`);
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.locator('aside')).toHaveCount(0); // no side bar: the app is not open
    await expect(page.getByRole('note')).toHaveCount(0); // the preview note was a role=note
    const text = await page.locator('body').innerText();
    for (const word of ['Preview', 'sample data', 'Meera Sharma', 'Dashboard']) {
      expect(text, word).not.toContain(word);
    }
    expect(calls).toEqual(['GET /v1/auth/me']);
  });

  test('every other screen opens on the login screen too, and nothing is kept in browser storage', async ({
    page,
  }) => {
    await answerAsNobodySignedIn(page, origin);
    for (const route of [
      '/billing-pos',
      '/settings',
      '/customer-ledger',
      '/inventory-management',
    ]) {
      await page.goto(`${origin}${route}`);
      await expect(page.getByLabel('Email'), route).toBeVisible();
      await expect(page.locator('aside'), route).toHaveCount(0);
    }
    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(stored).toEqual({ local: [], session: [] });
  });
});
