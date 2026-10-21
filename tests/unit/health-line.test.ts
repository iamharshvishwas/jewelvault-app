// WEB12 (PT-W12; spec section 12 "the dashboard line", I11, I12, B2, B3, O53, O54): the owner's dashboard line shows, in one place,
//   "Books: OK at 02:00" or "Problem", the age of the last good dump and photo copy, the size of the database and of the backup folder, the days since the last Download everything
//   and since the last weekly pull, and yesterday's review counts, and it turns red or amber as `GET /v1/dashboard/health` says.
//
// THE RULE OF THIS SCREEN: the API (`readHealth`, API12/API32/API35) works out the level and the reasons and the route only repeats them, so the screen never decides a threshold. It maps each
// reason to a plain sentence and puts the fact it belongs to in the colour of that reason; a reason it does not know is still shown, in the colour of the line. The four reasons of the API
// task RV3a (`backup_folder_unusable`, `backup_photos_damaged`, `backup_photos_repaired`, `backup_clock_ahead`) are worded below; the three figures that come with them (`folder_probe`,
// `photo_files`, `clock_ahead`) are optional, because an API built before RV3a does not send them, and they decide nothing: the screen never invents a reason from a figure.
//
// Three layers: `buildHealthLine` (the model, pure), the store that reads the two calls (`createBooksServer`), and the card drawn from the model (`HealthLineView`, server-side React).
//
// Run: npm test -- tests/unit/health-line.test.ts      (or: npm test -- -t PT-W12)
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { FakeBooksApi, greenHealth } from './support/books-server';
import type { DashboardHealth, ReviewWire } from '@/lib/api/types';
import type { HealthView } from '@/lib/cache/booksServer';

// ---- the model

async function model() {
  return import('@/lib/healthLine');
}

/** A read that ended well: the line, and optionally the review counts. */
const ready = (health: DashboardHealth, review: ReviewWire | null = null): HealthView => ({
  state: 'ready',
  message: null,
  health,
  review,
  reviewMessage: null,
});

const factOf = (
  line: { facts: Array<{ id: string; value: string; tone: string }> },
  id: string
) => {
  const found = line.facts.find((f) => f.id === id);
  if (!found) throw new Error(`no fact ${id}`);
  return found;
};

describe('PT-W12 the dashboard line: a healthy night', () => {
  it('says Books: OK at the time of the check, the age of the dump and the photo copy, the sizes and the two day counts', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(ready(greenHealth()));
    expect(line.state).toBe('ready');
    expect(line.level).toBe('green');
    expect(line.headline).toBe('All well');
    expect(line.reasons).toEqual([]);
    // the check ran at 20:47 UTC = 02:17 the next morning in India (Asia/Kolkata), the same business day as `now` (07:00 UTC = 12:30)
    expect(factOf(line, 'books')).toEqual({
      id: 'books',
      label: 'Books',
      value: 'OK at 02:17',
      tone: 'ok',
    });
    expect(factOf(line, 'backup')).toMatchObject({ value: '10 hours ago', tone: 'ok' });
    expect(factOf(line, 'photos')).toMatchObject({ value: '10 hours ago', tone: 'ok' });
    expect(factOf(line, 'database')).toMatchObject({ value: '393 MB of 2 GB', tone: 'ok' });
    expect(factOf(line, 'folder')).toMatchObject({ value: '1.16 GB · 83 files', tone: 'ok' });
    expect(factOf(line, 'download')).toMatchObject({ value: '5 days ago', tone: 'ok' });
    expect(factOf(line, 'pull')).toMatchObject({ value: '2 days ago', tone: 'ok' });
  });

  it('names the day of the check when it was not today', async () => {
    const { buildHealthLine } = await model();
    const health = greenHealth({
      check: { last_at: '2026-10-14T20:47:00.000000Z', age_hours: 34.2, ok: true },
    });
    expect(factOf(buildHealthLine(ready(health)), 'books').value).toBe('OK at 02:17 on 15 Oct');
  });
});

