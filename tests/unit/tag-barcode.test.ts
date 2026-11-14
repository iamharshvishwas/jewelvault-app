// FB-B1 (Siddhi #9): the tag prints a real Code 128 of the piece barcode (the old bars were drawn from the letters' bits and no scanner could read them). The QR stays.
//
//   - the encoding of the exact barcode text, made by JsBarcode's own CODE128 encoder in node (no DOM), decodes back to the same text, with a good check symbol, the start pattern of set B
//     and the stop pattern: "a Code 128 symbol of exactly this value"
//   - the options the tag draws it with, the value it encodes, and the short name the tag prints
//   - the tag page draws one `svg[data-testid="tag-code128"]` for each tag, keeps the QR, and no longer draws the old bars
//
//   - FB-B fix 2: the barcode end of the tag fits every tag size the Settings allow (height from 13 mm, any barcode height): the Code 128 is always there and at least 4 mm high, the QR and
//     the second printing of the piece number only where they fit; the default 28 mm tag is laid out as before
//
// The page is drawn on the server side of React over the real stores (tests/unit/support/rows.ts); the browser half (the svg really drawn, printed) is tests/e2e/print.spec.ts.
//
// Run: npm test -- tests/unit/tag-barcode.test.ts
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_SHORT_NAME } from '@/lib/businessConfig';
import {
  TAG_BARCODE_OPTIONS,
  TAG_ROOM_MM,
  tagBarcodeLayout,
  tagBarcodeValue,
  tagShortName,
} from '@/lib/tagBarcode';
import { categoryRow, designRow, settingRow, skuRow, uuid } from './support/rows';

// JsBarcode ships no types for its inner modules: the encoder and its symbol table are read the way node reads them.
const nodeRequire = createRequire(__filename);
const encoders = nodeRequire('jsbarcode/bin/barcodes').default as Record<
  string,
  new (text: string, options: Record<string, unknown>) => { encode(): { data: string } }
>;
const { BARS, STOP } = nodeRequire('jsbarcode/bin/barcodes/CODE128/constants') as {
  BARS: number[];
  STOP: number;
};

const SYMBOL_WIDTH = 11;
const START_B = '11010010000';
/** Symbol patterns to their values (0 to 106). */
const VALUE_OF = new Map(BARS.map((bits, value) => [String(bits), value]));

/** Reads a Code 128 symbol back: start, data (sets A, B and C with their switches), check symbol, stop. */
function decode128(bits: string): { text: string; checkOk: boolean; start: number } {
  const stopBits = String(BARS[STOP]);
  expect(bits.endsWith(stopBits), 'ends with the stop pattern').toBe(true);
  const body = bits.slice(0, bits.length - stopBits.length);
  expect(body.length % SYMBOL_WIDTH, 'whole 11-module symbols').toBe(0);
  const values: number[] = [];
  for (let at = 0; at < body.length; at += SYMBOL_WIDTH) {
    const value = VALUE_OF.get(body.slice(at, at + SYMBOL_WIDTH));
    expect(value, `a known symbol at module ${at}`).toBeDefined();
    values.push(value as number);
  }
  const start = values[0];
  expect([103, 104, 105]).toContain(start);
  const check = values[values.length - 1];
  const data = values.slice(1, -1);
  let set = start === 103 ? 'A' : start === 104 ? 'B' : 'C';
  let sum = start;
  let text = '';
  data.forEach((value, i) => {
    sum += value * (i + 1);
    if (value === 99) set = 'C';
    else if (value === 100) set = 'B';
    else if (value === 101) set = 'A';
    else if (set === 'C') text += String(value).padStart(2, '0');
    else if (set === 'B') text += String.fromCharCode(value + 32);
    else text += String.fromCharCode(value < 64 ? value + 32 : value - 64);
  });
  return { text, checkOk: sum % 103 === check, start };
}

const encode = (value: string) => {
  const Encoder = encoders[TAG_BARCODE_OPTIONS.format];
  return new Encoder(value, TAG_BARCODE_OPTIONS as unknown as Record<string, unknown>).encode()
    .data;
};

