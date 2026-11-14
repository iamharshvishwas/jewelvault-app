import { BUSINESS_SHORT_NAME } from '@/lib/businessConfig';

// FB-B1 (Siddhi #9): what the tag prints as a barcode. A real Code 128 (drawn by JsBarcode in the tag page), of the piece barcode, next to the QR.

/** How JsBarcode draws the tag's Code 128: bars only (the text is printed in HTML), no margin, one module wide; the svg is stretched to the tag with CSS. */
export const TAG_BARCODE_OPTIONS = {
  format: 'CODE128',
  displayValue: false,
  margin: 0,
  height: 28,
  width: 1,
} as const;

/** What the barcode says: the piece's barcode, or its piece number when it has none (the same text the QR carries). */
export function tagBarcodeValue(sku: { barcode: string; skuNumber: string }): string {
  return sku.barcode || sku.skuNumber;
}

/** The shop's name on the tag: the Settings' short name, or the configured one when that is blank. */
export function tagShortName(business: { displayName?: string } | undefined): string {
  return business?.displayName?.trim() || BUSINESS_SHORT_NAME;
}
