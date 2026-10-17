// WEB03: the row cache of the website (src/lib/cache): the stamps it compares as microsecond numbers parsed from the exact text, and the merge by id
// that keeps the greater `updated_at` (spec C3, C4). The hydrate that fills it is tests/unit/hydrate.test.ts; the stores that read it are
// tests/unit/stock-stores.test.ts.
import { describe, expect, it } from 'vitest';
import { createRowCache, KEY_FIELD, CacheDataError } from '@/lib/cache/cache';
import {
  compareStamps,
  formatStamp,
  isStamp,
  stampMicros,
  stampMinusSeconds,
} from '@/lib/cache/stamp';
import { SYNC_RESOURCES } from '@/lib/api/types';
import { at, designRow, settingRow, skuPrivateRow, skuRow, uuid } from './support/rows';

describe('T-E05 stamps are microsecond numbers parsed from the exact text (C4)', () => {
  it('reads the six decimals: two stamps a microsecond apart are two different numbers', () => {
    const a = stampMicros('2026-10-15T09:41:12.123456Z');
    const b = stampMicros('2026-10-15T09:41:12.123457Z');
    expect(b - a).toBe(1);
    expect(compareStamps('2026-10-15T09:41:12.123457Z', '2026-10-15T09:41:12.123456Z')).toBe(1);
    expect(compareStamps('2026-10-15T09:41:12.123456Z', '2026-10-15T09:41:12.123456Z')).toBe(0);
    // negative control: a Date keeps milliseconds only, so it cannot tell these two apart
    expect(new Date('2026-10-15T09:41:12.123456Z').getTime()).toBe(
      new Date('2026-10-15T09:41:12.123457Z').getTime()
    );
  });

  it('is an exact whole number: a year-2026 stamp is far below 2^53 microseconds', () => {
    const micros = stampMicros('2026-10-15T09:41:12.123456Z');
    expect(Number.isSafeInteger(micros)).toBe(true);
    expect(micros).toBe(Date.UTC(2026, 9, 15, 9, 41, 12) * 1000 + 123456);
  });

  it('refuses anything that is not the six-decimal text with a Z', () => {
    for (const bad of [
      '2026-10-15T09:41:12Z',
      '2026-10-15T09:41:12.123Z',
      '2026-10-15T09:41:12.1234567Z',
      '2026-10-15 09:41:12.123456',
      '2026-10-15T09:41:12.123456+05:30',
      '2026-02-30T09:41:12.123456Z',
      '2026-10-15T25:41:12.123456Z',
      '2026-10-15',
      '',
    ]) {
      expect(isStamp(bad), bad).toBe(false);
      expect(() => stampMicros(bad), bad).toThrow();
    }
    expect(isStamp(1760521272123)).toBe(false);
    expect(isStamp(null)).toBe(false);
  });

  it('writes a stamp back as the exact text, six decimals kept', () => {
    for (const text of [
      '2026-10-15T09:41:12.123456Z',
      '2026-10-15T00:00:00.000000Z',
      '2026-12-31T23:59:59.999999Z',
      '2026-10-15T09:41:12.000001Z',
    ]) {
      expect(formatStamp(stampMicros(text))).toBe(text);
    }
  });

  it('subtracts seconds exactly, across a minute, an hour and a day, and keeps the six decimals (the 30 s of the first poll, C3)', () => {
    expect(stampMinusSeconds('2026-10-15T09:41:42.500000Z', 30)).toBe(
      '2026-10-15T09:41:12.500000Z'
    );
    expect(stampMinusSeconds('2026-10-15T09:41:12.123456Z', 30)).toBe(
      '2026-10-15T09:40:42.123456Z'
    );
    expect(stampMinusSeconds('2026-10-15T00:00:10.000007Z', 30)).toBe(
      '2026-10-14T23:59:40.000007Z'
    );
    expect(stampMinusSeconds('2026-01-01T00:00:00.000000Z', 30)).toBe(
      '2025-12-31T23:59:30.000000Z'
    );
  });
});

