// PDF-1: draws a PDF definition in Node for the tests, with pdfmake's Node build and the fonts of public/fonts. The browser draws through src/lib/pdf/engine.ts instead.
// pdfmake may read the font files and nothing else: no address on the internet, no other file. No `@/` import, so the Playwright tests can import this file too.
import path from 'node:path';
import pdfmake from 'pdfmake';
import { FONT_DEVANAGARI, FONT_FILES, FONT_LATIN } from '../../../src/lib/pdf/fonts';
import type { PdfDefinition } from '../../../src/lib/pdf/types';

const FONTS_DIR = path.resolve(__dirname, '../../../public/fonts');
const fontPath = (file: string) => path.join(FONTS_DIR, file);

pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(FONTS_DIR + path.sep));
pdfmake.addFonts({
  [FONT_LATIN]: {
    normal: fontPath(FONT_FILES[FONT_LATIN].normal),
    bold: fontPath(FONT_FILES[FONT_LATIN].bold),
  },
  [FONT_DEVANAGARI]: {
    normal: fontPath(FONT_FILES[FONT_DEVANAGARI].normal),
    bold: fontPath(FONT_FILES[FONT_DEVANAGARI].bold),
  },
});

/** The bytes of the PDF of the definition. */
export async function renderPdf(definition: PdfDefinition): Promise<Uint8Array> {
  return pdfmake.createPdf(definition).getBuffer();
}