describe('FB-B1 the tag barcode is a real Code 128 of the piece barcode', () => {
  it('draws with the options of the brief: CODE128, no printed text, no margin, 28 high, 1 wide', () => {
    expect(TAG_BARCODE_OPTIONS).toEqual({
      format: 'CODE128',
      displayValue: false,
      margin: 0,
      height: 28,
      width: 1,
    });
  });

  it('BC-RING-00001-001 encodes to a Code 128 symbol that decodes back to exactly that text', () => {
    const value = 'BC-RING-00001-001';
    const bits = encode(value);
    expect(bits).toMatch(/^[01]+$/);
    // it begins with the start pattern of set B (a letter comes first) and ends with the stop pattern
    expect(bits.startsWith(START_B)).toBe(true);
    const decoded = decode128(bits);
    expect(decoded.text).toBe(value);
    expect(decoded.checkOk).toBe(true);
    expect(decoded.start).toBe(104);
  });

  it('other barcodes of the shop round-trip too (digits only, long, short)', () => {
    for (const value of ['BC100001', 'BC-CHAIN-00012-004', '123456', 'A']) {
      const decoded = decode128(encode(value));
      expect(decoded.text, value).toBe(value);
      expect(decoded.checkOk, value).toBe(true);
    }
  });

  it('encodes the piece barcode, or the piece number when the piece has none (as the QR does)', () => {
    expect(tagBarcodeValue({ barcode: 'BC-RING-00001-001', skuNumber: 'RING-00001-001' })).toBe(
      'BC-RING-00001-001'
    );
    expect(tagBarcodeValue({ barcode: '', skuNumber: 'RING-00001-001' })).toBe('RING-00001-001');
  });

  it("the tag's business name is the Settings' short name, and the shop's configured one when blank", () => {
    expect(tagShortName({ displayName: 'Siddhi Jewels' })).toBe('Siddhi Jewels');
    expect(tagShortName({ displayName: '  Siddhi Jewels  ' })).toBe('Siddhi Jewels');
    expect(tagShortName({ displayName: '' })).toBe(BUSINESS_SHORT_NAME);
    expect(tagShortName({ displayName: '   ' })).toBe(BUSINESS_SHORT_NAME);
    expect(tagShortName(undefined)).toBe(BUSINESS_SHORT_NAME);
  });
});

// ================================================================================================ the tag page

async function drawTags(template?: Record<string, unknown>) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const [cache, page] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/app/print-tags/components/PrintTagsClient'),
  ]);
  if (template) cache.rowCache.merge('settings', [settingRow('tag_template', template)]);
  cache.rowCache.merge('categories', [categoryRow(1, 'Ring', 'RING')]);
  cache.rowCache.merge('designs', [
    designRow(1, { design_no: 'RING-00001', name: 'Alpha ring', category_id: uuid(101) }),
  ]);
  cache.rowCache.merge('skus', [
    skuRow(1, 1, { sku_no: 'RING-00001-001', barcode: 'BC-RING-00001-001' }),
    skuRow(2, 1, { sku_no: 'RING-00001-002', barcode: 'BC-RING-00001-002' }),
    skuRow(3, 1, { sku_no: 'RING-00001-003', barcode: 'BC-RING-00001-003', status: 'Sold' }),
  ]);
  return renderToStaticMarkup(React.createElement(page.default));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('FB-B1 the tag page draws the Code 128 and keeps the QR', () => {
  it('one Code 128 svg for each tag, none for a sold piece, the QR still there, the old bars gone', async () => {
    const html = await drawTags();
    expect(html.match(/data-testid="tag-code128"/g)).toHaveLength(2);
    // the QR keeps its place (it is drawn after the page, so a static render has its empty frame)
    expect(html.match(/class="tag-qr tag-qr-empty"/g)).toHaveLength(2);
    expect(html).not.toContain('tag-barcode-bars');
    // the text under the bars is still the barcode, and the business name is not the old fixed "JGP"
    expect(html).toContain('BC-RING-00001-001');
    expect(html).not.toContain('>JGP<');
    expect(html).toContain(`>${BUSINESS_SHORT_NAME}<`);
  });
});

// ================================================================================================ FB-B fix 2: every tag size

/** What the layout puts in the barcode end, in mm, from the numbers it hands back. */
function used(layout: ReturnType<typeof tagBarcodeLayout>) {
  return (
    layout.barcodeMm +
    TAG_ROOM_MM.text +
    TAG_ROOM_MM.margin +
    (layout.showNumber ? TAG_ROOM_MM.text : 0) +
    (layout.showQr ? TAG_ROOM_MM.qr : 0)
  );
}
const roomOf = (heightMm: number) => heightMm - TAG_ROOM_MM.chrome;