describe('PT-W12 the dashboard line: each red reason of the API turns the line red and says why', () => {
  const red: Array<[string, Partial<DashboardHealth>, string, string]> = [
    [
      'check_problem',
      { check: { last_at: '2026-10-15T20:47:00.000000Z', age_hours: 10.2, ok: false } },
      'books',
      "Last night's check found a problem in the books. Tell Harsh.",
    ],
    [
      'check_never',
      { check: { last_at: null, age_hours: null, ok: null } },
      'books',
      'The nightly check has not run yet.',
    ],
    [
      'check_stale',
      { check: { last_at: '2026-10-14T20:47:00.000000Z', age_hours: 34.2, ok: true } },
      'books',
      'The nightly check has not run for too long. Tell Harsh.',
    ],
    [
      'dump_never',
      { db_dump: { last_at: null, age_hours: null } },
      'backup',
      'No backup of the data has been made yet.',
    ],
    [
      'dump_stale',
      { db_dump: { last_at: '2026-10-14T01:10:00.000000Z', age_hours: 30.5 } },
      'backup',
      'The last backup is too old. Tell Harsh.',
    ],
    [
      'photo_copy_never',
      { photo_copy: { last_at: null, age_hours: null } },
      'photos',
      'No copy of the photos has been made yet.',
    ],
    [
      'photo_copy_stale',
      { photo_copy: { last_at: '2026-10-14T01:10:00.000000Z', age_hours: 30.5 } },
      'photos',
      'The last copy of the photos is too old. Tell Harsh.',
    ],
    [
      'backup_files_fell',
      {
        folder: {
          files: 70,
          bytes: 1_000_000_000,
          free_bytes: null,
          previous_files: 83,
          recorded_at: '2026-10-15T21:12:00.000000Z',
          fell: true,
          fell_at: '2026-10-15T21:12:00.000000Z',
        },
      },
      'folder',
      'Files are missing from the backup folder. Tell Harsh.',
    ],
    [
      'db_size',
      {
        db_size: {
          bytes: 2_300_000_000,
          data_bytes: 2_000_000_000,
          index_bytes: 100_000_000,
          photo_bytes: 0,
          overhead_percent: 12,
          red_line_bytes: 2_147_483_648,
          injected: false,
        },
      },
      'database',
      'The database is above its size limit. Tell Harsh.',
    ],
    [
      'download_red',
      {
        download: {
          state: 'red',
          from: 'last_download',
          reference_date: '2026-09-01',
          age_days: 44,
        },
      },
      'download',
      'Download everything has not been used for too long. Do it now.',
    ],
  ];

  for (const [code, change, factId, sentence] of red) {
    it(`${code}: the line is red, the sentence is shown, and the fact it belongs to is red`, async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(greenHealth({ ...change, level: 'red', reasons: [code] }))
      );
      expect(line.level).toBe('red');
      expect(line.headline).toBe('Problem');
      expect(line.reasons).toEqual([{ code, text: sentence, tone: 'red' }]);
      expect(factOf(line, factId).tone).toBe('red');
      // and no other fact is red
      expect(line.facts.filter((f) => f.tone === 'red').map((f) => f.id)).toEqual([factId]);
    });
  }

  it('a night that never ran is red for the check, the backup and the photo copy together, in the order the API gave', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(
      ready(
        greenHealth({
          level: 'red',
          reasons: ['check_never', 'dump_never', 'photo_copy_never'],
          check: { last_at: null, age_hours: null, ok: null },
          db_dump: { last_at: null, age_hours: null },
          photo_copy: { last_at: null, age_hours: null },
          folder: null,
          download: { state: 'unknown', from: null, reference_date: null, age_days: null },
          pull: { state: 'unknown', from: null, reference_date: null, age_days: null },
        })
      )
    );
    expect(line.reasons.map((r) => r.code)).toEqual([
      'check_never',
      'dump_never',
      'photo_copy_never',
    ]);
    expect(factOf(line, 'books').value).toBe('Not checked yet');
    expect(factOf(line, 'backup').value).toBe('None yet');
    expect(factOf(line, 'photos').value).toBe('None yet');
    expect(factOf(line, 'folder')).toMatchObject({ value: 'Not recorded yet', tone: 'unknown' });
    expect(factOf(line, 'download')).toMatchObject({ value: 'No record yet', tone: 'unknown' });
    expect(factOf(line, 'pull')).toMatchObject({ value: 'No record yet', tone: 'unknown' });
  });
});

describe('PT-W12 the dashboard line: each amber reason is amber, not red', () => {
  const amber: Array<[string, Partial<DashboardHealth>, string | null, string]> = [
    [
      'download_amber',
      {
        download: {
          state: 'amber',
          from: 'last_download',
          reference_date: '2026-09-12',
          age_days: 33,
        },
      },
      'download',
      'It is time to use Download everything.',
    ],
    [
      'pulled_amber',
      { pull: { state: 'amber', from: 'last_pulled', reference_date: '2026-10-01', age_days: 14 } },
      'pull',
      "Harsh's weekly pull of the backup is late.",
    ],
    [
      'delete_or_drop_right',
      { rights: { delete: true, drop: false, extra: ['DELETE'] } },
      null,
      'The database login can delete or drop data, which it should not. Tell Harsh.',
    ],
  ];

  for (const [code, change, factId, sentence] of amber) {
    it(`${code}: the line is amber (a reminder), never red`, async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(greenHealth({ ...change, level: 'amber', reasons: [code] }))
      );
      expect(line.level).toBe('amber');
      expect(line.headline).toBe('Reminder');
      expect(line.reasons).toEqual([{ code, text: sentence, tone: 'amber' }]);
      expect(line.facts.some((f) => f.tone === 'red')).toBe(false);
      if (factId) expect(factOf(line, factId).tone).toBe('amber');
    });
  }

  it('the download counted from the first night says so, and is amber at 28 days as the API computes', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(
      ready(
        greenHealth({
          level: 'amber',
          reasons: ['download_amber'],
          download: {
            state: 'amber',
            from: 'first_night',
            reference_date: '2026-09-17',
            age_days: 28,
          },
        })
      )
    );
    expect(factOf(line, 'download')).toMatchObject({
      value: 'Not done yet · 28 days since the first night',
      tone: 'amber',
    });
  });

  it('red and amber reasons together: the line is red, each reason keeps its own colour, in the API order', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(
      ready(
        greenHealth({
          level: 'red',
          reasons: ['dump_stale', 'download_amber', 'pulled_amber'],
          db_dump: { last_at: '2026-10-14T01:10:00.000000Z', age_hours: 30.5 },
          download: {
            state: 'amber',
            from: 'last_download',
            reference_date: '2026-09-12',
            age_days: 33,
          },
          pull: { state: 'amber', from: 'last_pulled', reference_date: '2026-10-01', age_days: 14 },
        })
      )
    );
    expect(line.level).toBe('red');
    expect(line.reasons.map((r) => [r.code, r.tone])).toEqual([
      ['dump_stale', 'red'],
      ['download_amber', 'amber'],
      ['pulled_amber', 'amber'],
    ]);
  });
});

