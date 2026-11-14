// Wave 2 fix 2 (I2): `imagesSettled` (src/lib/imageWait.ts), what the stock catalogue waits on before it asks the browser to print. It resolves when every picture under a root has loaded and been
// decoded (or failed), or when the time given has gone by: a photo that never arrives must not stop a paper from printing. Never rejects.
//
// Run: npm test -- tests/unit/image-wait.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { imagesSettled } from '@/lib/imageWait';

interface FakeImage {
  decode?: () => Promise<void>;
  complete?: boolean;
  addEventListener?: (name: string, listener: () => void) => void;
}

const rootOf = (images: FakeImage[]) => ({
  querySelectorAll: () => images as unknown as NodeListOf<HTMLImageElement>,
});

/** A promise that is settled from the outside. */
function gate() {
  let open!: () => void;
  let fail!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = () => reject(new Error('EncodingError'));
  });
  return { promise, open, fail };
}

const settledFlag = (promise: Promise<void>) => {
  const state = { done: false };
  void promise.then(() => {
    state.done = true;
  });
  return state;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Wave 2 fix 2: imagesSettled', () => {
  it('a page with no picture (or no root) is ready at once', async () => {
    await expect(imagesSettled(rootOf([]), 15_000)).resolves.toBeUndefined();
    await expect(imagesSettled(null, 15_000)).resolves.toBeUndefined();
  });

  it('waits for every picture to be decoded, and not for one less', async () => {
    const a = gate();
    const b = gate();
    const state = settledFlag(
      imagesSettled(rootOf([{ decode: () => a.promise }, { decode: () => b.promise }]), 15_000)
    );
    a.open();
    await Promise.resolve();
    await Promise.resolve();
    expect(state.done).toBe(false);
    b.open();
    await vi.waitFor(() => expect(state.done).toBe(true));
  });

  it('a picture that cannot be decoded (a broken address) counts as settled: it does not block, and it does not reject', async () => {
    const broken = gate();
    const good = gate();
    const state = settledFlag(
      imagesSettled(
        rootOf([{ decode: () => broken.promise }, { decode: () => good.promise }]),
        15_000
      )
    );
    broken.fail();
    good.open();
    await vi.waitFor(() => expect(state.done).toBe(true));
  });

  it('a picture that never arrives is waited for 15 seconds and no longer', async () => {
    vi.useFakeTimers();
    const never = gate();
    const good = gate();
    const state = settledFlag(
      imagesSettled(
        rootOf([{ decode: () => never.promise }, { decode: () => good.promise }]),
        15_000
      )
    );
    good.open();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
  });

  it('with no decode() it goes by the load and error events (and a picture that is already complete is done)', async () => {
    const listeners: Record<string, () => void> = {};
    const loading: FakeImage = {
      complete: false,
      addEventListener: (name, listener) => {
        listeners[name] = listener;
      },
    };
    const complete: FakeImage = { complete: true };
    const state = settledFlag(imagesSettled(rootOf([complete, loading]), 15_000));
    await Promise.resolve();
    await Promise.resolve();
    expect(state.done).toBe(false);
    listeners.error();
    await vi.waitFor(() => expect(state.done).toBe(true));
  });

  it('a timer that is no longer needed is cleared: nothing is left waiting after the pictures are done', async () => {
    vi.useFakeTimers();
    const one = gate();
    const done = imagesSettled(rootOf([{ decode: () => one.promise }]), 15_000);
    one.open();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(vi.getTimerCount()).toBe(0);
  });
});
