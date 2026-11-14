// FB-D3 (Siddhi #7): the outstanding list as the rows of a CSV for `downloadCsv` (src/lib/exportUtils.ts, whose one formula guard writes every cell: a mobile that starts with + goes out as
// text). The columns are the ones Siddhi asked for, in this order; the money is exact rupee text and the silver exact gram text from the whole paise and milligrams of the selectors (never a
// float), the date is the bill date as it is stored (YYYY-MM-DD, which a spreadsheet sorts).
import type { ExportRow } from './exportUtils';
import { formatGrams, formatRupees } from './pricing';
import type { OutstandingRow } from './selectors';

export const OUTSTANDING_CSV_COLUMNS = [
  'Customer',
  'Mobile',
  'Outstanding (Rs)',
  'Fine due (g)',
  'Oldest pending bill',
  'Days',
] as const;

export function outstandingCsvRows(rows: readonly OutstandingRow[]): ExportRow[] {
  return rows.map((row) => ({
    Customer: row.name,
    Mobile: row.mobile,
    // the figures are whole paise and milligrams that came out of safe integers: the conversion is exact
    'Outstanding (Rs)': formatRupees(Number(row.outstandingPaise)),
    'Fine due (g)': formatGrams(Number(row.fineDueMg)),
    'Oldest pending bill': row.oldestPendingBillDate ?? '',
    Days: row.daysPending ?? '',
  }));
}