describe('PT-W12 the dashboard line shows whatever the API sends and invents no reason', () => {
  it('a reason this build does not know is shown, in the colour of the line, with its code', async () => {
    const { buildHealthLine } = await model();
    const red = buildHealthLine(
      ready(greenHealth({ level: 'red', reasons: ['backup_folder_unusable_v2'] }))
    );
    expect(red.reasons).toEqual([
      {
        code: 'backup_folder_unusable_v2',
        text: 'Something needs a look (backup_folder_unusable_v2). Tell Harsh.',
        tone: 'red',
      },
    ]);
    const amber = buildHealthLine(ready(greenHealth({ level: 'amber', reasons: ['new_thing'] })));
    expect(amber.reasons[0].tone).toBe('amber');
  });

  it('the folder reason of spec 5.2.2 (sent by the API since RV3a) is worded, and the folder fact turns red with it', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(
      ready(greenHealth({ level: 'red', reasons: ['backup_folder_unusable'] }))
    );
    expect(line.reasons[0]).toEqual({
      code: 'backup_folder_unusable',
      text: 'The backup folder is missing or cannot be written to. Tell Harsh.',
      tone: 'red',
    });
    expect(factOf(line, 'folder').tone).toBe('red');
  });

  it('a folder with no record yet and no reason from the API is NOT shown as a problem (no reason, no red): the API has not said so', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(ready(greenHealth({ folder: null })));
    expect(line.level).toBe('green');
    expect(line.reasons).toEqual([]);
    expect(factOf(line, 'folder').tone).toBe('unknown');
  });

  it('a level the API gives is the level shown: the screen does not recompute it from the facts', async () => {
    const { buildHealthLine } = await model();
    // a stale dump in the facts but a green level and no reason from the API: nothing is red here
    const line = buildHealthLine(
      ready(greenHealth({ db_dump: { last_at: '2026-10-10T01:10:00.000000Z', age_hours: 120 } }))
    );
    expect(line.level).toBe('green');
    expect(factOf(line, 'backup')).toMatchObject({ value: '5 days ago', tone: 'ok' });
  });
});

