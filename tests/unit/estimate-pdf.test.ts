// PDF-3: the saved estimate as a PDF (src/lib/pdf/estimatePdf.ts), the same as its print (the print-estimate-* blocks of src/app/estimate/components/EstimateViewClient.tsx):
//   - the print's three tables: gold retail (Labour), Semi-Wholesale and Wholesale (Labour/g and Labour Total), silver retail (Design, SKU, Purity, Total); Qty only when a line has more
//     than one piece; labour rounded as the print rounds it; every figure written by rupeesShown / gramsShown
//   - the totals in the print's order, Fine Due and Fine Pending only when fine is due; the cancelled and re-issue notices; an opening balance with no table
//   - 80 lines over several pages: the header row on every page with lines, the totals on the last page only, `Page k of n` at the foot of each page; the totals never alone on a page
//   - text a person typed: a 90-letter name with no space and an emoji, a Hindi name (kept in the content, where the engine looks for it), a blank name; a blank address or phone is not drawn
//   - the widest table (Wholesale with Qty) stays inside the right margin with long design and SKU numbers; the headings and the small labels are drawn in upper case, like the print
//
// The definition is drawn by pdfmake's Node build (tests/unit/support/pdf-node.ts) and read back by pdf.js (tests/unit/support/pdf-read.ts). A definition is drawn once: pdfmake writes into it.
//
// Run: npm test -- tests/unit/estimate-pdf.test.ts
import { describe, expect, it } from 'vitest';
import type { BillFacts } from '@/lib/appStore';
import { gramsShown, rupeesShown } from '@/lib/ledgerView';
import type { Invoice, InvoiceItem } from '@/lib/mockData';
import {
  estimatePdfDefinition,
  estimateTable,
  estimateTotals,
  estimateVariant,
  type EstimatePdfInput,
} from '@/lib/pdf/estimatePdf';
import { usesDevanagari } from '@/lib/pdf/fonts';
import type { PdfDefinition } from '@/lib/pdf/types';
import { renderPdf } from './support/pdf-node';
import { compact, readMadePdf, readPlacedText, type MadePdf } from './support/pdf-read';

const GOLD_HEADINGS = [
  'Design',
  'SKU',
  'GW',
  'Customer NW',
  'Purity',
  'Rate',
  'Labour',
  'Piroi',
  'Total',
];

/** A line of a bill: a 22K gold ring sold by weight unless the test says otherwise. */
function line(designNumber: string, fields: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: `line-${designNumber}`,
    designNumber,
    skuNumber: `${designNumber}-001`,
    material: 'Gold',
    purity: '22K',
    grossWeight: 5.5,
    customerNetWeight: 5,
    metalRate: 7250,
    labour: 600,
    piroi: 50,
    otherCharges: 0,
    metalAmount: 36250,
    itemTotal: 36900,
    sellingMethod: 'By Weight',
    imageRef: '',
    category: 'Ring',
    taxRate: 0,
    taxAmount: 0,
    ...fields,
  };
}

/** The mockup's bill: three gold lines, ₹1,43,490 less ₹490 discount, ₹1,00,000 received. */
function mockInvoice(fields: Partial<Invoice> = {}): Invoice {
  return {
    id: 'bill-42',
    invoiceNumber: 'EST-2026-0042',
    customerId: 'customer-1',
    customerName: 'Anita Sharma',
    customerMobile: '98290 12345',
    items: [
      line('RING-00042'),
      line('CHAIN-00117', {
        grossWeight: 12.25,
        customerNetWeight: 12,
        labour: 1440,
        piroi: 0,
        metalAmount: 87000,
        itemTotal: 88440,
      }),
      line('EAR-00203', {
        purity: '18K',
        grossWeight: 3.1,
        customerNetWeight: 3,
        metalRate: 5900,
        labour: 450,
        piroi: 0,
        metalAmount: 17700,
        itemTotal: 18150,
      }),
    ],
    payments: [],
    subtotal: 143490,
    discount: 490,
    discountPercent: 0,
    additionalCharges: 0,
    gst: 0,
    gstPercent: 0,
    roundOff: 0,
    grandTotal: 143000,
    amountReceived: 100000,
    pendingAmount: 43000,
    status: 'Partial',
    saleType: 'Retail',
    date: '2026-11-24T06:30:00.000Z',
    createdBy: 'owner',
    notes: '',
    ...fields,
  };
}

