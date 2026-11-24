// PDF-2: hands a made PDF to the person: saved as a file (Download PDF) or sent through the phone's share menu (Share). This is the browser glue: the document and the navigator are
// parameters, with the real ones as the default, so a test passes fakes.
import type { PdfFile } from './types';

/** How long the blob address lives after a download: long enough for any browser to start saving the file. */
const REVOKE_AFTER_MS = 60_000;

/** Saves the PDF: a link with `download` on a blob address, clicked, the address freed 60 s later. */
export function downloadPdf(file: PdfFile, doc: Document = document): void {
  const url = URL.createObjectURL(file.blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = file.fileName;
  // Some browsers click only a link that is in the page.
  doc.body?.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** A PDF as a `File`, which is what a share takes. */
const pdfFile = (parts: BlobPart[], name: string) =>
  new File(parts, name, { type: 'application/pdf' });

/**
 * True only when this browser can share a PDF file. False when `share` or `canShare` is missing, `canShare` says no, or it throws; so also false where there is no navigator. It asks
 * about an empty PDF: `canShare` looks at the type and the name, not at the bytes.
 */
export function canSharePdf(nav?: Navigator): boolean {
  const target = nav ?? (typeof navigator === 'undefined' ? undefined : navigator);
  if (!target) return false;
  try {
    if (typeof target.share !== 'function' || typeof target.canShare !== 'function') return false;
    return target.canShare({ files: [pdfFile([], 'share.pdf')] }) === true;
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'blocked';

/** The `name` of whatever was thrown: a DOMException from the browser is `AbortError` or `NotAllowedError`. */
function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : '';
}

/**
 * Opens the share menu with the PDF. `cancelled`: the person closed the menu (`AbortError`), not a failure. `blocked`: the browser refused the tap (`NotAllowedError`, which a slow
 * make causes: the tap that started it is too old), so the person must tap once more. Any other error is thrown.
 */
export async function sharePdf(
  file: PdfFile,
  title: string,
  nav: Navigator = navigator
): Promise<ShareOutcome> {
  try {
    await nav.share({ files: [pdfFile([file.blob], file.fileName)], title });
    return 'shared';
  } catch (error) {
    const name = errorName(error);
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError') return 'blocked';
    throw error;
  }
}
