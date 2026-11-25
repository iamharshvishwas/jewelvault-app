// PDF-1: the shapes the PDF files are made from: pdfmake's own types, under the names the rest of the site uses.
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

export type PdfDefinition = TDocumentDefinitions;
export type PdfContent = Content;

/** A PDF that has been made, and the name it is saved or shared under. */
export interface PdfFile {
  blob: Blob;
  fileName: string;
}