function input(invoice: Invoice, fields: Partial<EstimatePdfInput> = {}): EstimatePdfInput {
  return {
    invoice,
    facts: null,
    shop: {
      name: 'Shree Ganesh Jewellers',
      address: '12 MG Road\r\nJohari Bazar, Jaipur',
      phone: '98290 00000',
    },
    dateText: '24/11/2026',
    cancelledOnText: null,
    ...fields,
  };
}

async function drawn(definition: PdfDefinition): Promise<MadePdf> {
  return readMadePdf(await renderPdf(definition));
}

const pdfOf = (pdfInput: EstimatePdfInput) => drawn(estimatePdfDefinition(pdfInput));

const linesOf = (page: string) => page.split('\n');

/** The header row as the PDF draws it: upper case, as the print's CSS does (estimateTable keeps the print's own words). */
const headerRowOf = (headings: string[]) => compact(headings.join(' ').toUpperCase());

/** `n` lines with design numbers D-001, D-002, ... */
function manyLines(n: number): InvoiceItem[] {
  return Array.from({ length: n }, (_, i) => line(`D-${String(i + 1).padStart(3, '0')}`));
}

function facts(fields: Partial<BillFacts>): BillFacts {
  return {
    id: 'bill-42',
    billNo: 'EST-2026-0042',
    customerId: 'customer-1',
    status: 'active',
    docType: 'estimate',
    cancelReason: null,
    cancelledOn: null,
    reissueOf: null,
    reissuedAs: null,
    ...fields,
  };
}

