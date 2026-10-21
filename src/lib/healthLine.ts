// The owner's dashboard line as a model the card is drawn from (task WEB12; spec section 12 "the dashboard line", I11, I12, B2, B3, O53, O54).
//
// "Books: OK at 02:00" or "Problem", the age of the last good dump and photo copy, the size of the database and of the backup folder, the days since the last Download everything and
// since Harsh's last weekly pull, and yesterday's review counts. It turns red or amber as `GET /v1/dashboard/health` says.
//
// THE RULE OF THIS FILE: the API works out the level and the reasons (`readHealth`, which the route repeats), and this file never decides a threshold. It
//   - repeats the level the API gave, and lists the reasons in the order it gave them, each as a plain sentence;
//   - puts a fact (the dump, the database, the download ...) in the colour of the reason that belongs to it, or of the state the API computed for it (download, pull);
//   - shows a reason it does not know with its code, in the colour of the line, rather than hide it;
//   - invents no reason: a folder with no record yet, and no reason from the API, is shown as "Not recorded yet", not as a problem.
// The reasons of the API task RV3a (jewelvault-api, docs/handoffs.md, section "RV3a") are all worded here: `backup_folder_unusable` (the backup folder is missing or cannot be written to; the
// API reads the folder signal of API34 since RV3a-F3), `backup_photos_damaged` (red) and `backup_photos_repaired` (amber), both about the photo copies, and `backup_clock_ahead` (a good run
// dated in the future). The figures that come with them, `folder_probe`, `photo_files` and `clock_ahead`, are OPTIONAL: an older API does not send them, and the line is the same without
// them. A figure never makes a reason and never sets a colour; the one place the line uses one is the words of the "Backup folder" fact (see `folderValue`).
// Money and days are the API's own text and numbers; nothing here adds anything up. This file imports no client and no store (C9).
import type { DashboardHealth, ReviewListName, ReviewWire } from '@/lib/api/types';
import { REVIEW_LISTS } from '@/lib/api/types';
import type { HealthView } from '@/lib/cache/booksServer';
import { paiseShown } from './ledgerView';
import { parseRupees } from './pricing';

export type Tone = 'ok' | 'amber' | 'red' | 'unknown';
export type FactId = 'books' | 'backup' | 'photos' | 'database' | 'folder' | 'download' | 'pull';

export interface HealthFact {
  id: FactId;
  label: string;
  value: string;
  tone: Tone;
}

export interface HealthReason {
  code: string;
  text: string;
  tone: 'red' | 'amber';
}

export interface ReviewItem {
  id: ReviewListName;
  label: string;
  count: number;
}

export interface ReviewModel {
  /** The business day under review. */
  date: string;
  /** 'yesterday, 15 Oct 2026' or '12 Oct 2026': the card says "Review of ...". */
  dayLabel: string;
  /** The lists with something in them, in the order of the API. */
  items: ReviewItem[];
  /** All the counts added up. */
  total: number;
  /** The walk-in's bills of the day and its cash (Z2: the place where a split sale shows). */
  walkin: { bills: number; cashTotal: string };
}

export interface HealthLineModel {
  state: 'loading' | 'ready' | 'failed';
  /** A read that failed while an earlier line is still shown: the line is the old one. */
  stale: boolean;
  message: string | null;
  level: 'red' | 'amber' | 'green' | null;
  headline: string;
  facts: HealthFact[];
  reasons: HealthReason[];
  review: ReviewModel | null;
  /** The review could not be read (the line itself could). */
  reviewMessage: string | null;
}

// ---- the sentences