describe('PT-W12 / RV3a the dashboard line: the four reasons the API added for the backup folder, the photo copies and the clock', () => {
  const photoFiles = (over: Partial<NonNullable<DashboardHealth['photo_files']>> = {}) => ({
    repaired: 0,
    repaired_at: null,
    damaged: 0,
    damaged_at: null,
    ...over,
  });
  const probeFailed = {
    ok: false,
    code: 'ENOENT',
    where: 'folder',
    at: '2026-10-16T01:10:00.000000Z',
  };

  const cases: Array<{
    code: string;
    level: 'red' | 'amber';
    change: Partial<DashboardHealth>;
    fact: string;
    sentence: string;
  }> = [
    {
      code: 'backup_photos_damaged',
      level: 'red',
      change: {
        photo_files: photoFiles({ damaged: 2, damaged_at: '2026-10-15T21:12:00.000000Z' }),
      },
      fact: 'photos',
      sentence: 'A photo copy in the backup folder is damaged. Tell Harsh.',
    },
    {
      code: 'backup_clock_ahead',
      level: 'red',
      change: { clock_ahead: { last_at: '2026-10-16T10:00:00.000000Z', hours: 3 } },
      fact: 'backup',
      sentence: 'A backup is dated in the future, so its age cannot be trusted. Tell Harsh.',
    },
    {
      code: 'backup_photos_repaired',
      level: 'amber',
      change: {
        photo_files: photoFiles({ repaired: 3, repaired_at: '2026-10-15T21:12:00.000000Z' }),
      },
      fact: 'photos',
      sentence:
        'Photo copies were missing from the backup folder and have been copied again. Tell Harsh.',
    },
    {
      code: 'backup_folder_unusable',
      level: 'red',
      change: { folder_probe: probeFailed },
      fact: 'folder',
      sentence: 'The backup folder is missing or cannot be written to. Tell Harsh.',
    },
  ];

  for (const { code, level, change, fact, sentence } of cases) {
    it(`${code}: the line is ${level === 'red' ? 'red' : 'amber (a reminder)'}, the sentence is plain, and only the ${fact} fact changes colour`, async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(ready(greenHealth({ ...change, level, reasons: [code] })));
      expect(line.level).toBe(level);
      expect(line.headline).toBe(level === 'red' ? 'Problem' : 'Reminder');
      expect(line.reasons).toEqual([{ code, text: sentence, tone: level }]);
      expect(factOf(line, fact).tone).toBe(level);
      // every other fact is as healthy as it was
      expect(line.facts.filter((f) => f.tone !== 'ok').map((f) => f.id)).toEqual([fact]);
      // one short sentence for Siddhi's staff: no code word, and it says who can fix it
      expect(sentence.length).toBeLessThanOrEqual(90);
      expect(sentence).not.toContain('_');
      expect(sentence.endsWith('Tell Harsh.')).toBe(true);
    });
  }

  it('the facts keep what the API measured: a damaged copy or a wrong clock changes the colour, not the age shown', async () => {
    const { buildHealthLine } = await model();
    const damaged = buildHealthLine(
      ready(
        greenHealth({
          level: 'red',
          reasons: ['backup_photos_damaged'],
          photo_files: photoFiles({ damaged: 1, damaged_at: '2026-10-15T21:12:00.000000Z' }),
        })
      )
    );
    expect(factOf(damaged, 'photos')).toMatchObject({ value: '10 hours ago', tone: 'red' });
    const ahead = buildHealthLine(
      ready(
        greenHealth({
          level: 'red',
          reasons: ['backup_clock_ahead'],
          clock_ahead: { last_at: '2026-10-16T12:00:00.000000Z', hours: 5 },
        })
      )
    );
    expect(factOf(ahead, 'backup')).toMatchObject({ value: '10 hours ago', tone: 'red' });
  });

  it('reasons come in the order the API gave them, each in its own colour, and every fact takes the first colour the API listed for it', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(
      ready(
        greenHealth({
          level: 'red',
          reasons: [
            'dump_stale',
            'backup_folder_unusable',
            'backup_photos_damaged',
            'backup_clock_ahead',
            'download_amber',
            'backup_photos_repaired',
            'delete_or_drop_right',
          ],
          db_dump: { last_at: '2026-10-14T01:10:00.000000Z', age_hours: 30.5 },
          download: {
            state: 'amber',
            from: 'last_download',
            reference_date: '2026-09-12',
            age_days: 33,
          },
          rights: { delete: true, drop: false, extra: ['DELETE'] },
          folder_probe: probeFailed,
          photo_files: photoFiles({
            repaired: 1,
            repaired_at: '2026-10-15T21:12:00.000000Z',
            damaged: 1,
            damaged_at: '2026-10-15T21:12:00.000000Z',
          }),
          clock_ahead: { last_at: '2026-10-16T10:00:00.000000Z', hours: 3 },
        })
      )
    );
    expect(line.level).toBe('red');
    expect(line.reasons.map((r) => [r.code, r.tone])).toEqual([
      ['dump_stale', 'red'],
      ['backup_folder_unusable', 'red'],
      ['backup_photos_damaged', 'red'],
      ['backup_clock_ahead', 'red'],
      ['download_amber', 'amber'],
      ['backup_photos_repaired', 'amber'],
      ['delete_or_drop_right', 'amber'],
    ]);
    expect(line.reasons.some((r) => r.text.startsWith('Something needs a look'))).toBe(false);
    // damaged (red) comes before repaired (amber) in the API's order, so the photo copy is red
    expect(factOf(line, 'photos').tone).toBe('red');
    expect(factOf(line, 'backup').tone).toBe('red');
    expect(factOf(line, 'folder').tone).toBe('red');
    expect(factOf(line, 'download').tone).toBe('amber');
  });

  it('a repaired photo copy alone is a reminder, and the same code in a red line keeps its amber colour', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(
      ready(greenHealth({ level: 'red', reasons: ['dump_stale', 'backup_photos_repaired'] }))
    );
    expect(line.reasons.map((r) => [r.code, r.tone])).toEqual([
      ['dump_stale', 'red'],
      ['backup_photos_repaired', 'amber'],
    ]);
    expect(factOf(line, 'photos').tone).toBe('amber');
  });

  describe('the Backup folder fact', () => {
    it('says "Cannot be used" when the API says the folder is unusable and its newest probe failed', async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(
          greenHealth({
            level: 'red',
            reasons: ['backup_folder_unusable'],
            folder_probe: probeFailed,
          })
        )
      );
      expect(factOf(line, 'folder')).toEqual({
        id: 'folder',
        label: 'Backup folder',
        value: 'Cannot be used',
        tone: 'red',
      });
    });

    it('says it too when the folder has no recorded size at all', async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(
          greenHealth({
            level: 'red',
            reasons: ['backup_folder_unusable'],
            folder: null,
            folder_probe: probeFailed,
          })
        )
      );
      expect(factOf(line, 'folder')).toMatchObject({ value: 'Cannot be used', tone: 'red' });
    });

    it('keeps the last recorded size and files when the API sends the reason without the figure (an older build)', async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(greenHealth({ level: 'red', reasons: ['backup_folder_unusable'] }))
      );
      expect(factOf(line, 'folder')).toMatchObject({ value: '1.16 GB · 83 files', tone: 'red' });
    });

    it('keeps the colour from the reason, never from the figure: a failed probe that a newer good run already healed (no reason) stays green', async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(ready(greenHealth({ folder_probe: probeFailed })));
      expect(line.level).toBe('green');
      expect(line.reasons).toEqual([]);
      expect(factOf(line, 'folder')).toMatchObject({ value: '1.16 GB · 83 files', tone: 'ok' });
    });

    it('a probe that passed (the heal row) changes nothing', async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(
          greenHealth({
            folder_probe: { ok: true, code: null, where: null, at: '2026-10-16T01:10:00.000000Z' },
          })
        )
      );
      expect(factOf(line, 'folder')).toMatchObject({ value: '1.16 GB · 83 files', tone: 'ok' });
    });
  });

  describe('a health body without the new figures, or with them empty', () => {
    it('the base body of an API built before RV3a has none of the three keys, and draws as before', async () => {
      const { buildHealthLine } = await model();
      const base = greenHealth();
      expect('photo_files' in base).toBe(false);
      expect('folder_probe' in base).toBe(false);
      expect('clock_ahead' in base).toBe(false);
      const line = buildHealthLine(ready(base));
      expect(line.level).toBe('green');
      expect(line.reasons).toEqual([]);
      expect(factOf(line, 'folder')).toMatchObject({ value: '1.16 GB · 83 files', tone: 'ok' });
    });

    it('each new reason still gets its sentence and its colour when none of the figures is there', async () => {
      const { buildHealthLine } = await model();
      for (const { code, level, sentence, fact } of cases) {
        const line = buildHealthLine(ready(greenHealth({ level, reasons: [code] })));
        expect(line.reasons).toEqual([{ code, text: sentence, tone: level }]);
        expect(factOf(line, fact).tone).toBe(level);
      }
    });

    it('figures that say "nothing happened" (null, or zero counts) add no reason and change no fact', async () => {
      const { buildHealthLine } = await model();
      const plain = buildHealthLine(ready(greenHealth()));
      const quiet = buildHealthLine(
        ready(greenHealth({ folder_probe: null, clock_ahead: null, photo_files: photoFiles() }))
      );
      expect(quiet).toEqual(plain);
    });

    it('a figure alone invents nothing: damaged copies, a clock ahead and a failed probe without any reason from the API leave the line green', async () => {
      const { buildHealthLine } = await model();
      const line = buildHealthLine(
        ready(
          greenHealth({
            photo_files: photoFiles({ damaged: 4, damaged_at: '2026-10-15T21:12:00.000000Z' }),
            clock_ahead: { last_at: '2026-10-16T12:00:00.000000Z', hours: 5 },
          })
        )
      );
      expect(line.level).toBe('green');
      expect(line.reasons).toEqual([]);
      expect(line.facts.every((f) => f.tone === 'ok')).toBe(true);
    });
  });

  describe('the card drawn from the model', () => {
    it('shows each new reason with its sentence and colour, the photo copy and the backup facts in their colours, and the folder as "Cannot be used"', async () => {
      const html = await drawCard(({ el, m, c }) => {
        const view = ready(
          greenHealth({
            level: 'red',
            reasons: [
              'backup_folder_unusable',
              'backup_photos_damaged',
              'backup_clock_ahead',
              'backup_photos_repaired',
            ],
            folder_probe: probeFailed,
            photo_files: photoFiles({
              repaired: 1,
              repaired_at: '2026-10-15T21:12:00.000000Z',
              damaged: 1,
              damaged_at: '2026-10-15T21:12:00.000000Z',
            }),
            clock_ahead: { last_at: '2026-10-16T10:00:00.000000Z', hours: 3 },
          })
        );
        return el(c.HealthLineView, { model: m.buildHealthLine(view) });
      });
      expect(attrOf(html, 'health-line', 'data-level')).toBe('red');
      expect(textOf(html, 'health-reason-backup_folder_unusable')).toBe(
        'The backup folder is missing or cannot be written to. Tell Harsh.'
      );
      expect(textOf(html, 'health-reason-backup_photos_damaged')).toBe(
        'A photo copy in the backup folder is damaged. Tell Harsh.'
      );
      expect(textOf(html, 'health-reason-backup_clock_ahead')).toBe(
        'A backup is dated in the future, so its age cannot be trusted. Tell Harsh.'
      );
      expect(textOf(html, 'health-reason-backup_photos_repaired')).toBe(
        'Photo copies were missing from the backup folder and have been copied again. Tell Harsh.'
      );
      for (const code of [
        'backup_folder_unusable',
        'backup_photos_damaged',
        'backup_clock_ahead',
      ]) {
        expect(attrOf(html, `health-reason-${code}`, 'data-tone')).toBe('red');
      }
      expect(attrOf(html, 'health-reason-backup_photos_repaired', 'data-tone')).toBe('amber');
      expect(attrOf(html, 'health-photos', 'data-tone')).toBe('red');
      expect(attrOf(html, 'health-backup', 'data-tone')).toBe('red');
      expect(attrOf(html, 'health-folder', 'data-tone')).toBe('red');
      expect(textOf(html, 'health-folder')).toContain('Cannot be used');
      expect(html).not.toContain('Something needs a look');
    });

    it('a repaired photo copy alone draws an amber card with one amber reason', async () => {
      const html = await drawCard(({ el, m, c }) =>
        el(c.HealthLineView, {
          model: m.buildHealthLine(
            ready(greenHealth({ level: 'amber', reasons: ['backup_photos_repaired'] }))
          ),
        })
      );
      expect(attrOf(html, 'health-line', 'data-level')).toBe('amber');
      expect(textOf(html, 'health-headline')).toBe('Reminder');
      expect(attrOf(html, 'health-reason-backup_photos_repaired', 'data-tone')).toBe('amber');
      expect(attrOf(html, 'health-photos', 'data-tone')).toBe('amber');
      expect(attrOf(html, 'health-folder', 'data-tone')).toBe('ok');
    });
  });
});