describe('PDF-3: the tables of the print', () => {
  it("gold retail: the print's headings and cells", async () => {
    const invoice = mockInvoice();
    expect(estimateVariant(invoice)).toBe('gold-retail');
    const table = estimateTable(invoice);
    expect(table.headings).toEqual(GOLD_HEADINGS);
    expect(table.rows).toEqual([
      [
        'RING-00042',
        'RING-00042-001',
        '5.500 g',
        '5.000 g',
        '22K',
        '₹7,250',
        '₹600',
        '₹50',
        '₹36,900',
      ],
      [
        'CHAIN-00117',
        'CHAIN-00117-001',
        '12.250 g',
        '12.000 g',
        '22K',
        '₹7,250',
        '₹1,440',
        '₹0',
        '₹88,440',
      ],
      [
        'EAR-00203',
        'EAR-00203-001',
        '3.100 g',
        '3.000 g',
        '18K',
        '₹5,900',
        '₹450',
        '₹0',
        '₹18,150',
      ],
    ]);

    const pdf = await pdfOf(input(invoice));
    expect(pdf.pageCount).toBe(1);
    const page = compact(pdf.pages[0]);
    // The header row (in upper case, like the print) and each line read as one line of the page, cell after cell, as in the print.
    expect(page).toContain(headerRowOf(table.headings));
    expect(pdf.pages[0]).not.toContain('Customer NW');
    for (const row of table.rows) expect(page).toContain(compact(row.join(' ')));
    for (const cell of ['₹36,900', '12.000 g', '₹1,43,000']) expect(page).toContain(compact(cell));
    // The header and the party.
    for (const text of [
      'Shree Ganesh Jewellers',
      '12 MG Road',
      'Johari Bazar, Jaipur',
      'Phone: 98290 00000',
      'Estimate only. GST not charged.',
      'ESTIMATE NO.',
      'EST-2026-0042',
      '24/11/2026',
      'CUSTOMER',
      'Anita Sharma',
      '98290 12345',
      'STATUS',
      'Partial',
    ]) {
      expect(page).toContain(compact(text));
    }
    // The address keeps its line break (a Windows one here): two lines, no `?`.
    expect(page).toContain('12MGRoad');
    expect(page).not.toContain('Road?');
    expect(linesOf(pdf.pages[0]).at(-1)).toBe('Page 1 of 1');
  });

  it('gold retail: Labour is the rounded labour of the line', () => {
    const invoice = mockInvoice({ items: [line('RING-00042', { labour: 600.5 })] });
    expect(estimateTable(invoice).rows[0][GOLD_HEADINGS.indexOf('Labour')]).toBe(
      rupeesShown(Math.round(600.5))
    );
  });

  it('wholesale: Labour/g and Labour Total', async () => {
    const invoice = mockInvoice({ saleType: 'Wholesale' });
    expect(estimateVariant(invoice)).toBe('wholesale');
    expect(estimateVariant(mockInvoice({ saleType: 'Semi-Wholesale' }))).toBe('wholesale');
    const table = estimateTable(invoice);
    expect(table.headings).toEqual([
      'Design',
      'SKU',
      'GW',
      'Customer NW',
      'Purity',
      'Rate',
      'Labour/g',
      'Labour Total',
      'Piroi',
      'Total',
    ]);
    const chain = table.rows[1];
    expect(chain[table.headings.indexOf('Labour/g')]).toBe(rupeesShown(Math.round(1440 / 12)));
    expect(chain[table.headings.indexOf('Labour Total')]).toBe(rupeesShown(1440));

    const pdf = await pdfOf(input(invoice));
    const page = compact(pdf.pages[0]);
    expect(page).toContain(headerRowOf(table.headings));
    for (const row of table.rows) expect(page).toContain(compact(row.join(' ')));
  });

  it('wholesale: Labour/g is rounded, and 0 for a line with no net weight', () => {
    const invoice = mockInvoice({
      saleType: 'Wholesale',
      items: [
        line('A-1', { labour: 1000, customerNetWeight: 3 }),
        line('A-2', { labour: 1000.4, customerNetWeight: 0 }),
      ],
    });
    const { headings, rows } = estimateTable(invoice);
    expect(rows.map((row) => row[headings.indexOf('Labour/g')])).toEqual(['₹333', '₹0']);
    expect(rows.map((row) => row[headings.indexOf('Labour Total')])).toEqual(['₹1,000', '₹1,000']);
  });

  it('silver retail: Design, SKU, Purity, Total', async () => {
    const silver = (designNumber: string) =>
      line(designNumber, { material: 'Silver', purity: '925', itemTotal: 2450 });
    const invoice = mockInvoice({ items: [silver('ANK-00011'), silver('TOE-00004')] });
    expect(estimateVariant(invoice)).toBe('silver-retail');
    // No sale type is retail; a gold line among the silver, or a wholesale sale, is not silver retail.
    expect(estimateVariant({ ...invoice, saleType: undefined })).toBe('silver-retail');
    expect(estimateVariant({ ...invoice, items: [...invoice.items, line('RING-1')] })).toBe(
      'gold-retail'
    );
    expect(estimateVariant({ ...invoice, saleType: 'Wholesale' })).toBe('wholesale');
    expect(estimateVariant({ ...invoice, items: [] })).toBe('gold-retail');

    const table = estimateTable(invoice);
    expect(table.headings).toEqual(['Design', 'SKU', 'Purity', 'Total']);
    expect(table.rows).toEqual([
      ['ANK-00011', 'ANK-00011-001', '925', '₹2,450'],
      ['TOE-00004', 'TOE-00004-001', '925', '₹2,450'],
    ]);

    const pdf = await pdfOf(input(invoice));
    const page = compact(pdf.pages[0]);
    expect(page).toContain(headerRowOf(table.headings));
    for (const row of table.rows) expect(page).toContain(compact(row.join(' ')));
    expect(page).not.toContain('CUSTOMERNW');
  });

  it('Qty only when a line has more than one piece', async () => {
    const invoice = mockInvoice();
    expect(estimateTable(invoice).headings).not.toContain('Qty');

    const pieces = mockInvoice({
      items: [
        ...invoice.items,
        line('TOP-00009', { sellingMethod: 'Per Piece', quantity: 3, itemTotal: 6000 }),
      ],
    });
    const table = estimateTable(pieces);
    expect(table.headings).toEqual([
      'Design',
      'SKU',
      'GW',
      'Customer NW',
      'Purity',
      'Qty',
      'Rate',
      'Labour',
      'Piroi',
      'Total',
    ]);
    const qty = table.headings.indexOf('Qty');
    expect(table.rows.map((row) => row[qty])).toEqual(['1', '1', '1', '3']);
    // In the other two tables too, after Purity.
    expect(estimateTable({ ...pieces, saleType: 'Wholesale' }).headings.indexOf('Qty')).toBe(5);
    const silverPieces = mockInvoice({
      items: [line('ANK-00011', { material: 'Silver', purity: '925', quantity: 2 })],
    });
    expect(estimateTable(silverPieces).headings).toEqual([
      'Design',
      'SKU',
      'Purity',
      'Qty',
      'Total',
    ]);

    const pdf = await pdfOf(input(pieces));
    const page = compact(pdf.pages[0]);
    expect(page).toContain(headerRowOf(table.headings));
    for (const row of table.rows) expect(page).toContain(compact(row.join(' ')));
  });
});

