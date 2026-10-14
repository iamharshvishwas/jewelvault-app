export type ExportRow = Record<string, string | number | boolean | null | undefined>;

function safeFilePart(value: string) {
  return value.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(content: BlobPart, mimeType: string, filename: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function columnsFor(rows: ExportRow[]) {
  const seen = new Set<string>();
  for (const row of rows) {
    Object.keys(row).forEach((key) => seen.add(key));
  }
  return Array.from(seen);
}

function reportTableHtml(title: string, rows: ExportRow[], subtitle?: string) {
  const columns = columnsFor(rows);
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
    <thead><tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead>
    <tbody>
      ${rows.length === 0
        ? `<tr><td colspan="${Math.max(1, columns.length)}">No records found</td></tr>`
        : rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join('')}</tr>`).join('')}
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
  downloadBlob(`\ufeff${csv}`, 'text/csv;charset=utf-8', `${safeFilePart(title)}.csv`);
}

export function downloadExcel(title: string, rows: ExportRow[], subtitle?: string) {
  const html = reportTableHtml(title, rows, subtitle);
  downloadBlob(`\ufeff${html}`, 'application/vnd.ms-excel;charset=utf-8', `${safeFilePart(title)}.xls`);
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
