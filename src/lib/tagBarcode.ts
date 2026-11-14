import { BUSINESS_SHORT_NAME } from '@/lib/businessConfig';

// FB-B1 (Siddhi #9): what the tag prints as a barcode. A real Code 128 (drawn by JsBarcode in the tag page) next to the QR. FB-B final fix: the Code 128 carries the piece number, the QR the barcode.

/** How JsBarcode draws the tag's Code 128: bars only (the text is printed in HTML), no margin, one module wide; the svg is stretched to the tag with CSS. */
export const TAG_BARCODE_OPTIONS = {
  format: 'CODE128',
  displayValue: false,
  margin: 0,
  height: 28,
  width: 1,
} as const;

/** What the QR carries (and the words above the Code 128): the piece's barcode, or its piece number when it has none. */
export function tagBarcodeValue(sku: { barcode: string; skuNumber: string }): string {
  return sku.barcode || sku.skuNumber;
}

/**
 * What the Code 128 carries: the piece number (`RING-00001-001`), not the barcode string (`BC-RING-00001-001`). The barcode string is 222 modules, about 0.1 mm each in the 21.6 mm of a 58 mm
 * tag, narrower than the 0.125 mm dot of a 203 dpi thermal printer; the piece number is shorter (189 modules) and so has wider bars. `findSkuByCode` finds a piece by its number as well as by
 * its barcode (the scan screen and the billing screen both use it), so a scan of this Code 128 finds the same piece.
 */
export function tagCode128Value(sku: { barcode: string; skuNumber: string }): string {
  return sku.skuNumber;
}

/** The shop's name on the tag: the Settings' short name, or the configured one when that is blank. */
export function tagShortName(business: { displayName?: string } | undefined): string {
  return business?.displayName?.trim() || BUSINESS_SHORT_NAME;
}

// ------------------------------------------------------------------------------------------------ the barcode end of the tag, at any size

/**
 * What the barcode end of the tag is made of, in mm, as the tag page lays it out (measured in a browser): the room lost to the tag's padding and borders, a line of text (the barcode in
 * words; the piece number under the QR is another), the space round the Code 128, the QR, and how short a Code 128 may be (a scanner or a phone camera still reads it at 4 mm; with a QR
 * beside it the Code 128 is kept at 6 mm or more, else the QR goes). The sums are a little above what the browser measures, so a stack that fits here fits there.
 */
export const TAG_ROOM_MM = {
  chrome: 5.2,
  text: 1.9,
  margin: 1.2,
  qr: 8.5,
  minBarcode: 4,
  minBarcodeWithQr: 6,
} as const;

/** The least height of a tag: the tag page raises anything lower to it. */
export const TAG_MIN_HEIGHT_MM = 13;
/** The least height of the Code 128 the Settings can ask for (the tag has always drawn at least this). */
const TAG_BARCODE_LEAST_MM = 8;

export interface TagBarcodeLayout {
  /** The height of the Code 128. */
  barcodeMm: number;
  showQr: boolean;
  /** The piece number printed under the QR (it is also on the other half of the tag). */
  showNumber: boolean;
}

/**
 * The barcode end of the tag for a tag `heightMm` high and a barcode `barcodeHeightMm` high (both from the Settings, which accept any number): the Code 128 is always there and never shorter
 * than 4 mm; the QR and the second printing of the piece number are kept only where they fit; a barcode taller than the room is cut to it. A 28 mm tag with an 8 mm barcode (the default)
 * has all of it, as it always had.
 */
export function tagBarcodeLayout(heightMm: number, barcodeHeightMm: number): TagBarcodeLayout {
  const height = Math.max(Number.isFinite(heightMm) ? heightMm : 0, TAG_MIN_HEIGHT_MM);
  const asked = Math.max(
    Number.isFinite(barcodeHeightMm) ? barcodeHeightMm : 0,
    TAG_BARCODE_LEAST_MM
  );
  const room = height - TAG_ROOM_MM.chrome;
  const cut = (mm: number) => Math.floor(Math.min(asked, mm) * 100) / 100;

  const withQr = room - (2 * TAG_ROOM_MM.text + TAG_ROOM_MM.margin + TAG_ROOM_MM.qr);
  if (withQr >= TAG_ROOM_MM.minBarcodeWithQr) {
    return { barcodeMm: cut(withQr), showQr: true, showNumber: true };
  }
  const withNumber = room - (2 * TAG_ROOM_MM.text + TAG_ROOM_MM.margin);
  if (withNumber >= TAG_ROOM_MM.minBarcode) {
    return { barcodeMm: cut(withNumber), showQr: false, showNumber: true };
  }
  return {
    barcodeMm: cut(room - (TAG_ROOM_MM.text + TAG_ROOM_MM.margin)),
    showQr: false,
    showNumber: false,
  };
}
