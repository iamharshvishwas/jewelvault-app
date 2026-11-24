// PDF-5: the stock catalogue as a PDF (src/lib/pdf/cataloguePdf.ts), the print of the sheet of StockCatalogueClient (src/app/stock-catalogue/components/StockCatalogueClient.tsx):
//   - the header (the shop's name; `Ready stock as of 24/11/2026`, or `Ready stock` with no business date), one heading per category, three cards a row; each card: the photo, the design
//     number, the name, the purity, `Gross {range}` and `{n} piece(s) in stock`, in that order, as the screen draws them
//   - a photo is stored once however many cards show it; a design with no photo, or whose photo did not arrive, shows `No photo`
//   - never a price, never `₹`, never the owner's original weight, never the customer's net weight, whatever the designs' pieces carry
//   - a row of cards is never cut, a category's heading is never the last thing on a page; 300 designs run over many pages; nothing in stock says so
//   - text a person typed: a long design number and a long name stay inside their card; a Hindi name is set in the Devanagari font, from the content
//   - `grossShown` and `dayShown`, moved from the screen to src/lib/stockCatalogue.ts, write what the screen wrote
//
// The definition is drawn by pdfmake's Node build (tests/unit/support/pdf-node.ts) and read back by pdf.js (tests/unit/support/pdf-read.ts). A definition is drawn once: pdfmake writes into it.
//
// Run: npm test -- tests/unit/catalogue-pdf.test.ts
import { describe, expect, it } from 'vitest';
import type { Design, Sku } from '@/lib/mockData';
import { usesDevanagari } from '@/lib/pdf/fonts';
import { cataloguePdfDefinition, type CataloguePdfInput } from '@/lib/pdf/cataloguePdf';
import type { PdfDefinition } from '@/lib/pdf/types';
import { catalogueRows, dayShown, grossShown, type CatalogueRow } from '@/lib/stockCatalogue';
import { renderPdf } from './support/pdf-node';
import { compact, readMadePdf, readPlacedText, type MadePdf } from './support/pdf-read';

// Two 1 x 1 grey JPEGs (different greys: pdfmake stores a picture once by its bytes) and a 1 x 1 gold PNG with no transparency (a PNG with an alpha channel is stored with its mask, a
// second picture). Not the PNG tests/e2e/stock-catalogue.spec.ts had before PDF-6: that one is cut short, pdfmake cannot open it (tests/unit/photo-fetch.test.ts leaves it out as a failed photo).
const JPEG_LIGHT_HEX =
  'FFD8FFE000104A46494600010100000100010000FFDB004300100B0C0E0C0A100E0D0E1211101318281A181616183123251D283A333D3C3933383740485C4E404457453738506D51575F626768673E4D71797064785C656763FFC0000B080001000101011100FFC40014000100000000000000000000000000000005FFC40014100100000000000000000000000000000000FFDA0008010100003F0069FFD9';
const JPEG_DARK_HEX =
  'FFD8FFE000104A46494600010100000100010000FFDB004300100B0C0E0C0A100E0D0E1211101318281A181616183123251D283A333D3C3933383740485C4E404457453738506D51575F626768673E4D71797064785C656763FFC0000B080001000101011100FFC40014000100000000000000000000000000000006FFC40014100100000000000000000000000000000000FFDA0008010100003F003AFFD9';
const PNG_HEX =
  '89504E470D0A1A0A0000000D4948445200000001000000010802000000907753DE0000000C4944415478DA63B8B2DE1C00041501BB877ABA670000000049454E44AE426082';

const dataUrl = (type: string, hex: string) =>
  `data:${type};base64,${Buffer.from(hex, 'hex').toString('base64')}`;
const JPEG_LIGHT = dataUrl('image/jpeg', JPEG_LIGHT_HEX);
const JPEG_DARK = dataUrl('image/jpeg', JPEG_DARK_HEX);
const PNG = dataUrl('image/png', PNG_HEX);

const SHOP = 'Shree Ganesh Jewellers';

