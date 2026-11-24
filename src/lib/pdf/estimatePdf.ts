// PDF-3: the saved estimate as a PDF, the same as its print (src/app/estimate/components/EstimateViewClient.tsx, the print-estimate-* blocks, and their print rules in
// src/styles/tailwind.css): the shop, the party, the notices, the lines in one of the print's three tables, the totals, and `Page n of m` at the foot of each page. Every figure is written
// by the screen's formatters (src/lib/ledgerView.ts) from the same Invoice; nothing is worked out here but what the print works out (labour per gram, and its two roundings).
// Pure: no window, document or navigator. Text the shop or a person typed goes through pdfText, and all of it stays in `content`, the only part the engine looks at for Hindi
// (src/lib/pdf/fonts.ts): the footer holds the page count and nothing else.
import type { BillFacts } from '@/lib/appStore';
import { gramsShown, rupeesShown } from '@/lib/ledgerView';
import type { Invoice } from '@/lib/mockData';
import { FONT_LATIN } from './fonts';
import { breakableCode, pdfText } from './scripts';
import type { PdfContent, PdfDefinition } from './types';

export interface EstimatePdfInput {
  invoice: Invoice;
  facts: BillFacts | null;
  /** The Settings' shop, trimmed: a blank part is not drawn. */
  shop: { name: string; address: string; phone: string };
  /** The screen's date of the bill, displayDate(invoice.date): 24/11/2026. */
  dateText: string;
  /** The screen's date text of facts.cancelledOn, or null when there is none. */
  cancelledOnText: string | null;
}

export type EstimateVariant = 'silver-retail' | 'wholesale' | 'gold-retail';

export interface EstimateTotal {
  label: string;
  value: string;
  /** The Grand Total: larger, with a line above it. */
  strong?: true;
}

type Line = Invoice['items'][number];

/** Which of the print's tables the bill gets: silver retail (a retail sale, or none given, of silver lines only), the wholesale one (Semi-Wholesale, Wholesale), else gold retail. */
export function estimateVariant(invoice: Pick<Invoice, 'saleType' | 'items'>): EstimateVariant {
  if (
    (invoice.saleType ?? 'Retail') === 'Retail' &&
    invoice.items.length > 0 &&
    invoice.items.every((item) => item.material === 'Silver')
  ) {
    return 'silver-retail';
  }
  if (invoice.saleType === 'Semi-Wholesale' || invoice.saleType === 'Wholesale') return 'wholesale';
  return 'gold-retail';
}

/** The print's labour per gram: 0 for a line with no net weight. */
function labourPerGram(item: Line): number {
  if (item.customerNetWeight <= 0) return 0;
  return item.labour / item.customerNetWeight;
}

/** The print's table as words: its headings and, for each line, its cells. */
export function estimateTable(invoice: Invoice): { headings: string[]; rows: string[][] } {
  const variant = estimateVariant(invoice);
  // a Qty column only when some line is more than one piece (Per Piece); a bill of single pieces has none
  const showQuantity = invoice.items.some((item) => (item.quantity ?? 1) > 1);
  const qtyHeading = showQuantity ? ['Qty'] : [];
  const qty = (item: Line) => (showQuantity ? [String(item.quantity ?? 1)] : []);

  if (variant === 'silver-retail') {
    return {
      headings: ['Design', 'SKU', 'Purity', ...qtyHeading, 'Total'],
      rows: invoice.items.map((item) => [
        item.designNumber,
        item.skuNumber,
        item.purity,
        ...qty(item),
        rupeesShown(item.itemTotal),
      ]),
    };
  }
  const wholesale = variant === 'wholesale';
  return {
    headings: [
      'Design',
      'SKU',
      'GW',
      'Customer NW',
      'Purity',
      ...qtyHeading,
      'Rate',
      ...(wholesale ? ['Labour/g', 'Labour Total'] : ['Labour']),
      'Piroi',
      'Total',
    ],
    rows: invoice.items.map((item) => [
      item.designNumber,
      item.skuNumber,
      gramsShown(item.grossWeight),
      gramsShown(item.customerNetWeight),
      item.purity,
      ...qty(item),
      rupeesShown(item.metalRate),
      rupeesShown(Math.round(wholesale ? labourPerGram(item) : item.labour)),
      ...(wholesale ? [rupeesShown(Math.round(item.labour))] : []),
      rupeesShown(item.piroi),
      rupeesShown(item.itemTotal),
    ]),
  };
}

