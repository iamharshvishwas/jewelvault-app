// FB-B1 (Siddhi #9): the tag prints a real Code 128 of the piece barcode (the old bars were drawn from the letters' bits and no scanner could read them). The QR stays.
//
//   - the encoding of the exact barcode text, made by JsBarcode's own CODE128 encoder in node (no DOM), decodes back to the same text, with a good check symbol, the start pattern of set B
//     and the stop pattern: "a Code 128 symbol of exactly this value"
//   - the options the tag draws it with, the value it encodes, and the short name the tag prints
//   - the tag page draws one `svg[data-testid="tag-code128"]` for each tag, keeps the QR, and no longer draws the old bars
//
// The page is drawn on the server side of React over the real stores (tests/unit/support/rows.ts); the browser half (the svg really drawn, printed) is tests/e2e/print.spec.ts.
//
// Run: npm test -- tests/unit/tag-barcode.test.ts
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_SHORT_NAME } from '@/lib/businessConfig';
import { TAG_BARCODE_OPTIONS, tagBarcodeValue, tagShortName } from '@/lib/tagBarcode';
import { categoryRow, designRow, skuRow, uuid } from './support/rows';

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

async function drawTags() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const [cache, page] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/app/print-tags/components/PrintTagsClient'),
  ]);
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