describe("PT-W12 the dashboard line shows yesterday's review counts (I11)", () => {
  const review: ReviewWire = {
    date: '2026-10-15',
    counts: {
      below_list_lines: 0,
      discount_over: 2,
      cash_overrides: 0,
      cancellations: 1,
      reissues: 1,
      voids: 0,
      refunds: 3,
      walkin_bills: 4,
      fine_cash_rate_away: 0,
      biller_rate_moves: 0,
      sale_type_differs: 0,
    },
    walkin: { cash_total: '4500.50', bills: 4 },
  };

  it('lists the non-zero counts in the order of the API, and the walk-in cash', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine(ready(greenHealth(), review));
    expect(line.review).toEqual({
      date: '2026-10-15',
      dayLabel: 'yesterday, 15 Oct 2026',
      items: [
        { id: 'discount_over', label: 'Bills with a large discount', count: 2 },
        { id: 'cancellations', label: 'Bills cancelled', count: 1 },
        { id: 'reissues', label: 'Bills re-issued', count: 1 },
        { id: 'refunds', label: 'Refunds given', count: 3 },
        { id: 'walkin_bills', label: 'Walk-in bills', count: 4 },
      ],
      total: 11,
      walkin: { bills: 4, cashTotal: '₹4,500.50' },
    });
  });

  it('says nothing to look at when every count is zero, and a review of an earlier day is named by its date', async () => {
    const { buildHealthLine } = await model();
    const quiet: ReviewWire = {
      date: '2026-10-12',
      counts: {},
      walkin: { cash_total: '0.00', bills: 0 },
    };
    const line = buildHealthLine(ready(greenHealth(), quiet));
    expect(line.review?.items).toEqual([]);
    expect(line.review?.total).toBe(0);
    expect(line.review?.dayLabel).toBe('12 Oct 2026');
  });

  it('no review in the last check is no review line (null), not a made-up zero; a review that could not be read is said', async () => {
    const { buildHealthLine } = await model();
    expect(buildHealthLine(ready(greenHealth(), null)).review).toBeNull();
    const failed = buildHealthLine({
      ...ready(greenHealth()),
      reviewMessage: 'The review could not be read.',
    });
    expect(failed.reviewMessage).toBe('The review could not be read.');
  });
});

