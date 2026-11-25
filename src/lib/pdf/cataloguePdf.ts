// PDF-5: the stock catalogue as a PDF, the same as the print of its sheet (src/app/stock-catalogue/components/StockCatalogueClient.tsx, and its print rules in src/styles/tailwind.css under
// `.print-catalogue-*`): the shop's name and `Ready stock as of {date}`, one heading a category, three cards a row; a card is the photo (a square, cropped like `object-cover`), the design
// number, the name, the purity, `Gross {range}` and `{n} piece(s) in stock`. The rows are the screen's `catalogueRows` (src/lib/stockCatalogue.ts) and the words are written by the screen's
// own helpers (grossShown, dayShown): never a price, never the owner's original weight, never the customer's net weight.
// The photos come in as data URLs (src/lib/pdf/photoFetch.ts) and each is given once in `images`, under its id, so a photo on two cards is stored once; a design with no photo, or whose photo
// did not arrive, shows `No photo`. A row of cards is never cut (`unbreakable`), and a category's heading goes over to the next page with its first row, as the print's `break-after: avoid`.
// Pure: no window, document or navigator. Text the shop typed (its name, a category, a design's name and purity) goes through pdfText, and all of it stays in `content`, the only part the
// engine looks at for Hindi (src/lib/pdf/fonts.ts): the footer holds the page count and nothing else. pdfmake writes into the definition it draws, so a new one is built for each PDF.
import { dayShown, grossShown, type CatalogueRow } from '@/lib/stockCatalogue';
import { FONT_LATIN } from './fonts';
import { breakableCode, breakableText, pdfText } from './scripts';
import type { PdfContent, PdfDefinition } from './types';

export interface CataloguePdfInput {
  /** The shop's name as the screen shows it. */
  shopName: string;
  /** The business date, `YYYY-MM-DD`, or null when there is none. */
  businessDate: string | null;
  /** The categories as the screen shows them, each with its rows. */
  groups: Array<{ category: string; rows: CatalogueRow[] }>;
  /** The photos that arrived: photo id -> data URL. */
  photos: ReadonlyMap<string, string>;
}

// The paper of the print (pt): A4 with 8 mm margins, and room under the content for the page count; the same as the estimate's.
const PAGE_WIDTH = 595.28;
const MARGIN = 23;
const FOOTER_ROOM = 17;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

// The print's colours: every letter #111 but the date's (the site's muted brown), the site's border under the header, the card's grey border, and the muted fill of a card with no photo.
const INK = '#111111';
const MUTED_INK = '#6e5d50';
const BORDER = '#e6d8c4';
const CARD_LINE = '#cfcfcf';
const NO_PHOTO_FILL = '#efe5d7';

// The print's sizes (pt; a CSS pixel is 0.75 pt): the shop's name (text-xl), the date (text-sm), a category (text-base), the design number and name (text-sm), the rest of a card (text-xs).
const SIZE = { shop: 15, date: 10.5, category: 12, number: 10.5, name: 10.5, small: 9 };
// The print's spaces (pt): between the header and each category (space-y-5), under the header's text (pb-3), under a heading (mb-2), between cards across and down (4 mm), inside a card (p-3),
// above the design number (mt-2) and above the weight (mt-1).
const SECTION_GAP = 15;
const HEAD_PADDING = 9;
const HEADING_GAP = 6;
const CARD_GAP = 11.34;
const CARD_PADDING = 9;
const CARD_LINE_WIDTH = 0.75;
const NUMBER_GAP = 6;
const WEIGHT_GAP = 3;

const CARDS_A_ROW = 3;
/** The side of a card's photo: a third of the page, less the gaps between the cards and each card's lines and padding. */
const PHOTO_SIDE =
  (CONTENT_WIDTH - (CARDS_A_ROW - 1) * CARD_GAP) / CARDS_A_ROW -
  2 * (CARD_PADDING + CARD_LINE_WIDTH);
/** The height of a line of Noto Sans, per pt of its size (its ascender 1069 and descender 293, per 1000): for `No photo` in the middle of its square. */
const LINE_HEIGHT = 1.362;

/** A design's name may wrap after every 12 letters of a long word: a third of the page holds 12 of the widest bold letters (the default 24 would run into the next card). */
const nameBreaks = (run: string) => breakableText(run, 12);

function headerBlock({ shopName, businessDate }: CataloguePdfInput): PdfContent {
  return {
    unbreakable: true,
    stack: [
      ...(shopName ? [pdfText(shopName, { fontSize: SIZE.shop, bold: true })] : []),
      {
        text: businessDate ? `Ready stock as of ${dayShown(businessDate)}` : 'Ready stock',
        fontSize: SIZE.date,
        color: MUTED_INK,
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
        margin: [0, HEAD_PADDING, 0, 0],
      },
    ],
  };
}

