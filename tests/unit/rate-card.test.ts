// WEB05: the rate card offers each role what the API allows it (spec D4, Y8): the owner any day up to today and a correction of today's rate, a biller today only and no
// correction. The API is the wall (tests/e2e/stock-edit.spec.ts proves the answers); the card does not offer what would be refused. The card is drawn here on the server
// side of React (renderToStaticMarkup) over the real stores and a cache with rates in it; the role is the one thing stood in for.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryRow, rateRow, settingRow } from './support/rows';

let role: 'owner' | 'biller' | 'staff' | null = 'owner';

async function draw(
  who: typeof role,
  rates: Array<Parameters<typeof rateRow>[1]> = [],
  props: Record<string, unknown> = {}
) {
  role = who;
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => ({ role }),
  }));
  const [{ rowCache }, settings, { default: Card }] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/settingsStore'),
    import('@/app/components/DashboardRateCard'),
  ]);
  rowCache.merge('categories', [categoryRow(1, 'Ring', 'RING')]);
  rowCache.merge('settings', [
    settingRow('materials', [
      { name: 'Gold', purities: ['18K', '22K'] },
      { name: 'Silver', purities: ['925'] },
      { name: 'Platinum', purities: ['950'] },
    ]),
  ]);
  const today = settings.businessToday();
  rowCache.merge(
    'daily-rates',
    rates.map((over, n) => rateRow(n + 1, { rate_date: today, ...over }))
  );
  return { html: renderToStaticMarkup(React.createElement(Card, props)), today };
}

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
});

describe('PT-W5 the rate card offers each role what the API allows it (D4, Y8)', () => {
  it('draws nothing for a role that has no rates to enter, and nothing before the role is known', async () => {
    expect((await draw('staff')).html).toBe('');
    expect((await draw(null)).html).toBe('');
  });

  it('shows a rate for each purity of Gold and Silver of the materials setting (not of other materials), each with its own label', async () => {
    const { html } = await draw('owner');
    for (const label of [
      'Gold 18K rate (per gram)',
      'Gold 22K rate (per gram)',
      'Silver 925 rate (per gram)',
    ])
      expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('Platinum');
    expect(html).toContain('Save Rates');
  });

  it('the owner can pick a day, up to today; a biller sees today only and no day to pick', async () => {
    const owner = await draw('owner');
    expect(owner.html).toContain('type="date"');
    expect(owner.html).toContain(`max="${owner.today}"`);
    const biller = await draw('biller');
    expect(biller.html).not.toContain('type="date"');
    expect(biller.html).toContain('Rates for today');
  });

  it('a rate that has a row for today is open to the owner to correct, and closed to a biller (only the owner corrects, Y8)', async () => {
    const rates = [{ material: 'Gold' as const, purity: '22K', rate_per_gram: '7350.00' }];
    const owner = await draw('owner', rates);
    const open =
      /<input[^>]*aria-label="Gold 22K rate \(per gram\)"[^>]*>/.exec(owner.html)?.[0] ?? '';
    expect(open).toContain('value="7350.00"');
    expect(open).not.toContain('disabled');

    const biller = await draw('biller', rates);
    const closed =
      /<input[^>]*aria-label="Gold 22K rate \(per gram\)"[^>]*>/.exec(biller.html)?.[0] ?? '';
    expect(closed).toContain('value="7350.00"');
    expect(closed).toContain('disabled');
    expect(biller.html).toContain('Only the owner can correct it');
    // a purity with no row for today is open to the biller
    const free =
      /<input[^>]*aria-label="Gold 18K rate \(per gram\)"[^>]*>/.exec(biller.html)?.[0] ?? '';
    expect(free).not.toContain('disabled');
  });

  it('starts from the last rate when the day has none, and says nothing is saved until it is typed', async () => {
    const { html } = await draw('owner', [
      { material: 'Gold', purity: '22K', rate_per_gram: '7300.00', rate_date: '2026-01-02' },
    ]);
    const input = /<input[^>]*aria-label="Gold 22K rate \(per gram\)"[^>]*>/.exec(html)?.[0] ?? '';
    expect(input).toContain('value="7300.00"');
    expect(input).not.toContain('disabled');
  });
});

// ------------------------------------------------------------------------------------------------ WEB16

/** The text of a piece of markup: tags gone, the escaped apostrophe back. */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');
/** The words under the rate of one purity (`data-testid="rate-gold-22k-state"`). */
const stateOf = (html: string, id: string) =>
  textOf(new RegExp(`data-testid="${id}-state"[^>]*>(.*?)</p>`).exec(html)?.[1] ?? '').trim();

