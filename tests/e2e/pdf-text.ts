import { inflateSync } from 'node:zlib';

// WEB13 (PT-W13): the text of each page of a PDF that Chromium printed (`page.pdf()`), so that a test can say what is on the paper: how many pages, which words are on the last
// one, whether the header row came back on a page that holds lines.
//
// It reads the one kind of PDF that Chromium's printer writes (Skia/PDF: plain objects, Flate-compressed streams, fonts as Type0 with a ToUnicode map) and nothing else; it is not a
// general PDF reader, and a file it does not understand gives no text, which makes a test fail, never pass. No package is added for it: `node:zlib` is enough. It was compared with
// poppler's `pdftotext` on the printed estimates and tags while it was written (same words, same page breaks).

export interface PdfPage {
  /** The page's size in points (1 pt = 1/72 inch): A4 is 595 x 842, A5 landscape 595 x 420. */
  width: number;
  height: number;
  /** The words of the page, one string per line of the paper, top to bottom, left to right (the pieces of a line are joined by one space). */
  lines: string[];
  /** The lines joined by newlines. */
  text: string;
  /** The same text with every white space taken out: "Grand Total ₹ 4,500" becomes "GrandTotal₹4,500", which does not depend on the font a glyph came from. */
  compact: string;
}

interface PdfObject {
  dict: string;
  data: Buffer | null;
}

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** a x b for the row-vector convention of PDF: apply a first, then b. */
function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

function parseObjects(pdf: Buffer): Map<number, PdfObject> {
  const raw = pdf.toString('latin1');
  const objects = new Map<number, PdfObject>();
  const header = /(\d+) 0 obj\s*/g;
  let at = 0;
  for (;;) {
    header.lastIndex = at;
    const found = header.exec(raw);
    if (!found) break;
    const start = found.index + found[0].length;
    const streamAt = raw.indexOf('stream', start);
    const endAt = raw.indexOf('endobj', start);
    const hasStream = streamAt !== -1 && (endAt === -1 || streamAt < endAt);
    if (!hasStream) {
      objects.set(Number(found[1]), {
        dict: raw.slice(start, endAt === -1 ? raw.length : endAt),
        data: null,
      });
      at = endAt === -1 ? raw.length : endAt + 6;
      continue;
    }
    const dict = raw.slice(start, streamAt);
    const dataStart = streamAt + 6 + (raw[streamAt + 6] === '\r' ? 2 : 1);
    const length = /\/Length (\d+)(?! \d+ R)/.exec(dict);
    const dataEnd = length ? dataStart + Number(length[1]) : raw.indexOf('endstream', dataStart);
    let data: Buffer = pdf.subarray(dataStart, dataEnd);
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(data);
      } catch {
        data = Buffer.alloc(0);
      }
    }
    objects.set(Number(found[1]), { dict, data });
    at = raw.indexOf('endstream', dataEnd) + 9;
    if (at < 9) break;
  }
  return objects;
}

const refOf = (dict: string, key: string): number | null => {
  const found = new RegExp(`/${key}\\s+(\\d+) 0 R`).exec(dict);
  return found ? Number(found[1]) : null;
};

const refsOf = (text: string): number[] =>
  [...text.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));

/** The pages in reading order: the kids of the page tree, followed down through every inner node. */
function pageNumbers(objects: Map<number, PdfObject>): number[] {
  const root = [...objects.entries()].find(([, o]) => /\/Type\s*\/Catalog/.test(o.dict));
  const rootPages = root ? refOf(root[1].dict, 'Pages') : null;
  if (rootPages === null) return [];
  const walk = (n: number): number[] => {
    const object = objects.get(n);
    if (!object) return [];
    if (/\/Type\s*\/Pages/.test(object.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(object.dict);
      return kids ? refsOf(kids[1]).flatMap(walk) : [];
    }
    return [n];
  };
  return walk(rootPages);
}

/** Glyph code -> text, from the font's ToUnicode CMap (the 2-byte codes of Chromium's Type0 fonts). */
function readCMap(source: string): Map<number, string> {
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    let text = '';
    for (let i = 0; i + 4 <= hex.length; i += 4)
      text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return text;
  };
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), utf16(pair[2]));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of block[1].matchAll(
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)/g
    )) {
      const low = parseInt(row[1], 16);
      const high = parseInt(row[2], 16);
      if (row[3].startsWith('[')) {
        [...row[3].matchAll(/<([0-9A-Fa-f]+)>/g)].forEach((m, i) => map.set(low + i, utf16(m[1])));
      } else {
        const first = utf16(row[3].slice(1, -1));
        for (let code = low; code <= high; code++) {
          map.set(
            code,
            first.slice(0, -1) +
              String.fromCharCode(first.charCodeAt(first.length - 1) + (code - low))
          );
        }
      }
    }
  }
  return map;
}

interface Piece {
  x: number;
  y: number;
  text: string;
}

