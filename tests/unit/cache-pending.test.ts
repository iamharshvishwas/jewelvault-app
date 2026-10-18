// WEB04: a pending row ignores polled copies (spec C4, C5 (a)). An ordinary edit marks its row pending, updates memory at once and awaits one write; a copy
// of that row that arrives in a poll meanwhile is somebody else's older or newer version of what this screen is changing, and must not undo the edit under the
// person's hands. When the write ends (the returned row replaces the edit, or memory is rolled back) the poll's copy is let in if it is still the newer one.
// The unit half of T-E07 for optimistic rows; WEB05 uses `hold` for every ordinary edit.
import { describe, expect, it, vi } from 'vitest';
import { createRowCache } from '@/lib/cache/cache';
import { at, designRow, uuid } from './support/rows';

const id = uuid(301);
const old = designRow(1, { name: 'old', updated_at: at(10) });
const edited = designRow(1, { name: 'edited by me', updated_at: at(10) }); // an optimistic row has the stamp it had: the edit is not yet saved
const theirs = designRow(1, { name: 'edited by somebody else', updated_at: at(20) });
const mine = designRow(1, { name: 'saved by me', updated_at: at(30) });

describe('T-E07 a pending row ignores polled copies until its write ends (C4, C5 (a))', () => {
  it('a polled copy of a held row is not merged; other rows of the same poll are', () => {
    const cache = createRowCache();
    cache.merge('designs', [old, designRow(2, { updated_at: at(10) })]);
    cache.hold('designs', id);
    cache.merge('designs', [edited]); // the screen's own edit goes in as usual
    const stored = cache.merge(
      'designs',
      [theirs, designRow(2, { name: 'new 2', updated_at: at(20) })],
      {
        polled: true,
      }
    );
    expect(stored).toBe(1);
    expect(cache.get('designs', id)?.name).toBe('edited by me');
    expect(cache.get('designs', uuid(302))?.name).toBe('new 2');
    expect(cache.isHeld('designs', id)).toBe(true);
    expect(cache.isHeld('designs', uuid(302))).toBe(false);
  });

  it("the screen's own merges are never blocked by its hold (the optimistic row, the returned row, the rollback)", () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    cache.hold('designs', id);
    expect(cache.merge('designs', [edited])).toBe(1);
    expect(cache.merge('designs', [mine])).toBe(1);
    expect(cache.get('designs', id)?.name).toBe('saved by me');
  });

  it('when the write ends the copy of the poll is let in if it is still the newer one (a failed write that was rolled back)', () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    const release = cache.hold('designs', id);
    cache.merge('designs', [edited]);
    cache.merge('designs', [theirs], { polled: true });
    expect(cache.get('designs', id)?.name).toBe('edited by me');
    cache.merge('designs', [old]); // rolled back: the row as it was
    release();
    expect(cache.get('designs', id)?.name).toBe('edited by somebody else');
    expect(cache.isHeld('designs', id)).toBe(false);
  });

  it('when the write ends with the row it returned, an older copy of the poll does not replace it (the greater updated_at stays)', () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    const release = cache.hold('designs', id);
    cache.merge('designs', [edited]);
    cache.merge('designs', [theirs], { polled: true }); // stamp 20
    cache.merge('designs', [mine]); // the write's answer, stamp 30
    release();
    expect(cache.get('designs', id)?.name).toBe('saved by me');
  });

  it('a held row that never gets a polled copy is just released', () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    const release = cache.hold('designs', id);
    const seen = vi.fn();
    cache.subscribe(seen);
    release();
    expect(seen).not.toHaveBeenCalled();
    expect(cache.get('designs', id)?.name).toBe('old');
  });

  it('two edits of one row hold it until both are done; releasing twice does nothing more', () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    const first = cache.hold('designs', id);
    const second = cache.hold('designs', id);
    cache.merge('designs', [theirs], { polled: true });
    first();
    first(); // a second call of the same release is nothing
    expect(cache.isHeld('designs', id)).toBe(true);
    expect(cache.get('designs', id)?.name).toBe('old');
    second();
    expect(cache.isHeld('designs', id)).toBe(false);
    expect(cache.get('designs', id)?.name).toBe('edited by somebody else');
  });

  it('a hold is by resource and key: the same key in another resource is not held', () => {
    const cache = createRowCache();
    cache.hold('designs', id);
    expect(cache.isHeld('skus', id)).toBe(false);
    expect(cache.isHeld('designs', uuid(999))).toBe(false);
  });

  it('applying the copy that waited moves the version and tells the listeners once', () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    const release = cache.hold('designs', id);
    cache.merge('designs', [theirs], { polled: true });
    const before = cache.versionOf('designs');
    const seen = vi.fn();
    cache.subscribe(seen);
    release();
    expect(cache.versionOf('designs')).not.toBe(before);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('a logout (clear) drops every hold and every copy that waited: nothing of the old session comes back', () => {
    const cache = createRowCache();
    cache.merge('designs', [old]);
    const release = cache.hold('designs', id);
    cache.merge('designs', [theirs], { polled: true });
    cache.clear();
    expect(cache.isHeld('designs', id)).toBe(false);
    release(); // the write of the old session ends later
    expect(cache.count('designs')).toBe(0);
    // the next session's poll is merged normally
    expect(cache.merge('designs', [theirs], { polled: true })).toBe(1);
  });

  it('a polled copy that cannot be read is still refused for a held row, as for any other', () => {
    const cache = createRowCache();
    cache.hold('designs', id);
    expect(() =>
      cache.merge('designs', [{ ...theirs, updated_at: 'yesterday' }], { polled: true })
    ).toThrow(/updated_at/);
  });
});
