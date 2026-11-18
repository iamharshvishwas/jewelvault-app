// WEB05: the rate card offers each role what the API allows it (spec D4, Y8): the owner any day up to today and a correction of today's rate, a biller today only and no
// correction. The API is the wall (tests/e2e/stock-edit.spec.ts proves the answers); the card does not offer what would be refused. The card is drawn here on the server
// side of React (renderToStaticMarkup) over the real stores and a cache with rates in it; the role is the one thing stood in for.
// Access and roles (Task 18): the card asks for ticks and not for a role key. `rate_enter` is what it needs to be drawn at all, `back_date` is what gives the day to pick (without it
// the card is for today), `rate_correct` is what lets a rate that has a row for today be changed. The words of a refusal say "your role", not "the owner".
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryRow, rateRow, settingRow } from './support/rows';
import { sessionFor, type RoleSpec } from './support/access';

let role: RoleSpec | null = 'owner';

async function draw(who: typeof role, rates: Array<Parameters<typeof rateRow>[1]> = []) {
  role = who;
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => sessionFor(role),
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
  return { html: renderToStaticMarkup(React.createElement(Card)), today };
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
    expect(biller.html).toContain('Your role cannot correct it');
    expect(biller.html).not.toContain('Only the owner');
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

describe('Task 18: the card follows the ticks of the role, not its key', () => {
  const rates = [{ material: 'Gold' as const, purity: '22K', rate_per_gram: '7350.00' }];
  const input = (html: string, label: string) =>
    new RegExp(`<input[^>]*aria-label="${label} rate \\(per gram\\)"[^>]*>`).exec(html)?.[0] ?? '';

  it('is drawn for whoever may enter a rate, and for nobody else: not Staff, not a role with no tick, not a role that corrects but cannot enter', async () => {
    expect((await draw({ ticks: ['rate_enter'] })).html).toContain('Save Rates');
    expect((await draw({ ticks: [] })).html).toBe('');
    expect((await draw({ ticks: ['rate_correct', 'back_date'] })).html).toBe('');
  });

  it('a role that enters and corrects but may not back-date has no day to pick, and can correct the rate of today in place', async () => {
    const { html } = await draw({ ticks: ['rate_enter', 'rate_correct'] }, rates);
    expect(html).not.toContain('type="date"');
    expect(html).toContain('Rates for today');
    expect(html).toContain(' · your role enters the rate of today only');
    const open = input(html, 'Gold 22K');
    expect(open).toContain('value="7350.00"');
    expect(open).not.toContain('disabled');
    expect(html).not.toContain('Your role cannot correct it');
  });

  it("a role that may back-date has the day to pick, up to today, and cannot correct today's rate unless it holds the Correct tick", async () => {
    const withoutCorrect = await draw({ ticks: ['rate_enter', 'back_date'] }, rates);
    expect(withoutCorrect.html).toContain('type="date"');
    expect(withoutCorrect.html).toContain(`max="${withoutCorrect.today}"`);
    expect(withoutCorrect.html).not.toContain('your role enters the rate of today only');
    const closed = input(withoutCorrect.html, 'Gold 22K');
    expect(closed).toContain('value="7350.00"');
    expect(closed).toContain('disabled');
    expect(withoutCorrect.html).toContain('Your role cannot correct it');

    const withCorrect = await draw({ ticks: ['rate_enter', 'back_date', 'rate_correct'] }, rates);
    expect(withCorrect.html).toContain('type="date"');
    expect(input(withCorrect.html, 'Gold 22K')).not.toContain('disabled');
  });

  it('the words the owner reads do not change: the day to pick, a rate that is open to correct, and no "your role" anywhere', async () => {
    const { html } = await draw('owner', rates);
    expect(html).toContain('Rates for');
    expect(html).toContain('type="date"');
    expect(html).not.toContain('your role');
    expect(html).not.toContain('Your role');
    expect(input(html, 'Gold 22K')).not.toContain('disabled');
  });
});
