// PDF-1: `makePdfBlob` (src/lib/pdf/engine.ts), the browser's PDF engine, run in Node over pdfmake's browser build, with a stubbed `fetch` that serves public/fonts:
//   - a font that fails to load fails the PDF, and is fetched again on the next try, which makes the PDF
//   - a font family that has loaded is never fetched again
//   - the Hindi pair is fetched only for a PDF that has Hindi text, and draws it
//
// The engine keeps its loads for the life of the page, so the steps run in order in one test, over one copy of the module.
//
// Run: npm test -- tests/unit/pdf-engine-browser.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FONT_LATIN } from '@/lib/pdf/fonts';
import { pdfText } from '@/lib/pdf/scripts';
import type { PdfDefinition } from '@/lib/pdf/types';
import { compact, readMadePdf } from './support/pdf-read';

const PUBLIC_DIR = path.resolve(__dirname, '../../public');

/** The addresses fetched, in order. */
const fetched: string[] = [];
/** A file that answers 503 the next time it is asked for. */
let failOnce: string | null = null;

beforeEach(() => {
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    if (failOnce && url === `/fonts/${failOnce}`) {
      failOnce = null;
      return new Response('Service Unavailable', { status: 503 });
    }
    return new Response(new Uint8Array(readFileSync(path.join(PUBLIC_DIR, url))));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const latin: PdfDefinition = {
  pageSize: 'A4',
  defaultStyle: { font: FONT_LATIN },
  content: ['Grand Total ₹1,43,000', { text: 'Anita Sharma', bold: true }],
};

const textOf = async (blob: Blob) => readMadePdf(new Uint8Array(await blob.arrayBuffer()));

it('fetches a font again after a failed load, never after a good one, and the Hindi pair only for Hindi text', async () => {
  const { makePdfBlob } = await import('@/lib/pdf/engine');
  const latinPair = ['/fonts/NotoSans-Regular.ttf', '/fonts/NotoSans-Bold.ttf'];

  failOnce = 'NotoSans-Bold.ttf';
  await expect(makePdfBlob(latin)).rejects.toThrow(
    'The font NotoSans-Bold.ttf could not be fetched (503)'
  );
  expect(fetched, 'the first try').toEqual(latinPair);

  fetched.length = 0;
  const blob = await makePdfBlob(latin);
  expect(fetched, 'the try after the failure fetches the pair again').toEqual(latinPair);
  expect(blob.type).toBe('application/pdf');
  expect(compact((await textOf(blob)).pages[0])).toContain('GrandTotal₹1,43,000AnitaSharma');

  fetched.length = 0;
  await makePdfBlob(latin);
  expect(fetched, 'a third try fetches nothing').toEqual([]);

  const hindi = await makePdfBlob({
    defaultStyle: { font: FONT_LATIN },
    content: [pdfText('अनीता शर्मा'), pdfText('श्री गणेश', { bold: true })],
  });
  expect(fetched, 'Hindi text fetches the Devanagari pair only').toEqual([
    '/fonts/NotoSansDevanagari-Regular.ttf',
    '/fonts/NotoSansDevanagari-Bold.ttf',
  ]);
  expect((await textOf(hindi)).pages[0].match(/[ऀ-ॿ]/g)?.length ?? 0).toBeGreaterThan(8);
});