/** A row of the catalogue: a 22K design with one piece of 3.100 g in stock unless the test says otherwise. */
function row(designNumber: string, fields: Partial<CatalogueRow> = {}): CatalogueRow {
  return {
    designNumber,
    designName: `${designNumber} name`,
    category: 'Ring',
    purity: '22K',
    photoId: null,
    inStock: 1,
    grossMinMg: 3100,
    grossMaxMg: 3100,
    ...fields,
  };
}

function input(fields: Partial<CataloguePdfInput> = {}): CataloguePdfInput {
  return {
    shopName: SHOP,
    businessDate: '2026-11-24',
    groups: [],
    photos: new Map(),
    ...fields,
  };
}

/** The groups as the screen makes them: one a category, in the order given. */
function groupsOf(rows: CatalogueRow[]): CataloguePdfInput['groups'] {
  const categories = [...new Set(rows.map((r) => r.category))];
  return categories.map((category) => ({
    category,
    rows: rows.filter((r) => r.category === category),
  }));
}

async function drawn(definition: PdfDefinition): Promise<MadePdf> {
  return readMadePdf(await renderPdf(definition));
}

const pdfOf = (pdfInput: CataloguePdfInput) => drawn(cataloguePdfDefinition(pdfInput));

const linesOf = (page: string) => page.split('\n');

/** How many times `part` is in `text`, both compacted. */
const timesIn = (text: string, part: string) => compact(text).split(compact(part)).length - 1;

/** `n` designs of a category: {prefix}-0001, {prefix}-0002, ... */
function designs(n: number, prefix: string, category: string, fields: Partial<CatalogueRow> = {}) {
  return Array.from({ length: n }, (_, i) =>
    row(`${prefix}-${String(i + 1).padStart(4, '0')}`, {
      category,
      designName: `Design ${i + 1}`,
      ...fields,
    })
  );
}

// ================================================================================================ the helpers moved from the screen

describe('PDF-5: the words of the screen, from src/lib/stockCatalogue.ts', () => {
  it('grossShown: a range, or one weight when the pieces weigh the same', () => {
    expect(grossShown(row('RING-1', { grossMinMg: 4200, grossMaxMg: 5500 }))).toBe(
      '4.200 - 5.500 g'
    );
    expect(grossShown(row('RING-1', { grossMinMg: 3100, grossMaxMg: 3100 }))).toBe('3.100 g');
  });

  it('dayShown: the business date as the screen writes it', () => {
    expect(dayShown('2026-11-24')).toBe('24/11/2026');
    // en-IN writes a day or a month of one digit without a 0, on the screen as on the PDF
    expect(dayShown('2027-01-05')).toBe('5/1/2027');
  });
});

// ================================================================================================ the sheet and its cards