describe('PDF-3: the totals and the notices', () => {
  it('the totals in the order of the print', () => {
    expect(estimateTotals(mockInvoice())).toEqual([
      { label: 'Subtotal', value: '₹1,43,490' },
      { label: 'Discount', value: '₹490' },
      { label: 'Additional Charges', value: '₹0' },
      { label: 'GST', value: '₹0' },
      { label: 'Grand Total', value: '₹1,43,000', strong: true },
      { label: 'Received', value: '₹1,00,000' },
      { label: 'Pending', value: '₹43,000' },
    ]);
  });

  it('Fine Due and Fine Pending only when fine is due', async () => {
    const fine = mockInvoice({ fineWeightDue: 2.5, fineWeightPending: 1 });
    const totals = estimateTotals(fine);
    expect(totals.map((row) => row.label)).toEqual([
      'Subtotal',
      'Discount',
      'Additional Charges',
      'GST',
      'Grand Total',
      'Fine Due',
      'Fine Pending',
      'Received',
      'Pending',
    ]);
    expect(totals[5]).toEqual({ label: 'Fine Due', value: gramsShown(2.5) });
    expect(totals[6]).toEqual({ label: 'Fine Pending', value: gramsShown(1) });

    const page = compact((await pdfOf(input(fine))).pages[0]);
    for (const row of totals) expect(page).toContain(compact(`${row.label} ${row.value}`));

    const none = mockInvoice({ fineWeightDue: 0, fineWeightPending: 0 });
    expect(estimateTotals(none).map((row) => row.label)).not.toContain('Fine Due');
    const nonePage = (await pdfOf(input(none))).pages[0];
    expect(nonePage).not.toContain('Fine');
  });

  it('cancelled and re-issued', async () => {
    const cancelled = await pdfOf(
      input(mockInvoice({ status: 'Cancelled' }), {
        facts: facts({
          status: 'cancelled',
          cancelReason: 'Wrong weight on the chain',
          cancelledOn: '2026-11-20',
          reissuedAs: { id: 'bill-43', billNo: 'EST-2026-0043' },
        }),
        cancelledOnText: '20/11/2026',
      })
    );
    const lines = linesOf(cancelled.pages[0]);
    expect(lines).toContain('This estimate was cancelled. Nothing is owed on it.');
    expect(lines).toContain('Cancelled on 20/11/2026.');
    expect(lines).toContain('Reason: Wrong weight on the chain');
    expect(lines).toContain('Re-issued as EST-2026-0043.');
    expect(cancelled.pages[0]).not.toContain('This estimate replaces');

    // With no facts (a preview build, or the row not yet arrived) the first sentence only.
    const bare = linesOf((await pdfOf(input(mockInvoice({ status: 'Cancelled' })))).pages[0]);
    expect(bare).toContain('This estimate was cancelled. Nothing is owed on it.');
    expect(bare.join('\n')).not.toMatch(/Cancelled on|Reason:|Re-issued as/);

    // The bill that replaced it says so; a live bill is never called cancelled.
    const reissue = await pdfOf(
      input(mockInvoice({ invoiceNumber: 'EST-2026-0043' }), {
        facts: facts({ reissueOf: { id: 'bill-41', billNo: 'EST-2026-0041' } }),
      })
    );
    expect(linesOf(reissue.pages[0])).toContain(
      'This estimate replaces EST-2026-0041, which was cancelled.'
    );
    expect(reissue.pages[0]).not.toContain('This estimate was cancelled');

    // A cancelled bill that was itself a re-issue shows the cancelled notice only, as the print does.
    const both = await pdfOf(
      input(mockInvoice({ status: 'Cancelled' }), {
        facts: facts({
          status: 'cancelled',
          reissueOf: { id: 'bill-41', billNo: 'EST-2026-0041' },
        }),
      })
    );
    expect(both.pages[0]).not.toContain('This estimate replaces');
  });

  it('opening balance: no table', async () => {
    const opening = mockInvoice({
      openingBalance: true,
      items: [],
      subtotal: 25000,
      discount: 0,
      grandTotal: 25000,
      amountReceived: 0,
      pendingAmount: 25000,
      status: 'Pending',
    });
    expect(estimateTable(opening).rows).toEqual([]);
    const pdf = await pdfOf(input(opening));
    expect(pdf.pageCount).toBe(1);
    const page = compact(pdf.pages[0]);
    expect(page).toContain(compact('Opening balance: dues brought forward.'));
    expect(page).not.toContain('Estimateonly');
    expect(page).not.toContain('DESIGN');
    expect(page).toContain(compact('Grand Total ₹25,000'));
    expect(page).toContain(compact('Pending ₹25,000'));
  });
});

