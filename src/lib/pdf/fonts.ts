// PDF-1: the fonts of the PDF files, kept in public/fonts (see the README there). Noto Sans draws English, the accented letters and the rupee sign; Noto Sans Devanagari draws
// Hindi and is fetched only for a PDF that has some.
import type { PdfDefinition } from './types';

export const FONT_LATIN = 'NotoSans';
export const FONT_DEVANAGARI = 'NotoSansDevanagari';

type FontFamily = typeof FONT_LATIN | typeof FONT_DEVANAGARI;

/** The file names, in public/fonts, of each family. */
export const FONT_FILES: Record<FontFamily, { normal: string; bold: string }> = {
  [FONT_LATIN]: { normal: 'NotoSans-Regular.ttf', bold: 'NotoSans-Bold.ttf' },
  [FONT_DEVANAGARI]: {
    normal: 'NotoSansDevanagari-Regular.ttf',
    bold: 'NotoSansDevanagari-Bold.ttf',
  },
};

/** Whether Hindi letters are drawn with Noto Sans Devanagari. When false they are written as `?`, like any letter the fonts do not have. */
export const DEVANAGARI_SUPPORTED: boolean = true;

/** Whether some text of the content is set in the Devanagari font, so the engine must fetch it. Only `content` is looked at, never the pictures. */
export function usesDevanagari(definition: PdfDefinition): boolean {
  return hasDevanagariFont(definition.content);
}

function hasDevanagariFont(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasDevanagariFont);
  // A picture given as bytes is not walked letter by letter.
  if (typeof node !== 'object' || node === null || ArrayBuffer.isView(node)) return false;
  const fields = node as Record<string, unknown>;
  return fields.font === FONT_DEVANAGARI || Object.values(fields).some(hasDevanagariFont);
}
