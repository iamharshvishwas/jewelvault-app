import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';

// PDF-4, PDF-6: the helpers of the tests of the Download PDF and Share buttons (src/components/pdf/PdfActions.tsx) in a real browser, shared by print.spec.ts (the saved estimate,
// PDF-S1) and stock-catalogue.spec.ts (the Stock Catalogue, PDF-S2). The buttons' test ids start with the screen's prefix.

export type PdfTestIdPrefix = 'estimate-pdf' | 'catalogue-pdf';

/** What the share menu of the page was handed: one entry per call of `navigator.share`. */
export interface SharedCall {
  title: string;
  files: { name: string; type: string; size: number }[];
}

/**
 * A share menu that is always there: `navigator.canShare` says yes to PDF files, and `navigator.share` keeps what it was handed on `window.__shared` and answers as `answers` says, one call
 * after the other: `ok`, or the name of the DOMException it throws (`NotAllowedError`: the browser refused the tap). Once the answers run out it answers `ok`. Put in before the page opens.
 */
export async function stubShare(page: Page, answers: string[] = []) {
  await page.addInitScript((answers) => {
    const mine = window as unknown as { __shared: SharedCall[] };
    mine.__shared = [];
    const left = [...answers];
    const pdfsOnly = (data?: ShareData) =>
      (data?.files ?? []).length > 0 &&
      (data?.files ?? []).every((file) => file.type === 'application/pdf');
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: (data?: ShareData) => pdfsOnly(data),
    });
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        mine.__shared.push({
          title: data.title ?? '',
          files: (data.files ?? []).map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
        });
        const answer = left.shift() ?? 'ok';
        if (answer !== 'ok') throw new DOMException('the stub says no', answer);
      },
    });
  }, answers);
}

export const sharedCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shared: SharedCall[] }).__shared);

/** Presses the screen's Download PDF and waits for the file the browser saves. With JV_PRINT_PDF_DIR set the file is also written there, to look at it. */
export async function pressDownloadPdf(
  page: Page,
  prefix: PdfTestIdPrefix
): Promise<{ name: string; bytes: Uint8Array }> {
  const saving = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId(`${prefix}-download`).click();
  const download = await saving;
  const bytes = new Uint8Array(readFileSync(await download.path()));
  const dir = process.env.JV_PRINT_PDF_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `pdf-${download.suggestedFilename()}`), bytes);
  }
  return { name: download.suggestedFilename(), bytes };
}