describe('T-E05 the cache merges by id and keeps the greater updated_at (C3, C4)', () => {
  it('stores a row, and a newer copy of the same id replaces it', () => {
    const cache = createRowCache();
    const old = designRow(1, { name: 'old', updated_at: at(10) });
    const fresh = designRow(1, { name: 'new', updated_at: at(20) });
    cache.merge('designs', [old]);
    cache.merge('designs', [fresh]);
    expect(cache.count('designs')).toBe(1);
    expect(cache.get('designs', old.id)?.name).toBe('new');
  });

  it('an older copy of the same id never replaces a newer one, whatever order they arrive in (a row changed during a hydrate arrives twice)', () => {
    const cache = createRowCache();
    const newer = designRow(1, { name: 'new', updated_at: at(20) });
    const older = designRow(1, { name: 'old', updated_at: at(10) });
    cache.merge('designs', [newer]);
    expect(cache.merge('designs', [older])).toBe(0);
    expect(cache.get('designs', newer.id)?.name).toBe('new');
    // and inside one batch
    const other = createRowCache();
    other.merge('designs', [newer, older]);
    expect(other.get('designs', newer.id)?.name).toBe('new');
  });

  it('compares the stamps as microseconds: a difference in the last decimal decides (negative control: comparing Dates would call them equal)', () => {
    const cache = createRowCache();
    cache.merge('designs', [designRow(1, { name: 'a', updated_at: at(10, 123456) })]);
    cache.merge('designs', [designRow(1, { name: 'b', updated_at: at(10, 123457) })]);
    expect(cache.get('designs', uuid(301))?.name).toBe('b');
    cache.merge('designs', [designRow(1, { name: 'c', updated_at: at(10, 123455) })]);
    expect(cache.get('designs', uuid(301))?.name).toBe('b');
  });

  it('the same stamp: the copy that arrived last stays (the same row read twice is the same row)', () => {
    const cache = createRowCache();
    cache.merge('designs', [designRow(1, { name: 'first', updated_at: at(10) })]);
    cache.merge('designs', [designRow(1, { name: 'second', updated_at: at(10) })]);
    expect(cache.get('designs', uuid(301))?.name).toBe('second');
  });

  it('keys each resource by its own key: setting_key for settings, sku_id for sku-private, id for the rest', () => {
    expect(KEY_FIELD.settings).toBe('setting_key');
    expect(KEY_FIELD['sku-private']).toBe('sku_id');
    for (const resource of SYNC_RESOURCES) {
      if (resource !== 'settings' && resource !== 'sku-private')
        expect(KEY_FIELD[resource], resource).toBe('id');
    }
    const cache = createRowCache();
    cache.merge('settings', [
      settingRow('business', { displayName: 'A' }, 1),
      settingRow('estimate', { prefix: 'JV' }, 1),
    ]);
    cache.merge('settings', [settingRow('business', { displayName: 'B' }, 5)]);
    cache.merge('sku-private', [skuPrivateRow(1, '10.125')]);
    expect(cache.count('settings')).toBe(2);
    expect((cache.get('settings', 'business')?.value as { displayName: string }).displayName).toBe(
      'B'
    );
    expect(cache.get('sku-private', uuid(1001))?.original_net_weight).toBe('10.125');
  });

  it('refuses a row with no key or no readable updated_at, and says which resource, never the row', () => {
    const cache = createRowCache();
    const noStamp = { ...designRow(1), updated_at: '2026-10-15 09:00:00' };
    expect(() => cache.merge('designs', [noStamp])).toThrow(CacheDataError);
    expect(() => cache.merge('designs', [{ ...designRow(1), id: undefined } as never])).toThrow(
      CacheDataError
    );
    expect(() => cache.merge('designs', [null as never])).toThrow(CacheDataError);
    try {
      cache.merge('designs', [{ ...designRow(1, { name: 'SECRET NAME' }), updated_at: 'garbage' }]);
    } catch (error) {
      expect((error as Error).message).toContain('designs');
      expect((error as Error).message).not.toContain('SECRET NAME');
    }
    expect(cache.count('designs')).toBe(0);
  });

  it('rows() lists every row, the same array until something changes', () => {
    const cache = createRowCache();
    cache.merge('skus', [skuRow(1, 1), skuRow(2, 1)]);
    const first = cache.rows('skus');
    expect(first).toHaveLength(2);
    expect(cache.rows('skus')).toBe(first);
    cache.merge('skus', [skuRow(1, 1, { updated_at: at(1) })]); // older: nothing changes
    expect(cache.rows('skus')).toBe(first);
    cache.merge('skus', [skuRow(3, 1)]);
    expect(cache.rows('skus')).not.toBe(first);
    expect(cache.rows('skus')).toHaveLength(3);
  });

  it('counts a version for each resource, moved only by a real change, and tells the listeners once per change', () => {
    const cache = createRowCache();
    let told = 0;
    const off = cache.subscribe(() => (told += 1));
    const before = cache.versionOf('designs', 'skus');
    cache.merge('designs', [designRow(1)]);
    expect(told).toBe(1);
    expect(cache.versionOf('designs', 'skus')).not.toBe(before);
    const mid = cache.versionOf('skus');
    cache.merge('designs', [designRow(2), designRow(3)]);
    expect(told).toBe(2);
    expect(cache.versionOf('skus')).toBe(mid); // another resource: unchanged
    cache.merge('designs', [designRow(2, { updated_at: at(1) })]); // older copy: no change, no news
    expect(told).toBe(2);
    off();
    cache.merge('designs', [designRow(4)]);
    expect(told).toBe(2);
  });

  it('clear() empties every resource (U8), changes the versions so that views are made again, and says so once', () => {
    const cache = createRowCache();
    cache.merge('designs', [designRow(1)]);
    cache.merge('skus', [skuRow(1, 1)]);
    const version = cache.versionOf('designs', 'skus');
    let told = 0;
    cache.subscribe(() => (told += 1));
    cache.clear();
    expect(cache.count('designs')).toBe(0);
    expect(cache.count('skus')).toBe(0);
    expect(cache.rows('designs')).toEqual([]);
    expect(cache.get('designs', uuid(301))).toBeUndefined();
    expect(cache.versionOf('designs', 'skus')).not.toBe(version);
    expect(told).toBe(1);
    cache.clear(); // nothing left: nothing to tell
    expect(told).toBe(1);
    expect(cache.size()).toBe(0);
  });
});
