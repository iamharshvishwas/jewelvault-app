// PDF-1: the text of a PDF, set in the font that can draw it. pdfmake draws a letter that is not in the font as an empty box, so each letter is sent to Noto Sans or to Noto Sans
// Devanagari, and a letter neither has (an emoji, Chinese) is written `?`. A long word with no space is given places to wrap, or it would run off the page.
import { DEVANAGARI_SUPPORTED, FONT_DEVANAGARI, FONT_LATIN } from './fonts';
import type { PdfContent } from './types';

/** Neighbouring letters set in one font. */
export interface Run {
  text: string;
  font: typeof FONT_LATIN | typeof FONT_DEVANAGARI;
}

/** The letters Noto Sans draws for us: new line, English, the accented Latin letters, dashes and quotes, the euro and the rupee. */
function isLatin(code: number): boolean {
  return (
    code === 0x0a ||
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0xa0 && code <= 0x24f) ||
    (code >= 0x2010 && code <= 0x2027) ||
    (code >= 0x2030 && code <= 0x203a) ||
    code === 0x20ac ||
    code === 0x20b9
  );
}

/** Hindi (the Devanagari block) and the two joiners that shape its letters. */
function isDevanagari(code: number): boolean {
  return (code >= 0x0900 && code <= 0x097f) || code === 0x200c || code === 0x200d;
}

/**
 * The text in runs by font; `replaced` counts the letters written as `?`. With `devanagari` false, Hindi letters are written `?` too. First a Windows line end (`\r\n`) or a lone `\r`
 * becomes a new line, and a tab a space: Noto Sans has no letter for either, so an address typed on Windows would show a `?` and a tab an empty box.
 */
export function splitScripts(
  text: string,
  options: { devanagari: boolean }
): { runs: Run[]; replaced: number } {
  const runs: Run[] = [];
  let replaced = 0;
  for (const letter of text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ')) {
    const code = letter.codePointAt(0) ?? 0;
    let font: Run['font'] = FONT_LATIN;
    let drawn = letter;
    if (options.devanagari && isDevanagari(code)) font = FONT_DEVANAGARI;
    else if (!isLatin(code)) {
      drawn = '?';
      replaced += 1;
    }
    const last = runs[runs.length - 1];
    if (last?.font === font) last.text += drawn;
    else runs.push({ text: drawn, font });
  }
  return { runs, replaced };
}

// A letter as a reader sees it, so a Hindi letter is never parted from its vowel sign. A browser without Intl.Segmenter counts code points.
const graphemes =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function lettersOf(word: string): string[] {
  return graphemes ? Array.from(graphemes.segment(word), (part) => part.segment) : Array.from(word);
}

/** A zero-width space (U+200B, a place pdfmake may wrap) after every `longest` letters of a word with no space. Shorter words are left as they are. */
export function breakableText(text: string, longest = 24): string {
  return text
    .split(/(\s+)/)
    .map((part, i) => {
      // The odd parts are the spaces between the words.
      if (i % 2 === 1 || part.length <= longest) return part;
      const letters = lettersOf(part);
      return letters
        .map((letter, n) => (n > 0 && n % longest === 0 ? '\u200B' : '') + letter)
        .join('');
    })
    .join('');
}

/** Text for a PDF: in runs by font (Hindi only while DEVANAGARI_SUPPORTED), each able to wrap, with the style given (bold, fontSize, alignment, ...). */
export function pdfText(text: string, style: Record<string, unknown> = {}): PdfContent {
  const { runs } = splitScripts(text, { devanagari: DEVANAGARI_SUPPORTED });
  return {
    ...style,
    text: runs.map((run) => ({ text: breakableText(run.text), font: run.font })),
  } as PdfContent;
}
