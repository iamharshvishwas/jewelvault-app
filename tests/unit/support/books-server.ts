// A fake of the three reads WEB12 makes that the sync fake (server.ts) does not know: the cash book `GET /v1/daily-totals?from=&to=`, the owner's dashboard line
// `GET /v1/dashboard/health` and the newest rows of `GET /v1/health/checks?limit=`. It is spoken to through the REAL API client by a stubbed `fetch`, and it keeps the rules that
// matter to the screens: the cash book answers the rows of the range asked for (both ends included), the owner's window is 400 days (422 past it) and a biller's is today and
// yesterday of `today` (403 outside it), and only the owner reads the line.
import type {
  CheckRunWire,
  DailyTotalWire,
  DashboardHealth,
  Role,
  ReviewWire,
} from '@/lib/api/types';

export interface SeenRead {
  path: string;
  query: Record<string, string>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const refusal = (code: string, status: number, message = 'made up by the test') =>
  json(status, { error: { code, message, details: {} }, request_id: 'req-books' });

/** A day number of a business date (days since 1970-01-01). */
const dayNumber = (date: string) =>
  Math.round(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) /
      86_400_000
  );

/** A healthy line: the check ran, a dump and a photo copy are recent, the folder is recorded, the owner downloaded five days ago, the pull was reported two days ago. */
export function greenHealth(over: Partial<DashboardHealth> = {}): DashboardHealth {
  return {
    level: 'green',
    reasons: [],
    check: { last_at: '2026-10-15T20:47:00.000000Z', age_hours: 10.2, ok: true },
    db_dump: { last_at: '2026-10-15T21:10:00.000000Z', age_hours: 9.8 },
    photo_copy: { last_at: '2026-10-15T21:12:00.000000Z', age_hours: 9.8 },
    db_size: {
      bytes: 412_000_000,
      data_bytes: 300_000_000,
      index_bytes: 60_000_000,
      photo_bytes: 8_000_000,
      overhead_percent: 12,
      red_line_bytes: 2_147_483_648,
      injected: false,
    },
    download: { state: 'ok', from: 'last_download', reference_date: '2026-10-10', age_days: 5 },
    pull: { state: 'ok', from: 'last_pulled', reference_date: '2026-10-13', age_days: 2 },
    folder: {
      files: 83,
      bytes: 1_250_000_000,
      free_bytes: 48_000_000_000,
      previous_files: 82,
      recorded_at: '2026-10-15T21:12:00.000000Z',
      fell: false,
      fell_at: null,
    },
    rights: { delete: false, drop: false, extra: [] },
    now: '2026-10-16T07:00:00.000000Z',
    ...over,
  };
}

export class FakeBooksApi {
  readonly seen: SeenRead[] = [];
  /** The rows of V4 the server holds (every day). */
  dailyTotals: DailyTotalWire[] = [];
  /** The line `GET /v1/dashboard/health` answers. */
  health: DashboardHealth = greenHealth();
  /** The review line of the newest check run (null: the run carries none). */
  review: ReviewWire | null = null;
  /** Rows of `check_runs`, newest first. Overrides `review` when given. */
  checkRuns: CheckRunWire[] | null = null;
  /** Who is asking (the line is the owner's; a biller reads the cash book for two days only). */
  role: Role = 'owner';
  /** The business date of the API's clock. */
  today = '2026-10-15';
  /** Fails the next N cash-book calls with this status. */
  failTotals: { status: number; times: number } | null = null;
  failHealth: { status: number; times: number } | null = null;
  failChecks: { status: number; times: number } | null = null;
  /** Holds each cash-book call until this promise is settled (a slow server). */
  hold: Promise<void> | null = null;

  count(path: string): number {
    return this.seen.filter((c) => c.path === path).length;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    this.seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    if (method !== 'GET') return refusal('JV_NOT_FOUND', 404);

    if (url.pathname === '/v1/daily-totals') {
      if (this.hold) await this.hold;
      if (this.failTotals && this.failTotals.times > 0) {
        this.failTotals.times -= 1;
        return refusal('JV_INTERNAL', this.failTotals.status);
      }
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
        return refusal('JV_INVALID_INPUT', 422, 'from and to are required');
      if (dayNumber(to) < dayNumber(from)) return refusal('JV_INVALID_INPUT', 422);
      if (this.role === 'staff') return refusal('JV_FORBIDDEN', 403);
      if (this.role === 'biller') {
        if (dayNumber(from) < dayNumber(this.today) - 1 || dayNumber(to) > dayNumber(this.today))
          return refusal('JV_FORBIDDEN', 403);
      } else if (dayNumber(to) - dayNumber(from) + 1 > 400) {
        return refusal('JV_INVALID_INPUT', 422);
      }
      const rows = this.dailyTotals
        .filter((row) => row.business_date >= from && row.business_date <= to)
        .sort(
          (a, b) => a.business_date.localeCompare(b.business_date) || a.mode.localeCompare(b.mode)
        );
      return json(200, { rows });
    }

    if (url.pathname === '/v1/dashboard/health') {
      if (this.role !== 'owner') return refusal('JV_FORBIDDEN', 403);
      if (this.failHealth && this.failHealth.times > 0) {
        this.failHealth.times -= 1;
        return refusal('JV_INTERNAL', this.failHealth.status);
      }
      return json(200, this.health);
    }

    if (url.pathname === '/v1/health/checks') {
      if (this.role !== 'owner') return refusal('JV_FORBIDDEN', 403);
      if (this.failChecks && this.failChecks.times > 0) {
        this.failChecks.times -= 1;
        return refusal('JV_INTERNAL', this.failChecks.status);
      }
      const limit = Number(url.searchParams.get('limit') ?? 30);
      const runs: CheckRunWire[] = this.checkRuns ?? [
        {
          id: 1,
          ran_at: '2026-10-15T20:47:00.000000Z',
          ok: true,
          details: this.review
            ? { date: '2026-10-15', review: this.review }
            : { date: '2026-10-15' },
        },
      ];
      return json(200, { check_runs: runs.slice(0, limit), backup_runs: [] });
    }
    return refusal('JV_NOT_FOUND', 404);
  };
}

/** A V4 row as the API sends it. */
export function totalRow(
  date: string,
  mode: string,
  moneyIn: string,
  moneyOut: string,
  net: string
): DailyTotalWire {
  return { business_date: date, mode, money_in: moneyIn, money_out: moneyOut, net };
}
