// PDF-2: the names a PDF is saved and shared under. Pure text: no window, document or navigator.
const MAX_BASE_LENGTH = 120;
// The letters Windows, macOS and the share sheets refuse in a file name, and the control characters (the C0 and C1 blocks, and DEL).
const FORBIDDEN = /[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g;

/**
 * `base` as a file name: white space runs become one space (so a tab or a new line is a space, not a dash), each letter a file name cannot hold becomes `-`, the name is cut to
 * 120 characters (whole letters: an emoji is never split), then `.pdf` is added. Nothing left gives `Document.pdf`, never a hidden file called `.pdf`.
 */
export function safeFileName(base: string): string {
  const cleaned = base.replace(/\s+/g, ' ').trim().replace(FORBIDDEN, '-');
  const cut = Array.from(cleaned).slice(0, MAX_BASE_LENGTH).join('').trimEnd();
  return `${cut || 'Document'}.pdf`;
}

/** `EST-0042 - Anita Sharma.pdf`; just `EST-0042.pdf` when the customer name is blank. */
export function estimateFileName(invoice: { invoiceNumber: string; customerName: string }): string {
  const name = invoice.customerName.trim();
  return safeFileName(name ? `${invoice.invoiceNumber} - ${name}` : invoice.invoiceNumber);
}

/** `2026-11-24` as `24-11-2026`, or null for anything that is not a date written that way. */
function dayFirst(businessDate: string | null): string | null {
  const match = businessDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(businessDate) : null;
  return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
}

/** `Stock Catalogue - Ring, Chain - 24-11-2026.pdf`: the categories part is left out when none is chosen or more than 3 are, the date part when there is no business date. */
export function catalogueFileName(chosen: readonly string[], businessDate: string | null): string {
  const parts = ['Stock Catalogue'];
  if (chosen.length >= 1 && chosen.length <= 3) parts.push(chosen.join(', '));
  const date = dayFirst(businessDate);
  if (date) parts.push(date);
  return safeFileName(parts.join(' - '));
}