describe('PDF-5: the sheet', () => {
  it('six rings: two rows of three, each card as the screen draws it', async () => {
    const rings = [
      row('RING-00001', {
        designName: 'Lotus band',
        photoId: 'photo-a',
        inStock: 3,
        grossMinMg: 4200,
        grossMaxMg: 5500,
      }),
      row('RING-00002', { designName: 'Twist band', purity: '18K', photoId: 'photo-b' }),
      row('RING-00003', {
        designName: 'Plain band',
        inStock: 2,
        grossMinMg: 6000,
        grossMaxMg: 6000,
      }),
      row('RING-00004', { designName: 'Leaf band', photoId: 'photo-a' }),
      row('RING-00005', { designName: 'Rope band', photoId: 'photo-b', purity: '14K' }),
      row('RING-00006', { designName: 'Star band', photoId: 'photo-a', inStock: 5 }),
    ];
    const pdf = await pdfOf(
      input({
        groups: groupsOf(rings),
        photos: new Map([
          ['photo-a', JPEG_LIGHT],
          ['photo-b', PNG],
        ]),
      })
    );
    expect(pdf.pageCount).toBe(1);
    // Line by line, top to bottom: the header, the category, then each row of cards, a card's line beside the same line of the other cards of its row. The third card of the first row has
    // no photo; every card of the second row has one.
    expect(linesOf(pdf.pages[0]).map(compact)).toEqual(
      [
        SHOP,
        'Ready stock as of 24/11/2026',
        'Ring',
        'No photo',
        'RING-00001 RING-00002 RING-00003',
        'Lotus band Twist band Plain band',
        '22K 18K 22K',
        'Gross 4.200 - 5.500 g Gross 3.100 g Gross 6.000 g',
        '3 pieces in stock 1 piece in stock 2 pieces in stock',
        'RING-00004 RING-00005 RING-00006',
        'Leaf band Rope band Star band',
        '22K 14K 22K',
        'Gross 3.100 g Gross 3.100 g Gross 3.100 g',
        '1 piece in stock 1 piece in stock 5 pieces in stock',
        'Page 1 of 1',
      ].map(compact)
    );
    for (const ring of rings) expect(timesIn(pdf.pages[0], ring.designNumber)).toBe(1);
  });

  it('a photo used twice is stored once', async () => {
    const rings = [
      row('RING-00001', { photoId: 'photo-a' }),
      row('RING-00002', { photoId: 'photo-b' }),
      row('RING-00003', { photoId: 'photo-a' }),
      row('RING-00004', { photoId: 'photo-b' }),
    ];
    const definition = cataloguePdfDefinition(
      input({
        groups: groupsOf(rings),
        // a photo no card shows is not put in the file
        photos: new Map([
          ['photo-a', JPEG_LIGHT],
          ['photo-b', JPEG_DARK],
          ['photo-unused', PNG],
        ]),
      })
    );
    expect(Object.keys(definition.images ?? {}).sort()).toEqual(['photo-a', 'photo-b']);
    const pdf = await drawn(definition);
    expect(pdf.imageCount).toBe(new Set(rings.map((r) => r.photoId)).size);
    expect(pdf.pages[0]).not.toContain('No photo');
  });

  it('missing photo shows No photo', async () => {
    const rings = [
      // no photo at all, and a photo that did not arrive (it is not in the map: a 404, a timeout)
      row('RING-00001', { photoId: null }),
      row('RING-00002', { photoId: 'photo-lost' }),
      row('RING-00003', { photoId: 'photo-a' }),
    ];
    const definition = cataloguePdfDefinition(
      input({ groups: groupsOf(rings), photos: new Map([['photo-a', JPEG_LIGHT]]) })
    );
    expect(Object.keys(definition.images ?? {})).toEqual(['photo-a']);
    const pdf = await drawn(definition);
    expect(pdf.pages[0].match(/No photo/g)).toHaveLength(2);
    expect(pdf.imageCount).toBe(1);
    // the two placeholders are the first two cards of the row
    expect(linesOf(pdf.pages[0])).toContain('No photo No photo');
  });

  it("no price, no rupee, no original weight, no customer's net weight", async () => {
    // Designs whose pieces carry the owner's weight (9.876 g), the customer's net weight (4.321 g), labour and piroi, made into rows by the screen's own catalogueRows.
    const piece = (designNumber: string, n: number, gross: number): Sku => ({
      id: `${designNumber}-${n}`,
      skuNumber: `${designNumber}-${String(n).padStart(3, '0')}`,
      designId: designNumber,
      designNumber,
      grossWeight: gross,
      originalNetWeight: 9.876,
      customerNetWeight: 4.321,
      stones: 0,
      stoneWeight: 0,
      kundan: 0,
      kundanWeight: 0,
      piroi: 777,
      labour: 353,
      status: 'In Stock',
      location: 'Main Showroom',
      barcode: `BC${n}`,
      createdAt: '2026-10-14T08:00:00.000Z',
      createdBy: 'Asha Verma',
      notes: '',
      sellingMethod: 'By Weight',
      purity: '22K',
      material: 'Gold',
      category: 'Ring',
      subcategory: '',
    });
    const design = (designNumber: string, grosses: number[]): Design => ({
      id: designNumber,
      designNumber,
      designName: `${designNumber} name`,
      category: 'Ring',
      subcategory: '',
      material: 'Gold',
      purity: '22K',
      sellingMethod: 'By Weight',
      description: '',
      notes: '',
      tags: [],
      images: ['/assets/images/no_image.png'],
      primaryImage: '/assets/images/no_image.png',
      skus: grosses.map((gross, i) => piece(designNumber, i + 1, gross)),
      createdAt: '2026-10-14T08:00:00.000Z',
      createdBy: 'Asha Verma',
      labour: 353,
      piroi: 777,
    });
    const rows = catalogueRows(
      [design('RING-00001', [5.5, 4.2]), design('RING-00002', [3.1])],
      ['Ring']
    );
    // and a row that came with keys of its own: the PDF reads the keys of a row, nothing else
    const stray = {
      ...row('RING-00003'),
      originalNetWeight: 9.876,
      customerNetWeight: 4.321,
      price: 54321,
      rate: 7250,
    } as CatalogueRow;
    const definition = cataloguePdfDefinition(input({ groups: groupsOf([...rows, stray]) }));
    expect(JSON.stringify(definition.content)).not.toMatch(/9\.876|4\.321|54321|7250|₹/);
    const pdf = await drawn(definition);
    expect(pdf.pageCount).toBe(1);
    expect(compact(pdf.pages[0])).toContain(compact('Gross 4.200 - 5.500 g'));
    for (const page of pdf.pages) {
      expect(page).not.toContain('₹');
      expect(page).not.toMatch(/\bRs\b/);
      expect(page).not.toContain('9.876');
      expect(page).not.toContain('4.321');
      expect(page).not.toMatch(/353|777|54,?321|7,?250/);
      expect(page.toLowerCase()).not.toMatch(/price|rate|labour|piroi|net/);
    }
  });

  it('no groups: nothing in stock is said', async () => {
    const pdf = await pdfOf(input({ groups: [] }));
    expect(pdf.pageCount).toBe(1);
    expect(linesOf(pdf.pages[0])).toEqual([
      SHOP,
      'Ready stock as of 24/11/2026',
      'No design with a piece in stock.',
      'Page 1 of 1',
    ]);
    expect(pdf.imageCount).toBe(0);
  });

  it('no business date: Ready stock, with no date', async () => {
    const pdf = await pdfOf(input({ businessDate: null, groups: groupsOf([row('RING-00001')]) }));
    const lines = linesOf(pdf.pages[0]);
    expect(lines[1]).toBe('Ready stock');
    expect(pdf.pages[0]).not.toContain('as of');
  });

  it('A4, the footer holds the page count and nothing typed, no header', () => {
    const definition = cataloguePdfDefinition(input({ groups: groupsOf([row('RING-00001')]) }));
    expect(definition.pageSize).toBe('A4');
    expect(definition.header).toBeUndefined();
    const footer = definition.footer as (page: number, pages: number, size: unknown) => unknown;
    expect(JSON.stringify(footer(2, 3, { width: 595.28, height: 841.89 }))).toContain(
      '"Page 2 of 3"'
    );
    // each row of cards is kept whole
    expect(JSON.stringify(definition.content)).toContain('"unbreakable":true');
  });
});