describe('PDF-3: pages', () => {
  it('80 lines run over pages', async () => {
    const invoice = mockInvoice({ items: manyLines(80) });
    const headerRow = headerRowOf(estimateTable(invoice).headings);
    const pdf = await pdfOf(input(invoice));
    expect(pdf.pageCount).toBeGreaterThanOrEqual(2);
    pdf.pages.forEach((page, k) => {
      const last = k === pdf.pageCount - 1;
      if (/D-\d{3}/.test(page)) expect(compact(page)).toContain(headerRow);
      expect(compact(page).includes('GrandTotal')).toBe(last);
      expect(/\bPending\b/.test(page)).toBe(last);
      expect(linesOf(page).at(-1)).toBe(`Page ${k + 1} of ${pdf.pageCount}`);
    });
    // Every line is drawn once, whole (a row is never split over two pages).
    const rows = estimateTable(invoice).rows.map((row) => compact(row.join(' ')));
    for (const row of rows) {
      expect(pdf.pages.filter((page) => compact(page).includes(row))).toHaveLength(1);
    }
  });

  it('the totals are never alone on a page: the last line goes over with them', async () => {
    // The fewest lines for which the totals, drawn without the rule, fall alone onto the next page.
    let lines = 0;
    for (let n = 10; n <= 45 && lines === 0; n++) {
      const withoutRule = await drawn({
        ...estimatePdfDefinition(input(mockInvoice({ items: manyLines(n) }))),
        pageBreakBefore: undefined,
      });
      if (withoutRule.pageCount > 1 && !/D-\d{3}/.test(withoutRule.pages.at(-1) ?? '')) lines = n;
    }
    expect(lines).toBeGreaterThan(0);

    const invoice = mockInvoice({ items: manyLines(lines) });
    const rows = estimateTable(invoice).rows.map((row) => compact(row.join(' ')));
    const pdf = await pdfOf(input(invoice));
    expect(pdf.pageCount).toBe(2);
    const [first, second] = pdf.pages.map(compact);
    expect(second).toContain(headerRowOf(estimateTable(invoice).headings));
    expect(second).toContain(rows[lines - 1]);
    expect(second).toContain('GrandTotal');
    expect(first).toContain(rows[lines - 2]);
    expect(first).not.toContain(rows[lines - 1]);
  });

  it('A4, the estimate number as the title, the header row repeated, rows and totals kept whole, the page count in the footer only', () => {
    const definition = estimatePdfDefinition(input(mockInvoice()));
    expect(definition.pageSize).toBe('A4');
    expect(definition.info?.title).toBe('EST-2026-0042');
    expect(definition.header).toBeUndefined();
    const content = JSON.stringify(definition.content);
    expect(content).toContain('"headerRows":1');
    expect(content).toContain('"dontBreakRows":true');
    expect(content).toContain('"unbreakable":true');
    const footer = definition.footer as (page: number, pages: number, size: unknown) => unknown;
    expect(JSON.stringify(footer(2, 3, { width: 595.28, height: 841.89 }))).toContain(
      '"Page 2 of 3"'
    );
  });
});