/** The photo, a square cropped like `object-cover`; or the muted square with `No photo`. */
function photoBlock(row: CatalogueRow, photos: ReadonlyMap<string, string>): PdfContent {
  if (row.photoId !== null && photos.has(row.photoId)) {
    return { image: row.photoId, cover: { width: PHOTO_SIDE, height: PHOTO_SIDE } };
  }
  return {
    table: {
      widths: [PHOTO_SIDE],
      heights: [PHOTO_SIDE],
      body: [
        [
          {
            text: 'No photo',
            fontSize: SIZE.small,
            color: MUTED_INK,
            alignment: 'center',
            fillColor: NO_PHOTO_FILL,
            margin: [0, (PHOTO_SIDE - SIZE.small * LINE_HEIGHT) / 2, 0, 0],
          },
        ],
      ],
    },
    layout: {
      // no lines, no padding: the square is exactly the photo's
      defaultBorder: false,
      hLineWidth: () => 0,
      vLineWidth: () => 0,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

/** A card, as the screen's `Card`: the name only when there is one (and the purity: an empty line of the screen takes no room). */
function card(row: CatalogueRow, photos: ReadonlyMap<string, string>): PdfContent {
  return {
    border: [true, true, true, true],
    stack: [
      photoBlock(row, photos),
      pdfText(
        row.designNumber,
        { fontSize: SIZE.number, bold: true, margin: [0, NUMBER_GAP, 0, 0] },
        breakableCode
      ),
      ...(row.designName
        ? [pdfText(row.designName, { fontSize: SIZE.name, bold: true }, nameBreaks)]
        : []),
      ...(row.purity ? [pdfText(row.purity, { fontSize: SIZE.small })] : []),
      { text: `Gross ${grossShown(row)}`, fontSize: SIZE.small, margin: [0, WEIGHT_GAP, 0, 0] },
      {
        text: `${row.inStock} ${row.inStock === 1 ? 'piece' : 'pieces'} in stock`,
        fontSize: SIZE.small,
      },
    ],
  } as PdfContent;
}

/**
 * A row of up to three cards, never cut: one table row, cards and the gaps between them as its cells, so the cards of a row are as tall as each other (the screen's grid). An empty cell
 * pads a short row. `last`: the last row of its category, with no gap under it.
 */
function cardRow(
  rows: CatalogueRow[],
  photos: ReadonlyMap<string, string>,
  last: boolean
): PdfContent {
  const cells: PdfContent[] = [];
  const widths: number[] = [];
  for (let i = 0; i < CARDS_A_ROW; i++) {
    if (i > 0) {
      cells.push({ text: '' });
      widths.push(CARD_GAP);
    }
    cells.push(rows[i] ? card(rows[i], photos) : { text: '' });
    widths.push(PHOTO_SIDE);
  }
  const isCard = (column: number) => column % 2 === 0;
  return {
    unbreakable: true,
    margin: [0, 0, 0, last ? 0 : CARD_GAP],
    table: { dontBreakRows: true, widths, body: [cells] },
    layout: {
      // a card has its lines all round (its cell's `border`); the gaps and an empty cell have none
      defaultBorder: false,
      hLineWidth: () => CARD_LINE_WIDTH,
      vLineWidth: () => CARD_LINE_WIDTH,
      hLineColor: () => CARD_LINE,
      vLineColor: () => CARD_LINE,
      paddingLeft: (column: number) => (isCard(column) ? CARD_PADDING : 0),
      paddingRight: (column: number) => (isCard(column) ? CARD_PADDING : 0),
      paddingTop: () => CARD_PADDING,
      paddingBottom: () => CARD_PADDING,
    },
  };
}

/** A category: its heading kept on one page with its first row of cards (the print's `break-after: avoid`), then the other rows. */
function categoryBlocks(
  { category, rows }: CataloguePdfInput['groups'][number],
  photos: ReadonlyMap<string, string>
): PdfContent[] {
  const lines: CatalogueRow[][] = [];
  for (let i = 0; i < rows.length; i += CARDS_A_ROW) lines.push(rows.slice(i, i + CARDS_A_ROW));
  const [first, ...rest] = lines.map((cards, i) => cardRow(cards, photos, i === lines.length - 1));
  return [
    {
      unbreakable: true,
      margin: [0, SECTION_GAP, 0, 0],
      stack: [
        pdfText(category, {
          fontSize: SIZE.category,
          bold: true,
          margin: [0, 0, 0, HEADING_GAP],
        }),
        first,
      ],
    },
    ...rest,
  ];
}

/** The photos the cards show, each once, under its id. */
function imagesOf(input: CataloguePdfInput): Record<string, string> {
  const images: Record<string, string> = {};
  for (const { rows } of input.groups) {
    for (const { photoId } of rows) {
      const dataUrl = photoId === null ? undefined : input.photos.get(photoId);
      if (photoId !== null && dataUrl !== undefined) images[photoId] = dataUrl;
    }
  }
  return images;
}

/** The catalogue's PDF: the print of the sheet, page after page. */
export function cataloguePdfDefinition(input: CataloguePdfInput): PdfDefinition {
  // as the screen: a category with no design in stock is not drawn
  const groups = input.groups.filter((group) => group.rows.length > 0);
  return {
    pageSize: 'A4',
    pageMargins: [MARGIN, MARGIN, MARGIN, MARGIN + FOOTER_ROOM],
    info: { title: 'Stock Catalogue' },
    defaultStyle: { font: FONT_LATIN, fontSize: SIZE.small, color: INK },
    images: imagesOf(input),
    content: [
      headerBlock(input),
      ...(groups.length === 0
        ? [
            {
              text: 'No design with a piece in stock.',
              fontSize: SIZE.date,
              color: MUTED_INK,
              margin: [0, SECTION_GAP, 0, 0],
            } as PdfContent,
          ]
        : groups.flatMap((group) => categoryBlocks(group, input.photos))),
    ],
    footer: (currentPage, pageCount) => ({
      text: `Page ${currentPage} of ${pageCount}`,
      alignment: 'center',
      fontSize: 8,
      margin: [MARGIN, 6, MARGIN, 0],
    }),
  };
}