// ================================================================================================ pages

describe('PDF-5: pages', () => {
  it('a heading is never last on a page', async () => {
    // Two categories of 30 designs; and, so that the end of the first category falls at each place on its page, 27 to 33 in the first.
    for (const first of [30, 27, 28, 29, 31, 32, 33]) {
      const rows = [...designs(first, 'BG', 'Bangles'), ...designs(30, 'NK', 'Necklaces')];
      const pdf = await pdfOf(input({ groups: groupsOf(rows) }));
      expect(pdf.pageCount, `${first} bangles`).toBeGreaterThan(5);
      const headings = { Bangles: 'BG-', Necklaces: 'NK-' };
      for (const category of Object.keys(headings)) {
        // one heading a category, never repeated
        expect(
          pdf.pages.flatMap(linesOf).filter((line) => line === category),
          `${first} bangles: ${category}`
        ).toHaveLength(1);
      }
      pdf.pages.forEach((page, k) => {
        const lines = linesOf(page);
        for (const [category, prefix] of Object.entries(headings)) {
          const at = lines.indexOf(category);
          if (at < 0) continue;
          expect(
            lines.slice(at + 1).some((line) => compact(line).includes(prefix)),
            `${first} bangles, page ${k + 1}: ${category} has a design of its own after it`
          ).toBe(true);
        }
      });
    }
  });

  it('300 designs: every card drawn once and whole, over many pages', async () => {
    const categories = ['Bangles', 'Chains', 'Earrings', 'Rings'];
    const rows = categories.flatMap((category, c) =>
      designs(75, category.slice(0, 2).toUpperCase(), category).map((r, i) => ({
        ...r,
        // a photo for most; every tenth design has none, every seventh has one that did not arrive
        photoId: i % 10 === 0 ? null : `photo-${c}-${i}`,
      }))
    );
    const photos = new Map(
      rows
        .filter((r, i) => r.photoId !== null && i % 7 !== 0)
        .map((r, i) => [r.photoId as string, i % 2 === 0 ? JPEG_LIGHT : JPEG_DARK])
    );
    const pdf = await pdfOf(input({ groups: groupsOf(rows), photos }));
    expect(pdf.pageCount).toBeGreaterThan(10);
    // Every design number is on exactly one page, once; and on each page, as many cards end (`in stock`) as begin (the design number): no card is cut.
    for (const r of rows) {
      expect(pdf.pages.filter((page) => compact(page).includes(r.designNumber))).toHaveLength(1);
    }
    pdf.pages.forEach((page, k) => {
      const numbers = compact(page).match(/(BA|CH|EA|RI)-\d{4}/g) ?? [];
      expect(page.match(/in stock/g) ?? [], `page ${k + 1}`).toHaveLength(numbers.length);
      expect(linesOf(page).at(-1)).toBe(`Page ${k + 1} of ${pdf.pageCount}`);
    });
    expect(pdf.pages.join('\n').match(/No photo/g)?.length).toBe(rows.length - photos.size);
  }, 60_000);
});