/** The print's totals block, in its order; Fine Due and Fine Pending only when fine is due. */
export function estimateTotals(invoice: Invoice): EstimateTotal[] {
  const fine: EstimateTotal[] =
    (invoice.fineWeightDue ?? 0) > 0
      ? [
          { label: 'Fine Due', value: gramsShown(invoice.fineWeightDue ?? 0) },
          { label: 'Fine Pending', value: gramsShown(invoice.fineWeightPending ?? 0) },
        ]
      : [];
  return [
    { label: 'Subtotal', value: rupeesShown(invoice.subtotal) },
    { label: 'Discount', value: rupeesShown(invoice.discount) },
    { label: 'Additional Charges', value: rupeesShown(invoice.additionalCharges) },
    { label: 'GST', value: rupeesShown(invoice.gst) },
    { label: 'Grand Total', value: rupeesShown(invoice.grandTotal), strong: true },
    ...fine,
    { label: 'Received', value: rupeesShown(invoice.amountReceived) },
    { label: 'Pending', value: rupeesShown(invoice.pendingAmount) },
  ];
}

// The paper of the print (pt): A4 with 8 mm margins, and room under the content for the page count.
const MARGIN = 23;
const FOOTER_ROOM = 17;
const CONTENT_WIDTH = 595.28 - 2 * MARGIN;
const TOTALS_WIDTH = 212.6; // 75 mm

// The print's colours: every letter #111, the site's border, the table's grey lines and header fill, and the notices' red and amber.
const INK = '#111111';
const BORDER = '#e6d8c4';
const HEAD_FILL = '#f3f3f3';
const HEAD_LINE = '#cfcfcf';
const ROW_LINE = '#eeeeee';
const CANCELLED = { fill: '#fef2f2', line: '#fecaca' };
const REISSUE = { fill: '#fffbeb', line: '#fde68a' };

// The print's sizes (pt): the shop's name, a customer's name, small text, a label, the table's headings and cells, the totals, the Grand Total.
const SIZE = {
  shop: 17,
  name: 12,
  small: 10.5,
  label: 9,
  heading: 7.5,
  cell: 8.5,
  total: 8.5,
  grand: 13.5,
};

// The typed columns may wrap (pdfText gives a long word places to); a figure never does. A design or SKU number wraps after a hyphen or every 8 letters (breakableCode), so that the
// widest table (Wholesale with Qty, 11 columns) stays inside the page even with a number like MANGALSUTRA-00012-001.
const TYPED_COLUMNS = new Set(['Design', 'SKU', 'Purity']);
const CODE_COLUMNS = new Set(['Design', 'SKU']);
// The ids that keep the last line and the totals together (see pageBreakBefore).
const LAST_LINE_ID = 'estimate-last-line-';
const TOTALS_ID = 'estimate-totals';
const NO_BREAK_SPACE = '\u00a0';

/** A small label (Estimate No., Customer, Status), in upper case like the print's CSS. */
function label(text: string): PdfContent {
  return { text: text.toUpperCase(), fontSize: SIZE.label };
}