describe('PT-W12 the dashboard line while it loads and when it cannot be read', () => {
  it('loading: no level, no facts, no invented "OK"', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine({
      state: 'loading',
      message: null,
      health: null,
      review: null,
      reviewMessage: null,
    });
    expect(line).toMatchObject({
      state: 'loading',
      level: null,
      facts: [],
      reasons: [],
      review: null,
    });
  });

  it('failed with nothing read before: the message, no level', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine({
      state: 'failed',
      message: 'The health of the books could not be loaded. Try again.',
      health: null,
      review: null,
      reviewMessage: null,
    });
    expect(line).toMatchObject({
      state: 'failed',
      level: null,
      message: 'The health of the books could not be loaded. Try again.',
      stale: false,
    });
  });

  it('failed after a good read: the earlier line is kept and marked as not renewed', async () => {
    const { buildHealthLine } = await model();
    const line = buildHealthLine({ ...ready(greenHealth()), state: 'failed', message: 'Offline.' });
    expect(line.state).toBe('failed');
    expect(line.stale).toBe(true);
    expect(line.level).toBe('green');
    expect(line.facts.length).toBeGreaterThan(0);
  });
});

// ---- the card

/** Draws the card on the server side of React, over fresh copies of the modules (the card and React must be the same copy). */
async function drawCard(
  build: (parts: {
    el: typeof import('react').createElement;
    m: typeof import('@/lib/healthLine');
    c: typeof import('@/app/components/DashboardHealthLine');
  }) => ReactElement
) {
  vi.resetModules();
  const [react, dom, m, c] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('@/lib/healthLine'),
    import('@/app/components/DashboardHealthLine'),
  ]);
  return dom.renderToStaticMarkup(build({ el: react.createElement, m, c }));
}
const decode = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
const plain = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
function textOf(html: string, testId: string): string {
  const found = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(
    html
  );
  if (!found) throw new Error(`no element has data-testid="${testId}"`);
  return plain(found[2]);
}
const attrOf = (html: string, testId: string, attr: string): string | null => {
  const found = new RegExp(`<\\w+[^>]*data-testid="${testId}"[^>]*>`).exec(html);
  if (!found) throw new Error(`no element has data-testid="${testId}"`);
  const value = new RegExp(`${attr}="([^"]*)"`).exec(found[0]);
  return value ? value[1] : null;
};