// ================================================================================================ text a person typed

describe('PDF-5: text a person typed', () => {
  it('a long design number and a long name stay inside their card', async () => {
    const rings = [
      row('KAMARBANDHNAVRATNA2026-0001', { designName: 'W'.repeat(60) }),
      row('MANGALSUTRA-00012', { designName: `${'M'.repeat(30)} ${'Q'.repeat(30)}` }),
      row('RING-00003', { designName: 'Plain band' }),
    ];
    const bytes = await renderPdf(cataloguePdfDefinition(input({ groups: groupsOf(rings) })));
    // A4 with 23 pt margins: three cards with 4 mm between them.
    const left = 23;
    const gap = 11.34;
    const card = (595.28 - 2 * left - 2 * gap) / 3;
    const [page] = await readPlacedText(bytes);
    for (const item of page.filter((placed) => placed.y > 60 && placed.y < 700)) {
      const column = Math.floor((item.x - left) / (card + gap));
      const rightEdge = left + column * (card + gap) + card;
      expect(item.x + item.width, item.str).toBeLessThanOrEqual(rightEdge + 0.5);
    }
    // every letter is kept: the long number wraps after 16 letters (breakableCode), beside the other cards' numbers
    const text = compact((await readMadePdf(bytes)).pages[0]);
    expect(text).toContain('KAMARBANDHNAVRAT');
    expect(text).toContain('NA2026-0001');
    expect(text.match(/W/g)).toHaveLength(60);
    expect(text.match(/Q/g)).toHaveLength(30);
  });

  it('a Hindi name is set in the Devanagari font, from the content', async () => {
    const definition = cataloguePdfDefinition(
      input({ groups: groupsOf([row('RING-00001', { designName: 'कमल अंगूठी' })]) })
    );
    expect(usesDevanagari(definition)).toBe(true);
    const page = (await drawn(definition)).pages[0];
    expect(page.match(/[ऀ-ॿ]/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(usesDevanagari(cataloguePdfDefinition(input({ groups: groupsOf([row('R-1')]) })))).toBe(
      false
    );
  });
});
