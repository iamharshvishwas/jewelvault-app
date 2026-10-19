import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HealthView } from '@/lib/cache/booksServer';
import type { DownloadState } from '@/lib/cache/downloadServer';
import { DownloadCardView } from '@/app/components/DashboardDownloadCard';
import { buildDownloadCard } from '@/lib/healthLine';
import { greenHealth } from './support/books-server';

// T-E04 / T-R05 (the card, B3, I12, O53; task WEB12b): the owner's dashboard shows a "Download everything" card with the date of the last download; from 28 days after it (or after the first
// night the system ran, for the first download) the card turns amber and says it is time; the line turns red after 35 days. The API counts the whole Asia/Kolkata days and says the state
// (readHealth); the card repeats it and decides no threshold. After a download the card shows the file's name and the state the API gives next.

const view = (download: Partial<ReturnType<typeof greenHealth>['download']>): HealthView => ({
  state: 'ready',
  message: null,
  health: greenHealth({ download: { ...greenHealth().download, ...download } }),
  review: null,
  reviewMessage: null,
});

describe("T-R05 the card's model repeats what the API computed", () => {
  it('a download five days ago: green, with its date and "5 days ago", no reminder', () => {
    const card = buildDownloadCard(
      view({ state: 'ok', from: 'last_download', reference_date: '2026-10-10', age_days: 5 })
    );
    expect(card).toMatchObject({
      state: 'ready',
      tone: 'ok',
      date: '10 Oct 2026',
      last: '5 days ago',
      reminder: null,
    });
  });

  it('day 28 is amber and says it is time; day 35 is still amber', () => {
    for (const age of [28, 35]) {
      const card = buildDownloadCard(
        view({ state: 'amber', from: 'last_download', reference_date: '2026-09-17', age_days: age })
      );
      expect(card).toMatchObject({
        tone: 'amber',
        last: `${age} days ago`,
        reminder: 'It is time to use Download everything.',
      });
    }
  });

  it('day 36 is red and says to do it now', () => {
    const card = buildDownloadCard(
      view({ state: 'red', from: 'last_download', reference_date: '2026-09-09', age_days: 36 })
    );
    expect(card).toMatchObject({
      tone: 'red',
      reminder: 'Download everything has not been used for too long. Do it now.',
    });
  });

  it('with no download yet it counts from the first night the system ran: "Not done yet" and the days since', () => {
    const card = buildDownloadCard(
      view({ state: 'amber', from: 'first_night', reference_date: '2026-09-17', age_days: 28 })
    );
    expect(card).toMatchObject({
      tone: 'amber',
      last: 'Not done yet',
      date: null,
      since: '28 days since the first night',
    });
  });

  it('today and yesterday are said in words', () => {
    expect(
      buildDownloadCard(
        view({ state: 'ok', from: 'last_download', reference_date: '2026-10-15', age_days: 0 })
      ).last
    ).toBe('Today');
    expect(
      buildDownloadCard(
        view({ state: 'ok', from: 'last_download', reference_date: '2026-10-14', age_days: 1 })
      ).last
    ).toBe('Yesterday');
  });

  it('before the line is read the card says so, and when the read failed it says that, with no date made up', () => {
    const loading: HealthView = {
      state: 'loading',
      message: null,
      health: null,
      review: null,
      reviewMessage: null,
    };
    expect(buildDownloadCard(loading)).toMatchObject({
      state: 'loading',
      tone: 'unknown',
      date: null,
    });
    const failed: HealthView = {
      state: 'failed',
      message: 'The line could not be read.',
      health: null,
      review: null,
      reviewMessage: null,
    };
    expect(buildDownloadCard(failed)).toMatchObject({
      state: 'failed',
      tone: 'unknown',
      date: null,
    });
  });
});

describe('T-E04 the card is drawn from the model and the state of the download', () => {
  const card = buildDownloadCard(
    view({ state: 'amber', from: 'last_download', reference_date: '2026-09-17', age_days: 28 })
  );
  const draw = (state: DownloadState) =>
    renderToStaticMarkup(
      React.createElement(DownloadCardView, {
        card,
        state,
        onDownload: () => undefined,
        onDismiss: () => undefined,
      })
    );

  it('idle: the date, the reminder, and a button that can be pressed', () => {
    const html = draw({ status: 'idle' });
    expect(html).toContain('data-testid="download-card"');
    expect(html).toContain('data-tone="amber"');
    expect(html).toContain('17 Sep 2026');
    expect(html).toContain('28 days ago');
    expect(html).toContain('It is time to use Download everything.');
    expect(html).toMatch(/<button[^>]*data-testid="download-button"[^>]*>/);
    expect(html).not.toMatch(/data-testid="download-button"[^>]*disabled/);
    expect(html).not.toContain('data-testid="download-status"');
  });

  it('working: the sentence of the step, the button off', () => {
    const html = draw({ status: 'working', step: 'files', text: 'Making the files…' });
    expect(html).toContain('Making the files…');
    expect(html).toMatch(
      /data-testid="download-button"[^>]*disabled|disabled=""[^>]*data-testid="download-button"/
    );
  });

  it('done: the name of the file, how much is in it, and where to keep it', () => {
    const html = draw({
      status: 'done',
      filename: 'download-everything-2026-10-19.zip',
      date: '2026-10-19',
      files: 12,
      rows: 3456,
    });
    expect(html).toContain('data-testid="download-status"');
    expect(html).toContain('download-everything-2026-10-19.zip');
    expect(html).toMatch(/12 files/);
    expect(html).toMatch(/3,456 rows/);
    expect(html).toMatch(/USB stick/);
  });

  it('failed: the sentence, as an alert, with a way to put it away; the file that was saved is said', () => {
    const html = draw({
      status: 'failed',
      message: 'The file was saved to your computer, but it could not be recorded.',
      fileSaved: true,
    });
    expect(html).toMatch(
      /role="alert"[^>]*data-testid="download-error"|data-testid="download-error"[^>]*role="alert"/
    );
    expect(html).toContain('The file was saved to your computer, but it could not be recorded.');
    expect(html).toContain('data-testid="download-dismiss"');
  });

  it('has no sample build any more: the button is on while idle and no note says there is no server (WEB15)', () => {
    const html = draw({ status: 'idle' });
    expect(html).not.toMatch(/sample/i);
    expect(html).not.toContain('download-preview-note');
  });
});