const TOKEN =
  /\[|\]|<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\)])*\)|\/[^\s[\]<>()/]+|[-+]?\d*\.?\d+|[A-Za-z*'"]+/g;

/** The pieces of text a content stream shows, each with its place on the page. */
function readContent(content: string, fonts: Map<string, Map<number, string>>): Piece[] {
  const pieces: Piece[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let tm: Matrix = IDENTITY;
  let font: Map<number, string> | undefined;
  let operands: (string | number)[] = [];
  let array: (string | number)[] | null = null;

  const decode = (hex: string): string => {
    const digits = hex.replace(/\s+/g, '');
    let text = '';
    for (let i = 0; i + 4 <= digits.length; i += 4) {
      const code = parseInt(digits.slice(i, i + 4), 16);
      text += font?.get(code) ?? '';
    }
    return text;
  };
  const place = (text: string) => {
    if (text === '') return;
    pieces.push({
      x: ctm[0] * tm[4] + ctm[2] * tm[5] + ctm[4],
      y: ctm[1] * tm[4] + ctm[3] * tm[5] + ctm[5],
      text,
    });
  };

  for (const match of content.matchAll(TOKEN)) {
    const token = match[0];
    if (token === '[') {
      array = [];
      continue;
    }
    if (token === ']') {
      if (array) operands.push(JSON.stringify(array));
      array = null;
      continue;
    }
    const isHex = token.startsWith('<');
    const isNumber = /^[-+]?\d*\.?\d+$/.test(token);
    if (isHex || isNumber || token.startsWith('/') || token.startsWith('(')) {
      const value = isNumber ? Number(token) : token;
      if (array) array.push(value);
      else operands.push(value);
      continue;
    }
    // an operator
    const numbers = operands.filter((o): o is number => typeof o === 'number');
    switch (token) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? IDENTITY;
        break;
      case 'cm':
        if (numbers.length >= 6) ctm = multiply(numbers.slice(-6) as Matrix, ctm);
        break;
      case 'BT':
        tm = IDENTITY;
        break;
      case 'Tf': {
        const name = operands.find((o): o is string => typeof o === 'string' && o.startsWith('/'));
        font = name ? fonts.get(name.slice(1)) : undefined;
        break;
      }
      case 'Tm':
        if (numbers.length >= 6) tm = numbers.slice(-6) as Matrix;
        break;
      case 'Td':
      case 'TD':
        if (numbers.length >= 2)
          tm = multiply([1, 0, 0, 1, numbers[numbers.length - 2], numbers[numbers.length - 1]], tm);
        break;
      case 'Tj': {
        const shown = operands.find((o): o is string => typeof o === 'string' && o.startsWith('<'));
        if (shown) place(decode(shown.slice(1, -1)));
        break;
      }
      case 'TJ': {
        const list = operands.find((o): o is string => typeof o === 'string' && o.startsWith('['));
        if (list) {
          const parts = JSON.parse(list) as (string | number)[];
          let text = '';
          for (const part of parts) {
            if (typeof part === 'number') {
              if (part < -250) text += ' ';
            } else if (part.startsWith('<')) {
              text += decode(part.slice(1, -1));
            }
          }
          place(text);
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return pieces;
}

/** The lines of the paper: pieces within 2 points of each other in height are one line, left to right; the lines run from the top down. */
function linesOf(pieces: Piece[]): string[] {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: { y: number; items: Piece[] }[] = [];
  for (const piece of sorted) {
    const row = rows.find((r) => Math.abs(r.y - piece.y) < 2);
    if (row) row.items.push(piece);
    else rows.push({ y: piece.y, items: [piece] });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map((row) =>
      row.items
        .sort((a, b) => a.x - b.x)
        .map((item) => item.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => line !== '');
}

/** The pages of a PDF printed by Chromium: size and text. An empty list means the file is not one this reader understands. */
export function readPdf(pdf: Buffer): PdfPage[] {
  const objects = parseObjects(pdf);
  return pageNumbers(objects).map((number) => {
    const page = objects.get(number)!;
    const box = /\/MediaBox\s*\[([^\]]+)\]/
      .exec(page.dict)?.[1]
      .trim()
      .split(/\s+/)
      .map(Number) ?? [0, 0, 0, 0];
    // the fonts of the page: its own resources, or the object they point to
    const resourcesRef = refOf(page.dict, 'Resources');
    const resources = resourcesRef !== null ? (objects.get(resourcesRef)?.dict ?? '') : page.dict;
    const fonts = new Map<string, Map<number, string>>();
    const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? '';
    for (const entry of fontDict.matchAll(/\/([^\s/]+)\s+(\d+) 0 R/g)) {
      const unicode = refOf(objects.get(Number(entry[2]))?.dict ?? '', 'ToUnicode');
      const data = unicode !== null ? objects.get(unicode)?.data : null;
      fonts.set(entry[1], data ? readCMap(data.toString('latin1')) : new Map());
    }
    // the content: one stream or a list of them, read as one
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? '';
    const content = refsOf(contents)
      .map((n) => objects.get(n)?.data?.toString('latin1') ?? '')
      .join('\n');
    const lines = linesOf(readContent(content, fonts));
    const text = lines.join('\n');
    return {
      width: Math.round((box[2] - box[0]) * 100) / 100,
      height: Math.round((box[3] - box[1]) * 100) / 100,
      lines,
      text,
      compact: text.replace(/\s+/g, ''),
    };
  });
}

/** Every white space taken out, as `PdfPage.compact` has it. */
export const squash = (text: string): string => text.replace(/\s+/g, '');

/** How many times `needle` is on the page (white space ignored on both sides). */
export function countIn(page: PdfPage, needle: string): number {
  const wanted = squash(needle);
  if (wanted === '') return 0;
  let count = 0;
  for (
    let at = page.compact.indexOf(wanted);
    at !== -1;
    at = page.compact.indexOf(wanted, at + wanted.length)
  )
    count++;
  return count;
}
