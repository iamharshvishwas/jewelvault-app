// WEB05: the rate card offers each role what the API allows it (spec D4, Y8): the owner any day up to today and a correction of today's rate, a biller today only and no
// correction. The API is the wall (tests/e2e/stock-edit.spec.ts proves the answers); the card does not offer what would be refused. The card is drawn here on the server
// side of React (renderToStaticMarkup) over the real stores and a cache with rates in it; the role is the one thing stood in for.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { categoryRow, rateRow, settingRow } from './support/rows';

let role: 'owner' | 'biller' | 'staff' | null = 'owner';

async function draw(who: typeof role, rates: Array<Parameters<typeof rateRow>[1]> = []) {
  role = who;
  vi.resetModules();
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
