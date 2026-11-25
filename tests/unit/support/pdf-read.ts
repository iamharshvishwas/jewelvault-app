// PDF-1: reads a made PDF back for the tests: its pages, the text of each page by lines, and its pictures; and (PDF-3) where each piece of text stands. The reader is pdf.js
// (Firefox's), written apart from the writer under test (pdfmake). No `@/` import, so the Playwright tests can import this file too.
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

export interface MadePdf {
  pageCount: number;
  /** The text of each page, a line of the page to a line ("\n" between them), top to bottom and left to right. */
  pages: string[];
  /** The pictures stored in the file: a picture drawn twice is stored once, and a PNG with see-through parts is stored with its mask, a second picture. */
  imageCount: number;
}

/** The letters of one line of a page: items on one baseline, left to right, with a space where there is a gap (the next cell of a table, say). */
function lineText(items: TextItem[]): string {
  let text = '';
  let end = -Infinity;
  for (const item of [...items].sort((a, b) => a.transform[4] - b.transform[4])) {
    const x = item.transform[4];
    if (text && x - end > 1 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += ' ';
    text += item.str;
    end = x + item.width;
  }
  return text.trim();
}

function pageText(items: TextItem[]): string {
  const lines: TextItem[][] = [];
  // Top of the page first (the y of a PDF grows upwards). An item joins the line whose baseline is within half a letter's height of its own (pdf.js gives a space no height).
  for (const item of [...items].sort((a, b) => b.transform[5] - a.transform[5])) {
    const line = lines[lines.length - 1];
    const tolerance = Math.max(item.height, line?.[0].height ?? 0, 1) / 2;
    if (line && Math.abs(line[0].transform[5] - item.transform[5]) < tolerance) line.push(item);
    else lines.push([item]);
  }
  return lines
    .map(lineText)
    .filter((line) => line !== '')
    .join('\n');
}

/** The text items of each page (empty ones left out). */
async function textItemsByPage(bytes: Uint8Array): Promise<TextItem[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js takes the bytes it is given over, so it gets a copy.
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  try {
    const pages: TextItem[][] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const content = await (await pdf.getPage(n)).getTextContent();
      pages.push(
        content.items.filter((item): item is TextItem => 'str' in item && item.str !== '')
      );
    }
    return pages;
  } finally {
    await pdf.destroy();
  }
}

export async function readMadePdf(bytes: Uint8Array): Promise<MadePdf> {
  const pages = await textItemsByPage(bytes);
  const raw = new TextDecoder('latin1').decode(bytes);
  const imageCount = raw.match(/\/Subtype\s*\/Image\b/g)?.length ?? 0;
  return { pageCount: pages.length, pages: pages.map(pageText), imageCount };
}

/** A piece of text on a page and where it stands, in pt from the page's left and bottom edges. */
export interface PlacedText {
  str: string;
  x: number;
  y: number;
  width: number;
}

/** The text of each page as pdf.js places it, for a check that nothing runs past a margin. */
export async function readPlacedText(bytes: Uint8Array): Promise<PlacedText[][]> {
  const pages = await textItemsByPage(bytes);
  return pages.map((items) =>
    items.map((item) => ({
      str: item.str,
      x: item.transform[4],
      y: item.transform[5],
      width: item.width,
    }))
  );
}

/** The text with every white space and every zero-width space (U+200B, see breakableText) taken out, for a check that does not depend on where a line wraps. */
export function compact(text: string): string {
  return text.replace(/[\s\u200B]+/g, '');
}