/** Reasons that make the line red, with their sentences. The order of the list the screen shows is the API's. */
const RED_REASONS: Readonly<Record<string, string>> = {
  check_problem: "Last night's check found a problem in the books. Tell Harsh.",
  check_never: 'The nightly check has not run yet.',
  check_stale: 'The nightly check has not run for too long. Tell Harsh.',
  dump_never: 'No backup of the data has been made yet.',
  dump_stale: 'The last backup is too old. Tell Harsh.',
  photo_copy_never: 'No copy of the photos has been made yet.',
  photo_copy_stale: 'The last copy of the photos is too old. Tell Harsh.',
  backup_files_fell: 'Files are missing from the backup folder. Tell Harsh.',
  backup_folder_unusable: 'The backup folder is missing or cannot be written to. Tell Harsh.',
  backup_photos_damaged: 'A photo copy in the backup folder is damaged. Tell Harsh.',
  backup_clock_ahead: 'A backup is dated in the future, so its age cannot be trusted. Tell Harsh.',
  db_size: 'The database is above its size limit. Tell Harsh.',
  download_red: 'Download everything has not been used for too long. Do it now.',
};

/** Reasons that make the line amber (a reminder), with their sentences. */
const AMBER_REASONS: Readonly<Record<string, string>> = {
  download_amber: 'It is time to use Download everything.',
  pulled_amber: "Harsh's weekly pull of the backup is late.",
  backup_photos_repaired:
    'Photo copies were missing from the backup folder and have been copied again. Tell Harsh.',
  delete_or_drop_right:
    'The database login can delete or drop data, which it should not. Tell Harsh.',
};

/** Which fact each reason belongs to: that fact takes the colour of the reason. */
const FACT_OF_REASON: Readonly<Record<string, FactId>> = {
  check_problem: 'books',
  check_never: 'books',
  check_stale: 'books',
  dump_never: 'backup',
  dump_stale: 'backup',
  photo_copy_never: 'photos',
  photo_copy_stale: 'photos',
  backup_photos_damaged: 'photos',
  backup_photos_repaired: 'photos',
  backup_clock_ahead: 'backup',
  backup_files_fell: 'folder',
  backup_folder_unusable: 'folder',
  db_size: 'database',
  download_red: 'download',
  download_amber: 'download',
  pulled_amber: 'pull',
};

const REVIEW_LABEL: Readonly<Record<ReviewListName, string>> = {
  below_list_lines: 'Lines sold below the list price',
  discount_over: 'Bills with a large discount',
  cash_overrides: 'Cash limit overridden',
  cancellations: 'Bills cancelled',
  reissues: 'Bills re-issued',
  voids: 'Payments voided',
  refunds: 'Refunds given',
  walkin_bills: 'Walk-in bills',
  fine_cash_rate_away: 'Silver settled in cash at an unusual rate',
  biller_rate_moves: 'Rates entered by a biller that moved a lot',
  sale_type_differs: "Bills whose sale type is not the customer's",
};

const HEADLINE = { red: 'Problem', amber: 'Reminder', green: 'All well' } as const;

// ---- small writers (display only)