describe('PT-W12 the card drawn from the model', () => {
  it('green: the headline, the books, every fact with its tone, and no reason list', async () => {
    const html = await drawCard(({ el, m, c }) =>
      el(c.HealthLineView, { model: m.buildHealthLine(ready(greenHealth())) })
    );
    expect(attrOf(html, 'health-line', 'data-level')).toBe('green');
    expect(textOf(html, 'health-headline')).toBe('All well');
    expect(textOf(html, 'health-books')).toContain('Books');
    expect(textOf(html, 'health-books')).toContain('OK at 02:17');
    expect(textOf(html, 'health-backup')).toContain('10 hours ago');
    expect(textOf(html, 'health-database')).toContain('393 MB of 2 GB');
    expect(textOf(html, 'health-folder')).toContain('1.16 GB · 83 files');
    expect(textOf(html, 'health-download')).toContain('5 days ago');
    expect(textOf(html, 'health-pull')).toContain('2 days ago');
    expect(html).not.toContain('data-testid="health-reasons"');
  });

  it('red: the level is red, each reason is listed with its code and colour, the failing fact is red', async () => {
    const html = await drawCard(({ el, m, c }) => {
      const view = ready(
        greenHealth({
          level: 'red',
          reasons: ['dump_stale', 'download_amber'],
          db_dump: { last_at: '2026-10-14T01:10:00.000000Z', age_hours: 30.5 },
          download: {
            state: 'amber',
            from: 'last_download',
            reference_date: '2026-09-12',
            age_days: 33,
          },
        })
      );
      return el(c.HealthLineView, { model: m.buildHealthLine(view) });
    });
    expect(attrOf(html, 'health-line', 'data-level')).toBe('red');
    expect(textOf(html, 'health-headline')).toBe('Problem');
    expect(attrOf(html, 'health-backup', 'data-tone')).toBe('red');
    expect(attrOf(html, 'health-download', 'data-tone')).toBe('amber');
    expect(textOf(html, 'health-reason-dump_stale')).toBe(
      'The last backup is too old. Tell Harsh.'
    );
    expect(attrOf(html, 'health-reason-dump_stale', 'data-tone')).toBe('red');
    expect(textOf(html, 'health-reason-download_amber')).toBe(
      'It is time to use Download everything.'
    );
    expect(attrOf(html, 'health-reason-download_amber', 'data-tone')).toBe('amber');
  });

  it('the review counts and the walk-in cash are on the card', async () => {
    const html = await drawCard(({ el, m, c }) => {
      const review: ReviewWire = {
        date: '2026-10-15',
        counts: { cancellations: 1, refunds: 3 },
        walkin: { cash_total: '4500.50', bills: 4 },
      };
      return el(c.HealthLineView, {
        model: m.buildHealthLine(ready(greenHealth(), review)),
      });
    });
    expect(textOf(html, 'health-review')).toContain('yesterday, 15 Oct 2026');
    expect(textOf(html, 'review-cancellations')).toContain('1');
    expect(textOf(html, 'review-refunds')).toContain('3');
    expect(html).not.toContain('data-testid="review-voids"');
    expect(textOf(html, 'review-walkin-cash')).toContain('₹4,500.50');
  });

  it('loading and failed: a plain sentence, a Try again button on a failure, and no level', async () => {
    const loading = await drawCard(({ el, m, c }) =>
      el(c.HealthLineView, {
        model: m.buildHealthLine({
          state: 'loading',
          message: null,
          health: null,
          review: null,
          reviewMessage: null,
        }),
      })
    );
    expect(attrOf(loading, 'health-line', 'data-level')).toBe('unknown');
    expect(plain(loading)).toContain('Checking the books');
    const failed = await drawCard(({ el, m, c }) =>
      el(c.HealthLineView, {
        model: m.buildHealthLine({
          state: 'failed',
          message: 'The health of the books could not be loaded. Try again.',
          health: null,
          review: null,
          reviewMessage: null,
        }),
        onRetry: () => undefined,
      })
    );
    expect(textOf(failed, 'health-error')).toContain('could not be loaded');
    expect(failed).toContain('data-testid="health-retry"');
  });
});

// ---- the store that reads the two calls

