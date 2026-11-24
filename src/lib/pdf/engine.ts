// PDF-1: makes a PDF file in the browser with pdfmake. pdfmake and the fonts are loaded on the first use, after a click, never with the page (static export: no server makes it).
// The fonts come from the site itself (public/fonts) and are handed to pdfmake as bytes; the Hindi pair is fetched only for a PDF that has Hindi text.
import { FONT_DEVANAGARI, FONT_FILES, FONT_LATIN, usesDevanagari } from './fonts';
import type { PdfDefinition } from './types';

type FontFamily = typeof FONT_LATIN | typeof FONT_DEVANAGARI;
// The browser build is one CommonJS object (`module.exports = pdfmake`), so the bundler hands it over as `default`; its types declare the same members as named exports.
type PdfMake = typeof import('pdfmake/build/pdfmake');

/** One load per family, shared by every click; a load that failed is forgotten, so the next click tries again. */
const loading = new Map<FontFamily, Promise<void>>();

async function fetchFont(file: string): Promise<ArrayBuffer> {
  const response = await fetch(`/fonts/${file}`);
  if (!response.ok) throw new Error(`The font ${file} could not be fetched (${response.status})`);
  return response.arrayBuffer();
}

function loadFamily(pdfMake: PdfMake, family: FontFamily): Promise<void> {
  let load = loading.get(family);
  if (!load) {
    const files = FONT_FILES[family];
    load = Promise.all([fetchFont(files.normal), fetchFont(files.bold)]).then(([normal, bold]) => {
      // pdfmake 0.3.14 and later take a font as bytes.
      pdfMake.addFonts({ [family]: { normal, bold } });
    });
    loading.set(family, load);
    load.catch(() => loading.delete(family));
  }
  return load;
}

/** The PDF of the definition, as a file the browser can save or share. Rejects when pdfmake or a font cannot be loaded, or the definition cannot be drawn. */
export async function makePdfBlob(definition: PdfDefinition): Promise<Blob> {
  const pdfMake = ((await import('pdfmake/build/pdfmake')) as unknown as { default: PdfMake })
    .default;
  await Promise.all([
    loadFamily(pdfMake, FONT_LATIN),
    ...(usesDevanagari(definition) ? [loadFamily(pdfMake, FONT_DEVANAGARI)] : []),
  ]);
  return pdfMake.createPdf(definition).getBlob();
}