function headerBlock({ invoice, shop, dateText }: EstimatePdfInput): PdfContent {
  const left: PdfContent[] = [];
  if (shop.name) left.push(pdfText(shop.name, { fontSize: SIZE.shop, bold: true }));
  // the address keeps its line breaks
  if (shop.address) left.push(pdfText(shop.address, { fontSize: SIZE.small }));
  if (shop.phone) left.push(pdfText(`Phone: ${shop.phone}`, { fontSize: SIZE.small }));
  left.push({
    text:
      invoice.openingBalance === true
        ? 'Opening balance: dues brought forward.'
        : 'Estimate only. GST not charged.',
    fontSize: SIZE.small,
  });
  return {
    unbreakable: true,
    stack: [
      {
        columnGap: 12,
        columns: [
          { width: '*', stack: left },
          {
            width: 'auto',
            alignment: 'right',
            stack: [
              label('Estimate No.'),
              pdfText(invoice.invoiceNumber, { fontSize: SIZE.name, bold: true }),
              { text: dateText, fontSize: SIZE.label, margin: [0, 6, 0, 0] },
            ],
          },
        ],
      },
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: CONTENT_WIDTH,
            y2: 0,
            lineWidth: 0.75,
            lineColor: BORDER,
          },
        ],
        margin: [0, 8.5, 0, 0],
      },
    ],
  };
}

function partyBlock({ invoice }: EstimatePdfInput): PdfContent {
  return {
    unbreakable: true,
    columnGap: 12,
    margin: [0, 8.5, 0, 8.5],
    columns: [
      {
        width: '*',
        stack: [
          label('Customer'),
          pdfText(invoice.customerName, { fontSize: SIZE.name, bold: true }),
          ...(invoice.customerMobile
            ? [pdfText(invoice.customerMobile, { fontSize: SIZE.small })]
            : []),
        ],
      },
      {
        width: '*',
        alignment: 'right',
        stack: [label('Status'), { text: invoice.status, fontSize: SIZE.name, bold: true }],
      },
    ],
  };
}

function noticeBox(lines: PdfContent[], colours: { fill: string; line: string }): PdfContent {
  return {
    unbreakable: true,
    margin: [0, 0, 0, 9],
    table: {
      widths: ['*'],
      body: [[{ stack: lines, fontSize: SIZE.label, fillColor: colours.fill }]],
    },
    layout: {
      hLineWidth: () => 0.75,
      vLineWidth: () => 0.75,
      hLineColor: () => colours.line,
      vLineColor: () => colours.line,
      paddingLeft: () => 9,
      paddingRight: () => 9,
      paddingTop: () => 6,
      paddingBottom: () => 6,
    },
  };
}

/** The print's notices: a cancelled bill says so (when, why, and the bill that replaced it); a live re-issue names the bill it replaces. A bill number is the server's, never typed. */
function notices({ invoice, facts, cancelledOnText }: EstimatePdfInput): PdfContent[] {
  if (invoice.status === 'Cancelled') {
    const lines: PdfContent[] = [
      { text: 'This estimate was cancelled. Nothing is owed on it.', bold: true },
    ];
    if (facts?.cancelledOn && cancelledOnText) {
      lines.push({ text: `Cancelled on ${cancelledOnText}.` });
    }
    if (facts?.cancelReason) lines.push(pdfText(`Reason: ${facts.cancelReason}`));
    if (facts?.reissuedAs) {
      lines.push({ text: ['Re-issued as ', { text: facts.reissuedAs.billNo, bold: true }, '.'] });
    }
    return [noticeBox(lines, CANCELLED)];
  }
  if (facts?.reissueOf) {
    return [
      noticeBox(
        [
          {
            text: [
              'This estimate replaces ',
              { text: facts.reissueOf.billNo, bold: true },
              ', which was cancelled.',
            ],
          },
        ],
        REISSUE
      ),
    ];
  }
  return [];
}

