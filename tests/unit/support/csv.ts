// A reader of RFC 4180 text for the tests of the exports (WEB12b): quotes, commas and line breaks inside quotes, doubled quotes, CRLF or LF, a leading byte-order mark.
// It is the tests' own reader, written apart from the code under test: a bug in how a cell is written does not cancel itself out by being read the same wrong way.
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let sawAny = false;
  const endCell = () => {
    row.push(cell);
    cell = '';
  };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '' && !sawAny)) rows.push(row);
    row = [];
    sawAny = false;
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      sawAny = true;
    } else if (ch === ',') {
      sawAny = true;
      endCell();
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      endRow();
    } else {
      sawAny = true;
      cell += ch;
    }
  }
  if (quoted) throw new Error('the CSV has an unterminated quote');
  if (cell !== '' || row.length > 0 || sawAny) endRow();
  const [header = [], ...rest] = rows;
  return { header, rows: rest };
}

/** The text of the `<td>` cells of an HTML table, in order, with the five entities the export writes turned back into characters. */
export function htmlCells(html: string, tag: 'td' | 'th' = 'td'): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`<${tag}(?: [^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  for (const match of html.matchAll(pattern)) {
    out.push(
      match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
    );
  }
  return out;
}