describe('FB-B fix 2 the barcode end of the tag fits every tag size the Settings allow', () => {
  it('the default tag (28 mm high, barcode 8 mm) is laid out as before: a Code 128 8 mm high, the QR and the piece number under it', () => {
    expect(tagBarcodeLayout(28, 8)).toEqual({ barcodeMm: 8, showQr: true, showNumber: true });
  });

  it('the smallest tag (13 mm) keeps a scannable Code 128 (4 mm or more) and drops the QR and the second piece number, which do not fit', () => {
    const layout = tagBarcodeLayout(13, 8);
    expect(layout.showQr).toBe(false);
    expect(layout.showNumber).toBe(false);
    expect(layout.barcodeMm).toBeGreaterThanOrEqual(TAG_ROOM_MM.minBarcode);
    expect(used(layout)).toBeLessThanOrEqual(roomOf(13));
  });

  it('a height below 13 is the 13 the tag page already raises it to; rubbish in the Settings is the default barcode height and the smallest tag', () => {
    expect(tagBarcodeLayout(5, 8)).toEqual(tagBarcodeLayout(13, 8));
    expect(tagBarcodeLayout(Number.NaN, 8)).toEqual(tagBarcodeLayout(13, 8));
    expect(tagBarcodeLayout(28, Number.NaN)).toEqual(tagBarcodeLayout(28, 8));
    expect(tagBarcodeLayout(28, -3)).toEqual(tagBarcodeLayout(28, 8));
  });

  it('keeps the stack inside the tag for EVERY height from 13 to 80 mm and EVERY barcode height from 0 to 60 mm, with a Code 128 of at least 4 mm', () => {
    for (let height = 13; height <= 80; height += 0.5) {
      for (let wanted = 0; wanted <= 60; wanted += 1) {
        const layout = tagBarcodeLayout(height, wanted);
        const where = `height ${height}, barcode ${wanted}`;
        expect(layout.barcodeMm, where).toBeGreaterThanOrEqual(TAG_ROOM_MM.minBarcode);
        expect(used(layout), where).toBeLessThanOrEqual(roomOf(height) + 1e-9);
      }
    }
  });

  it('a barcode taller than the room is cut to the room, and one shorter than 8 mm is the 8 mm the tag always had when there is room', () => {
    const tall = tagBarcodeLayout(28, 30);
    expect(tall.barcodeMm).toBeLessThan(30);
    expect(used(tall)).toBeLessThanOrEqual(roomOf(28) + 1e-9);
    expect(tagBarcodeLayout(40, 5).barcodeMm).toBe(8);
    expect(tagBarcodeLayout(40, 12).barcodeMm).toBe(12);
  });

  it('the QR is on a tag as soon as it fits beside a Code 128 of 6 mm or more, and not before', () => {
    let first: number | null = null;
    for (let height = 13; height <= 40; height += 0.1) {
      const layout = tagBarcodeLayout(height, 8);
      if (layout.showQr) {
        first = first ?? height;
        expect(layout.barcodeMm).toBeGreaterThanOrEqual(6);
      } else {
        expect(first, `the QR does not come and go (height ${height})`).toBeNull();
      }
    }
    expect(first).not.toBeNull();
    expect(first as number).toBeLessThanOrEqual(28);
  });

  it('the tag page at the smallest size: one Code 128 for each tag at the height the layout gives, no QR, no second piece number', async () => {
    const html = await drawTags({ heightMm: 13 });
    const layout = tagBarcodeLayout(13, 8);
    expect(html.match(/data-testid="tag-code128"/g)).toHaveLength(2);
    expect(html.match(new RegExp(`style="height:${layout.barcodeMm}mm"`, 'g'))).toHaveLength(2);
    expect(html).not.toContain('tag-qr');
    expect(html).not.toContain('tag-barcode-number');
    expect(html).toContain('BC-RING-00001-001'); // the barcode is still printed in words
  });

  it('the tag page at the default size is as before: QR and second piece number, the Code 128 8 mm high', async () => {
    for (const html of [await drawTags(), await drawTags({ heightMm: 28, barcodeHeightMm: 8 })]) {
      expect(html.match(/data-testid="tag-code128"/g)).toHaveLength(2);
      expect(html.match(/style="height:8mm"/g)).toHaveLength(2);
      expect(html.match(/class="tag-qr tag-qr-empty"/g)).toHaveLength(2);
      expect(html.match(/class="tag-barcode-number"/g)).toHaveLength(2);
    }
  });
});
