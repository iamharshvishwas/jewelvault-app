// PDF-1: the PDF engine's parts that run in Node, and the two readers the later PDF tests use.
//   - a definition is drawn with the shop's fonts (public/fonts) and read back: one A4 page, the rupee sign and an accented letter, bold text from the bold file
//   - `splitScripts` sends each letter to the font that can draw it (Latin and the rupee to Noto Sans, Hindi to Noto Sans Devanagari) and writes any other letter as `?`; a Windows
//     line end or a lone carriage return becomes a new line, and a tab a space
//   - `breakableText` lets a long word with no space wrap, `usesDevanagari` says whether the Hindi font must be fetched (from the content only), and a Hindi name is drawn through `pdfText`
//
// The definition is drawn by pdfmake's Node build (tests/unit/support/pdf-node.ts) and read by pdf.js (tests/unit/support/pdf-read.ts), apart from the browser engine (src/lib/pdf/engine.ts),
// which tests/unit/pdf-engine-browser.test.ts runs over pdfmake's browser build.
//
// Run: npm test -- tests/unit/pdf-engine.test.ts
import { describe, expect, it } from 'vitest';
import { FONT_DEVANAGARI, FONT_LATIN, usesDevanagari } from '@/lib/pdf/fonts';
import { breakableText, pdfText, splitScripts } from '@/lib/pdf/scripts';
import type { PdfDefinition } from '@/lib/pdf/types';
import { renderPdf } from './support/pdf-node';
import { compact, readMadePdf } from './support/pdf-read';

const latin = (content: PdfDefinition['content']): PdfDefinition => ({
  pageSize: 'A4',
  defaultStyle: { font: FONT_LATIN },
  content,
});

describe('PDF-1: drawing and reading a PDF', () => {
  it('makes a one-page A4 PDF with the rupee sign and an accented letter', async () => {
    const bytes = await renderPdf(latin(['Grand Total ₹1,43,000', 'Anita Sharmá']));
    expect(new TextDecoder('latin1').decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const pdf = await readMadePdf(bytes);
    expect(pdf.pageCount).toBe(1);
    expect(compact(pdf.pages[0])).toContain('GrandTotal₹1,43,000');
    expect(compact(pdf.pages[0])).toContain('AnitaSharmá');
  });

  it('draws bold text from the bold file', async () => {
    const bytes = await renderPdf(latin([{ text: 'Grand Total', bold: true }]));
    const pdf = await readMadePdf(bytes);
    expect(compact(pdf.pages[0])).toContain('GrandTotal');
    // The embedded font is named after the file's PostScript name, behind a subset tag (`ABCDEF+`).
    const raw = new TextDecoder('latin1').decode(bytes);
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Bold\b/);
    expect(raw).not.toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSans-Regular\b/);
  });

  it('draws a Devanagari name through the fallback font', async () => {
    const bytes = await renderPdf(latin([pdfText('अनीता शर्मा')]));
    const pdf = await readMadePdf(bytes);
    // The letters of a shaped Hindi word come back in the order they are drawn, so only their number is checked.
    expect(pdf.pages[0].match(/[ऀ-ॿ]/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });
});

describe('PDF-1: scripts and fonts', () => {
  it('splitScripts keeps Latin and the rupee, sends Devanagari to its font and writes the rest as ?', () => {
    expect(splitScripts('Anita शर्मा ₹5 😀', { devanagari: true })).toEqual({
      runs: [
        { text: 'Anita ', font: FONT_LATIN },
        { text: 'शर्मा', font: FONT_DEVANAGARI },
        { text: ' ₹5 ?', font: FONT_LATIN },
      ],
      replaced: 1,
    });
    expect(splitScripts('Anita शर्मा ₹5 😀', { devanagari: false })).toEqual({
      runs: [{ text: 'Anita ????? ₹5 ?', font: FONT_LATIN }],
      replaced: 6,
    });
  });

  it('splitScripts turns a Windows line end and a lone carriage return into a new line, and a tab into a space', () => {
    expect(splitScripts('12 MG Road\r\nJohari Bazar\rJaipur', { devanagari: true })).toEqual({
      runs: [{ text: '12 MG Road\nJohari Bazar\nJaipur', font: FONT_LATIN }],
      replaced: 0,
    });
    expect(splitScripts('Ring\tR-001', { devanagari: true })).toEqual({
      runs: [{ text: 'Ring R-001', font: FONT_LATIN }],
      replaced: 0,
    });
  });

  it('breakableText splits a long token only', () => {
    const A = (n: number) => 'A'.repeat(n);
    expect(breakableText(A(60))).toBe(`${A(24)}\u200B${A(24)}\u200B${A(12)}`);
    expect(breakableText('Anita Sharma')).toBe('Anita Sharma');
  });

  it('usesDevanagari looks at the content only', () => {
    expect(usesDevanagari({ content: [pdfText('शर्मा')] })).toBe(true);
    expect(
      usesDevanagari({ content: ['Anita'], images: { a: 'data:image/png;base64,शर्मा' } })
    ).toBe(false);
    // The font set outside the content (the default style, a header) is not looked at.
    expect(usesDevanagari({ content: ['Anita'], defaultStyle: { font: FONT_DEVANAGARI } })).toBe(
      false
    );
    expect(
      usesDevanagari({ content: ['Anita'], header: { text: 'Shop', font: FONT_DEVANAGARI } })
    ).toBe(false);
    // A picture given as bytes (pdfmake takes them; its types still say string) is not looked into: these bytes carry a `font` field that a walk into them would find.
    const bytes = Object.assign(new Uint8Array([0xff, 0xd8, 0xff]), { font: FONT_DEVANAGARI });
    expect(usesDevanagari({ content: [{ image: bytes as unknown as string }] })).toBe(false);
  });
});