describe('PT-W16 the rate card shows the rate rows with their real dates (D4)', () => {
  it('says for each purity whether its rate is confirmed today, or of which day it is, or that there is none', async () => {
    const { html } = await draw('owner', [
      { material: 'Gold', purity: '22K', rate_per_gram: '7350.00' }, // today
      { material: 'Gold', purity: '18K', rate_per_gram: '5800.00', rate_date: '2026-01-02' },
    ]);
    expect(stateOf(html, 'rate-gold-22k')).toBe('Confirmed today');
    expect(stateOf(html, 'rate-gold-18k')).toBe('Rate of 2 Jan 2026, not confirmed today');
    expect(stateOf(html, 'rate-silver-925')).toBe('No rate yet');
  });

  it('on another day the owner picked it says which day the rate is of, not "today"', async () => {
    // the rate of the day shown is the row of that day; the last rate before it is only a start
    const { html, today } = await draw('owner', [
      { material: 'Gold', purity: '22K', rate_per_gram: '7350.00', rate_date: '2026-01-02' },
    ]);
    // the card opens on today: an older rate is a suggestion
    expect(today > '2026-01-02').toBe(true);
    expect(stateOf(html, 'rate-gold-22k')).toContain('2 Jan 2026');
    expect(stateOf(html, 'rate-gold-22k')).not.toContain('Confirmed today');
  });

  it('"Last updated" is the date of the newest rate it shows, never a made-up today', async () => {
    const { html } = await draw('owner', [
      { material: 'Gold', purity: '22K', rate_per_gram: '7350.00', rate_date: '2026-01-02' },
    ]);
    expect(textOf(html)).toContain('Last updated: 2 Jan 2026');
  });

  it('names the purities that have an old rate and none for today; one that never had a rate says so on its own row and is not listed', async () => {
    const { html } = await draw('owner', [
      { material: 'Gold', purity: '22K', rate_per_gram: '7350.00' },
      { material: 'Gold', purity: '18K', rate_per_gram: '5800.00', rate_date: '2026-01-02' },
      { material: 'Silver', purity: '925', rate_per_gram: '88.00', rate_date: '2026-01-02' },
    ]);
    expect(textOf(html)).toContain('Not confirmed today: Gold 18K, Silver 925');
    const none = await draw('biller', [
      { material: 'Gold', purity: '18K' },
      { material: 'Gold', purity: '22K' },
      { material: 'Silver', purity: '925' },
    ]);
    expect(textOf(none.html)).not.toContain('Not confirmed today');
    const never = await draw('owner', [{ material: 'Gold', purity: '22K' }]);
    expect(textOf(never.html)).not.toContain('Not confirmed today'); // 18K and Silver 925 never had a rate
    expect(stateOf(never.html, 'rate-gold-18k')).toBe('No rate yet');
  });
});

describe('PT-W16 the card on the billing screen confirms the rates the bill uses, for today (D4, Y8)', () => {
  const asked = [
    { material: 'Gold' as const, purity: '22K' },
    { material: 'Gold' as const, purity: 'Custom', onBill: '6000' },
  ];

  it('shows only the purities asked about, today only (even for the owner), and a button that confirms', async () => {
    for (const who of ['biller', 'owner'] as const) {
      const { html } = await draw(
        who,
        [{ material: 'Gold', purity: '22K', rate_per_gram: '6900.00', rate_date: '2026-01-02' }],
        { confirmToday: asked }
      );
      expect(html).toContain('data-testid="rate-confirm"');
      expect(html).not.toContain('type="date"');
      expect(textOf(html)).toContain("Confirm today's rates");
      expect(textOf(html)).not.toContain('Save Rates');
      expect(html).toContain('aria-label="Gold 22K rate (per gram)"');
      expect(html).toContain('aria-label="Gold Custom rate (per gram)"'); // a purity the settings do not list is still asked about
      expect(html).not.toContain('aria-label="Gold 18K rate (per gram)"');
      expect(html).not.toContain('aria-label="Silver 925 rate (per gram)"');
    }
  });

  it('starts each from the last rate (with its date), else from what the line carries', async () => {
    const { html } = await draw(
      'biller',
      [{ material: 'Gold', purity: '22K', rate_per_gram: '6900.00', rate_date: '2026-01-02' }],
      { confirmToday: asked }
    );
    const value = (label: string) =>
      new RegExp(`<input[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? '';
    expect(value('Gold 22K rate \\(per gram\\)')).toContain('value="6900.00"');
    expect(value('Gold Custom rate \\(per gram\\)')).toContain('value="6000"');
    expect(stateOf(html, 'rate-gold-22k')).toBe('Rate of 2 Jan 2026, not confirmed today');
    expect(stateOf(html, 'rate-gold-custom')).toBe('No rate yet');
  });

  it('draws nothing for a role that cannot enter a rate', async () => {
    expect((await draw('staff', [], { confirmToday: asked })).html).toBe('');
  });
});