describe('PDF-3: text a person typed', () => {
  it('the widest table stays inside the page: long design and SKU numbers wrap', async () => {
    // Wholesale with Qty (11 columns), large figures, and numbers Unicode will not break: a hyphen stays with the digit after it.
    const big = {
      quantity: 3,
      grossWeight: 123.456,
      customerNetWeight: 120.5,
      labour: 12345.67,
      piroi: 1500,
      itemTotal: 1234567.5,
    };
    const invoice = mockInvoice({
      saleType: 'Wholesale',
      items: [
        line('MANGALSUTRA-00012', { ...big, skuNumber: 'MANGALSUTRA-00012-001' }),
        line('KAMARBANDHNAVRATNA2026', { ...big, skuNumber: 'KAMARBANDHNAVRATNA2026-0001' }),
        line('RING-00042'),
      ],
    });
    const table = estimateTable(invoice);
    expect(table.headings).toHaveLength(11);
    const bytes = await renderPdf(estimatePdfDefinition(input(invoice)));
    const rightMargin = 595.28 - 23;
    const pages = await readPlacedText(bytes);
    expect(pages).toHaveLength(1);
    for (const item of pages[0]) {
      expect(item.x + item.width, item.str).toBeLessThanOrEqual(rightMargin + 0.5);
    }
    // Every figure of every line is drawn whole (the Total column is not cut off).
    const page = compact((await readMadePdf(bytes)).pages[0]);
    for (const row of table.rows) {
      for (const cell of row.slice(2)) expect(page).toContain(compact(cell));
    }
  });

  it('a 90-letter name with no space and an emoji', async () => {
    const pdf = await pdfOf(input(mockInvoice({ customerName: `${'Q'.repeat(90)}😀` })));
    expect(pdf.pageCount).toBe(1);
    const page = pdf.pages[0];
    // Wrapped at the places pdfText gives it, every letter kept; the emoji, which no font has, written `?`.
    expect(page.match(/Q/g)).toHaveLength(90);
    expect(compact(page)).toContain(`${'Q'.repeat(18)}?`);
    expect(page).not.toContain('😀');
  });

  it('a Hindi name is drawn in the Devanagari font, from the content', async () => {
    const definition = estimatePdfDefinition(input(mockInvoice({ customerName: 'अनीता शर्मा' })));
    expect(usesDevanagari(definition)).toBe(true);
    const page = (await drawn(definition)).pages[0];
    expect(page.match(/[ऀ-ॿ]/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // An English bill needs no Hindi font.
    expect(usesDevanagari(estimatePdfDefinition(input(mockInvoice())))).toBe(false);
  });

  it('a blank customer name and mobile', async () => {
    const named = linesOf((await pdfOf(input(mockInvoice()))).pages[0]);
    expect(named[named.indexOf('CUSTOMER STATUS') + 1]).toBe('Anita Sharma Partial');

    const pdf = await pdfOf(input(mockInvoice({ customerName: '', customerMobile: '' })));
    expect(pdf.pageCount).toBe(1);
    // The labels stay; beside the status there is nothing, and no mobile under it.
    const lines = linesOf(pdf.pages[0]);
    expect(lines[lines.indexOf('CUSTOMER STATUS') + 1]).toBe('Partial');
    expect(pdf.pages[0]).not.toContain('98290 12345');
    expect(compact(pdf.pages[0])).toContain(compact('Grand Total ₹1,43,000'));
  });

  it('blank address and phone are not drawn', async () => {
    /** The lines between the shop's name and the estimate's note, less the estimate number and date beside them (they may share a line). */
    const underTheName = (page: string) => {
      const lines = linesOf(page);
      const name = lines.findIndex((text) => text.includes('Shree Ganesh Jewellers'));
      const note = lines.findIndex((text) => text.includes('Estimate only. GST not charged.'));
      expect(name).toBeGreaterThanOrEqual(0);
      expect(note).toBeGreaterThan(name);
      return lines
        .slice(name + 1, note)
        .map((text) =>
          ['ESTIMATE NO.', 'EST-2026-0042', '24/11/2026']
            .reduce((rest, beside) => rest.replace(beside, ''), text)
            .trim()
        )
        .filter((text) => text !== '');
    };
    const full = await pdfOf(input(mockInvoice()));
    expect(underTheName(full.pages[0])).toEqual([
      '12 MG Road',
      'Johari Bazar, Jaipur',
      'Phone: 98290 00000',
    ]);

    const blank = await pdfOf(
      input(mockInvoice(), { shop: { name: 'Shree Ganesh Jewellers', address: '', phone: '' } })
    );
    expect(blank.pages[0]).not.toContain('Phone:');
    expect(underTheName(blank.pages[0])).toEqual([]);
  });
});