async function loadServer() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const server = new FakeBooksApi();
  vi.stubGlobal('fetch', server.fetch);
  const [books, cache, client] = await Promise.all([
    import('@/lib/cache/booksServer'),
    import('@/lib/cache/cache'),
    import('@/lib/api/client'),
  ]);
  let logout: () => void = () => undefined;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const books1 = books.createBooksServer({
    api: client.api,
    cache: cache.rowCache,
    registerLogoutHook: (hook) => {
      logout = hook;
      return () => undefined;
    },
    setTimer: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  return {
    server,
    books: books1,
    cache: cache.rowCache,
    logout: () => logout(),
    timers,
    HEALTH_REFRESH_MS: books.HEALTH_REFRESH_MS,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('PT-W12 the store: the dashboard line is two reads, kept current', () => {
  it('reads the line and the newest check when it is watched, and keeps the review counts', async () => {
    const w = await loadServer();
    w.server.health = greenHealth({ level: 'amber', reasons: ['download_amber'] });
    w.server.review = {
      date: '2026-10-15',
      counts: { refunds: 2 },
      walkin: { cash_total: '10.00', bills: 1 },
    };
    const stop = w.books.watchHealth();
    await w.books.idle();
    const view = w.books.healthView();
    expect(view.state).toBe('ready');
    expect(view.health?.level).toBe('amber');
    expect(view.review?.counts.refunds).toBe(2);
    expect(w.server.seen.map((c) => [c.path, c.query])).toEqual([
      ['/v1/dashboard/health', {}],
      ['/v1/health/checks', { limit: '1' }],
    ]);
    stop();
  });

  it('reads again every five minutes while watched, and stops when nobody watches', async () => {
    const w = await loadServer();
    const stop = w.books.watchHealth();
    await w.books.idle();
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0].ms).toBe(w.HEALTH_REFRESH_MS);
    expect(w.HEALTH_REFRESH_MS).toBe(5 * 60 * 1000);
    w.server.health = greenHealth({ level: 'red', reasons: ['dump_stale'] });
    w.timers[0].fn();
    await w.books.idle();
    await vi.waitFor(() => expect(w.books.healthView().health?.level).toBe('red'));
    expect(w.timers.length).toBeGreaterThanOrEqual(2);
    stop();
    expect(w.timers[w.timers.length - 1].cleared).toBe(true);
  });

  it('two screens watching read once; the review failing does not take the line away', async () => {
    const w = await loadServer();
    w.server.failChecks = { status: 500, times: 1 };
    const a = w.books.watchHealth();
    const b = w.books.watchHealth();
    await w.books.idle();
    expect(w.server.count('/v1/dashboard/health')).toBe(1);
    const view = w.books.healthView();
    expect(view.state).toBe('ready');
    expect(view.health).not.toBeNull();
    expect(view.reviewMessage).not.toBeNull();
    a();
    b();
  });

  it('a failed read says so, keeps the earlier line, and is read again by reloadHealth', async () => {
    const w = await loadServer();
    await w.books.reloadHealth();
    expect(w.books.healthView().state).toBe('ready');
    w.server.failHealth = { status: 500, times: 1 };
    await w.books.reloadHealth();
    const failed = w.books.healthView();
    expect(failed.state).toBe('failed');
    expect(failed.message).not.toBeNull();
    expect(failed.health).not.toBeNull();
    await w.books.reloadHealth();
    expect(w.books.healthView().state).toBe('ready');
  });

  it('only the owner reads the line: a biller is refused and the view says it could not be read', async () => {
    const w = await loadServer();
    w.server.role = 'biller';
    await w.books.reloadHealth();
    const view = w.books.healthView();
    expect(view.state).toBe('failed');
    expect(view.health).toBeNull();
  });

  it('a logout forgets the line and a read that was on its way is thrown away', async () => {
    const w = await loadServer();
    await w.books.reloadHealth();
    expect(w.books.healthView().health).not.toBeNull();
    w.logout();
    expect(w.books.healthView()).toMatchObject({ state: 'idle', health: null, review: null });
    const hold = w.books.reloadHealth();
    w.logout();
    await hold;
    expect(w.books.healthView().health).toBeNull();
  });
});

describe('PT-W12 the store: the cash book of a range', () => {
  it('is read once for the range, shared by two watchers, and read again when the receipts change', async () => {
    const w = await loadServer();
    const { totalRow } = await import('./support/books-server');
    w.server.dailyTotals = [totalRow('2026-10-15', 'Cash', '10.00', '0.00', '10.00')];
    const a = w.books.watchDailyTotals('2026-10-15', '2026-10-15');
    const b = w.books.watchDailyTotals('2026-10-15', '2026-10-15');
    await w.books.idle();
    expect(w.server.count('/v1/daily-totals')).toBe(1);
    expect(w.books.dailyTotals('2026-10-15', '2026-10-15')).toMatchObject({
      state: 'ready',
      loaded: true,
    });
    expect(w.books.dailyTotals('2026-10-15', '2026-10-15').rows).toHaveLength(1);
    // a receipt arrives
    const { receiptRow } = await import('./support/money-rows');
    w.cache.merge('receipts', [
      receiptRow(1, '00000000-0000-4000-8000-000000000001', { amount: '5.00' }),
    ]);
    await w.books.idle();
    await vi.waitFor(() => expect(w.server.count('/v1/daily-totals')).toBe(2));
    a();
    b();
    // nobody watches: another receipt reads nothing
    w.cache.merge('receipts', [
      receiptRow(2, '00000000-0000-4000-8000-000000000001', { amount: '6.00' }),
    ]);
    await w.books.idle();
    expect(w.server.count('/v1/daily-totals')).toBe(2);
  });

  it('a biller asking for more than today and yesterday is refused and the view says it failed', async () => {
    const w = await loadServer();
    w.server.role = 'biller';
    await w.books.reloadDailyTotals('2026-10-01', '2026-10-15');
    expect(w.books.dailyTotals('2026-10-01', '2026-10-15')).toMatchObject({
      state: 'failed',
      loaded: false,
    });
  });

  it('a failed reload keeps the rows of the read before it', async () => {
    const w = await loadServer();
    const { totalRow } = await import('./support/books-server');
    w.server.dailyTotals = [totalRow('2026-10-15', 'Cash', '10.00', '0.00', '10.00')];
    await w.books.reloadDailyTotals('2026-10-15', '2026-10-15');
    w.server.failTotals = { status: 500, times: 1 };
    await w.books.reloadDailyTotals('2026-10-15', '2026-10-15');
    const view = w.books.dailyTotals('2026-10-15', '2026-10-15');
    expect(view.state).toBe('failed');
    expect(view.rows).toHaveLength(1);
    expect(view.loaded).toBe(true);
  });
});