function linesTable(invoice: Invoice): PdfContent {
  const { headings, rows } = estimateTable(invoice);
  const last = rows.length - 1;
  return {
    table: {
      // the header row on every page, a line never cut
      headerRows: 1,
      dontBreakRows: true,
      // Design and SKU share what the figures leave, so the table is as wide as the page
      widths: headings.map((heading) => (heading === 'Design' || heading === 'SKU' ? '*' : 'auto')),
      body: [
        // in upper case, as the print's CSS draws them; estimateTable keeps the print's own words
        headings.map((heading) => ({
          text: heading.toUpperCase(),
          bold: true,
          fontSize: SIZE.heading,
          noWrap: true,
        })),
        ...rows.map((row, r) =>
          row.map((cell, c) =>
            // A blank cell is drawn as a no-break space: pdfmake can move a cell to the next page (pageBreakBefore) only when it has something on the page.
            pdfText(
              cell || NO_BREAK_SPACE,
              {
                fontSize: SIZE.cell,
                ...(TYPED_COLUMNS.has(headings[c]) ? {} : { noWrap: true }),
                ...(headings[c] === 'Total' ? { bold: true } : {}),
                ...(r === last ? { id: `${LAST_LINE_ID}${c}` } : {}),
              },
              CODE_COLUMNS.has(headings[c]) ? breakableCode : undefined
            )
          )
        ),
      ],
    },
    layout: {
      hLineWidth: () => 0.75,
      vLineWidth: () => 0,
      hLineColor: (i: number) => (i <= 1 ? HEAD_LINE : ROW_LINE),
      fillColor: (row: number) => (row === 0 ? HEAD_FILL : null),
      paddingLeft: () => 4.5,
      paddingRight: () => 4.5,
      paddingTop: () => 5.7,
      paddingBottom: () => 5.7,
    },
  };
}

function totalsBlock(invoice: Invoice): PdfContent {
  const rows = estimateTotals(invoice);
  const grand = rows.findIndex((row) => row.strong);
  return {
    unbreakable: true,
    // 4 mm under the lines, 75 mm wide on the right
    margin: [CONTENT_WIDTH - TOTALS_WIDTH, 11.3, 0, 0],
    table: {
      widths: ['*', 'auto'],
      body: rows.map((row, i) => {
        const fontSize = row.strong ? SIZE.grand : SIZE.total;
        return [
          // the block is never split, so its first label stands for it in pageBreakBefore
          { text: row.label, fontSize, ...(i === 0 ? { id: TOTALS_ID } : {}) },
          { text: row.value, fontSize, bold: true, alignment: 'right', noWrap: true },
        ];
      }),
    },
    layout: {
      // the line above the Grand Total
      hLineWidth: (i: number) => (i === grand ? 0.75 : 0),
      vLineWidth: () => 0,
      hLineColor: () => BORDER,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: (i: number) => (i === grand ? 6 : 3),
      paddingBottom: () => 3,
    },
  };
}

/** The estimate's PDF: the print of the saved estimate, page after page. */
export function estimatePdfDefinition(input: EstimatePdfInput): PdfDefinition {
  const { invoice } = input;
  return {
    pageSize: 'A4',
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN + FOOTER_ROOM],
    info: { title: invoice.invoiceNumber },
    defaultStyle: { font: FONT_LATIN, fontSize: SIZE.cell, color: INK },
    content: [
      headerBlock(input),
      partyBlock(input),
      ...notices(input),
      ...(invoice.items.length > 0 ? [linesTable(invoice)] : []),
      totalsBlock(invoice),
    ],
    // The print's `break-before: avoid` on the totals: when they do not fit under the last line, the last line goes over to their page with them. pdfmake moves a row cell by cell,
    // so each cell of the last line asks for itself.
    pageBreakBefore: (node, { getNodesOnNextPage }) =>
      node.id?.startsWith(LAST_LINE_ID) === true &&
      getNodesOnNextPage().some((next) => next.id === TOTALS_ID),
    footer: (currentPage, pageCount) => ({
      text: `Page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      margin: [MARGIN, 6, MARGIN, 0],
    }),
  };
}