const INDIA_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The Asia/Kolkata calendar date of an instant written as an ISO text. */
function kolkataDate(stamp: string): string {
  return new Date(Date.parse(stamp) + INDIA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 02:17 in India. */
function kolkataTime(stamp: string): string {
  return new Date(Date.parse(stamp) + INDIA_OFFSET_MS).toISOString().slice(11, 16);
}

/** '2026-10-15' as '15 Oct'. */
function shortDay(date: string): string {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
}

/** '2026-10-15' as '15 Oct 2026'. */
function longDay(date: string): string {
  return `${shortDay(date)} ${date.slice(0, 4)}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** How long ago, from the hours the API counted: 'Less than an hour ago', '10 hours ago', '3 days ago'. */
function hoursAgo(hours: number): string {
  if (hours < 1) return 'Less than an hour ago';
  if (hours < 48) return `${plural(Math.round(hours), 'hour')} ago`;
  return `${plural(Math.floor(hours / 24), 'day')} ago`;
}

/** Whole days ago, from the days the API counted: 'Today', 'Yesterday', '5 days ago'. */
function daysAgo(days: number): string {
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days} days ago`;
}

/** Bytes as KB, MB or GB: '393 MB', '1.16 GB', '2 GB'. */
function bytesShown(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Number((bytes / (1024 * 1024 * 1024)).toFixed(2))} GB`;
}

// ---- the facts

function toneFrom(reasons: ReadonlySet<string>, fact: FactId, ok: boolean): Tone {
  for (const code of reasons) {
    if (FACT_OF_REASON[code] !== fact) continue;
    if (code in RED_REASONS) return 'red';
    if (code in AMBER_REASONS) return 'amber';
  }
  return ok ? 'ok' : 'unknown';
}

/**
 * The words of the "Backup folder" fact: the size and the files the last good run recorded, or "Cannot be used" when the API says the folder is unusable. The REASON (`backup_folder_unusable`)
 * decides that, as it decides the colour; the figure `folder_probe` (RV3a) only confirms it, so a failed probe that a newer good run has already healed (the API sends no reason then) leaves
 * the recorded size and a calm colour, and a reason from an API that sends no figure keeps the recorded size under a red colour. Nothing is read from the probe's code or place: those are for Harsh.
 */
function folderValue(health: DashboardHealth, reasons: ReadonlySet<string>): string {
  if (reasons.has('backup_folder_unusable') && health.folder_probe?.ok === false)
    return 'Cannot be used';
  return health.folder
    ? `${bytesShown(health.folder.bytes)} · ${plural(health.folder.files, 'file')}`
    : 'Not recorded yet';
}

function factsOf(health: DashboardHealth): HealthFact[] {
  const reasons = new Set(health.reasons);
  const today = kolkataDate(health.now);

  const checkAt = health.check.last_at;
  let books: string;
  if (checkAt === null || health.check.ok === null) books = 'Not checked yet';
  else {
    const when = `${kolkataTime(checkAt)}${kolkataDate(checkAt) === today ? '' : ` on ${shortDay(kolkataDate(checkAt))}`}`;
    books = health.check.ok ? `OK at ${when}` : `Problem found at ${when}`;
  }

  const age = (value: { age_hours: number | null }) =>
    value.age_hours === null ? 'None yet' : hoursAgo(value.age_hours);

  const folder = folderValue(health, reasons);

  const download = health.download;
  let downloadText = 'No record yet';
  if (download.age_days !== null) {
    downloadText =
      download.from === 'last_download'
        ? daysAgo(download.age_days)
        : `Not done yet · ${plural(download.age_days, 'day')} since the first night`;
  }
  const pull = health.pull;
  let pullText = 'No record yet';
  if (pull.age_days !== null) {
    pullText =
      pull.from === 'last_pulled'
        ? daysAgo(pull.age_days)
        : `Not reported yet · ${plural(pull.age_days, 'day')} since the first backup`;
  }

  const stateTone = (state: string): Tone =>
    state === 'ok' ? 'ok' : state === 'amber' ? 'amber' : state === 'red' ? 'red' : 'unknown';

  return [
    {
      id: 'books',
      label: 'Books',
      value: books,
      tone: toneFrom(reasons, 'books', health.check.ok === true),
    },
    {
      id: 'backup',
      label: 'Last backup',
      value: age(health.db_dump),
      tone: toneFrom(reasons, 'backup', health.db_dump.age_hours !== null),
    },
    {
      id: 'photos',
      label: 'Last photo copy',
      value: age(health.photo_copy),
      tone: toneFrom(reasons, 'photos', health.photo_copy.age_hours !== null),
    },
    {
      id: 'database',
      label: 'Database size',
      value: `${bytesShown(health.db_size.bytes)} of ${bytesShown(health.db_size.red_line_bytes)}`,
      tone: toneFrom(reasons, 'database', true),
    },
    {
      id: 'folder',
      label: 'Backup folder',
      value: folder,
      tone: toneFrom(reasons, 'folder', health.folder !== null),
    },
    {
      id: 'download',
      label: 'Download everything',
      value: downloadText,
      tone: stateTone(download.state),
    },
    {
      id: 'pull',
      label: "Harsh's weekly pull",
      value: pullText,
      tone: stateTone(pull.state),
    },
  ];
}

function reasonsOf(health: DashboardHealth): HealthReason[] {
  return health.reasons.map((code) => {
    if (code in RED_REASONS) return { code, text: RED_REASONS[code], tone: 'red' as const };
    if (code in AMBER_REASONS) return { code, text: AMBER_REASONS[code], tone: 'amber' as const };
    return {
      code,
      text: `Something needs a look (${code}). Tell Harsh.`,
      tone: health.level === 'red' ? ('red' as const) : ('amber' as const),
    };
  });
}

function reviewOf(review: ReviewWire, nowDate: string): ReviewModel {
  const items = REVIEW_LISTS.flatMap((id) => {
    const count = review.counts[id] ?? 0;
    return count > 0 ? [{ id, label: REVIEW_LABEL[id], count }] : [];
  });
  const yesterday = new Date(Date.parse(`${nowDate}T00:00:00Z`) - DAY_MS)
    .toISOString()
    .slice(0, 10);
  return {
    date: review.date,
    dayLabel:
      review.date === yesterday ? `yesterday, ${longDay(review.date)}` : longDay(review.date),
    items,
    total: items.reduce((sum, item) => sum + item.count, 0),
    walkin: {
      bills: review.walkin.bills,
      cashTotal: paiseShown(parseRupees(review.walkin.cash_total, { field: 'cash_total' })),
    },
  };
}

/** The line as the card draws it, from what the store holds. */
export function buildHealthLine(view: HealthView): HealthLineModel {
  const health = view.health;
  if (health === null) {
    return {
      state: view.state === 'failed' ? 'failed' : 'loading',
      stale: false,
      message: view.state === 'failed' ? view.message : null,
      level: null,
      headline: view.state === 'failed' ? 'Not known' : 'Checking the books',
      facts: [],
      reasons: [],
      review: null,
      reviewMessage: null,
    };
  }
  return {
    state: view.state === 'failed' ? 'failed' : 'ready',
    stale: view.state === 'failed',
    message: view.state === 'failed' ? view.message : null,
    level: health.level,
    headline: HEADLINE[health.level],
    facts: factsOf(health),
    reasons: reasonsOf(health),
    review: view.review ? reviewOf(view.review, kolkataDate(health.now)) : null,
    reviewMessage: view.reviewMessage,
  };
}

// ---- the "Download everything" card (B3, I12, O53; task WEB12b)

export interface DownloadCardModel {
  state: 'loading' | 'ready' | 'failed';
  /** The colour: the API's verdict on the last download (green up to day 27, amber from day 28, red from day 36). */
  tone: Tone;
  /** 'Today', 'Yesterday', '5 days ago', or 'Not done yet' when there is no download on record. */
  last: string;
  /** The day of the last download, '10 Oct 2026'; null when there is none. */
  date: string | null;
  /** With no download yet: '28 days since the first night' (the first one is due 28 days after the first night the system ran). */
  since: string | null;
  /** The sentence for an amber or a red card; null while it is green. */
  reminder: string | null;
}

/**
 * The card on the owner's dashboard, from the same read as the line. The API counts whole Asia/Kolkata days and says the state of the download; the card repeats it and decides no
 * threshold. The sentences are those of the line, so the two never say different things.
 */
export function buildDownloadCard(view: HealthView): DownloadCardModel {
  const health = view.health;
  if (health === null) {
    return {
      state: view.state === 'failed' ? 'failed' : 'loading',
      tone: 'unknown',
      last: view.state === 'failed' ? 'Not known' : 'Reading the date…',
      date: null,
      since: null,
      reminder: null,
    };
  }
  const download = health.download;
  const done = download.from === 'last_download' && download.age_days !== null;
  const tone: Tone =
    download.state === 'ok'
      ? 'ok'
      : download.state === 'amber'
        ? 'amber'
        : download.state === 'red'
          ? 'red'
          : 'unknown';
  return {
    state: 'ready',
    tone,
    last: done ? daysAgo(download.age_days as number) : 'Not done yet',
    date: done && download.reference_date ? longDay(download.reference_date) : null,
    since:
      !done && download.age_days !== null
        ? `${plural(download.age_days, 'day')} since the first night`
        : null,
    reminder:
      tone === 'red'
        ? RED_REASONS.download_red
        : tone === 'amber'
          ? AMBER_REASONS.download_amber
          : null,
  };
}
