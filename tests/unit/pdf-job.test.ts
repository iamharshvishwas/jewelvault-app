// PDF-2: the PDF job (src/lib/pdf/pdfJob.ts), the small state machine behind Download PDF and Share, run with fakes for the three things it calls:
//   - download: `making`, then `idle` once the file is saved
//   - share: `shared` and `cancelled` end in `idle` (a menu the person closes is not a failure); `blocked` (the browser refused the old tap after a slow make) ends in `ready`, and
//     `sendReady()` shares that same file at once, with no second make and nothing awaited before the share (the tap must still count as the person's own)
//   - a make that fails, a share that throws, or a save that throws, ends in `failed` with its own message and is logged with `console.warn` (the person sees the sentence, the developer
//     the error); the AbortError that follows Stop is not a failure and is not logged
//   - `stop()` aborts the make and ends in `idle`; what the make does later (resolve or reject) is ignored and nothing is delivered
//   - a second `start` while making does nothing; the photo count reaches the screen
//
// Run: npm test -- tests/unit/pdf-job.test.ts
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ShareOutcome } from '@/lib/pdf/deliver';
import {
  PDF_MAKE_FAILED,
  PDF_SHARE_FAILED,
  createPdfJob,
  type PdfJobDeps,
  type PdfJobState,
} from '@/lib/pdf/pdfJob';
import type { PdfFile } from '@/lib/pdf/types';

const file: PdfFile = {
  blob: new Blob(['%PDF-1.7'], { type: 'application/pdf' }),
  fileName: 'Stock Catalogue - 24-11-2026.pdf',
};

/** A job with fakes. `make` answers with `file` at once unless a test takes hold of it (`hold`). */
function setup(overrides: Partial<PdfJobDeps> = {}) {
  const states: PdfJobState[] = [];
  const make = vi.fn<PdfJobDeps['make']>(async () => file);
  const download = vi.fn<PdfJobDeps['download']>();
  const share = vi.fn<PdfJobDeps['share']>(async () => 'shared');
  const job = createPdfJob({ make, download, share, ...overrides }, (s) => states.push(s));
  return { job, states, make, download, share, last: () => states[states.length - 1] };
}

/** A promise the test settles when it says so (a make that is still going, a share sheet that is still open). */
function hold<T = PdfFile>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const making = (intent: 'download' | 'share', done = 0, total = 0) => ({
  step: 'making',
  intent,
  done,
  total,
});

describe('PDF-2: the PDF job', () => {
  // The job logs a failure with console.warn; the spy keeps the test output clean and lets a test see what was logged.
  let warn: MockInstance<typeof console.warn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('(1) download: making, then idle, and the file is downloaded once', async () => {
    const { job, states, download, share } = setup();
    await job.start('download');
    expect(states).toEqual([making('download'), { step: 'idle' }]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(file);
    expect(share).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each<ShareOutcome>(['shared', 'cancelled'])(
    '(2) share %s ends in idle, no failure',
    async (outcome) => {
      const share = vi.fn<PdfJobDeps['share']>(async () => outcome);
      const { job, states, download } = setup({ share });
      await job.start('share');
      expect(states).toEqual([making('share'), { step: 'idle' }]);
      expect(share).toHaveBeenCalledExactlyOnceWith(file);
      expect(download).not.toHaveBeenCalled();
    }
  );

  it('(3) share blocked ends in ready, and sendReady shares the same file with no second make', async () => {
    const outcomes: ShareOutcome[] = ['blocked', 'shared'];
    const share = vi.fn<PdfJobDeps['share']>(async () => outcomes.shift() ?? 'shared');
    const { job, states, make, last } = setup({ share });

    await job.start('share');
    expect(last()).toEqual({ step: 'ready', file });
    expect(make).toHaveBeenCalledTimes(1);

    await job.sendReady();
    expect(make).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(2);
    expect(share.mock.calls[1][0]).toBe(file);
    expect(last()).toEqual({ step: 'idle' });
    expect(states.some((s) => s.step === 'failed')).toBe(false);
  });

  it('(3) sendReady calls the share at once, before anything is awaited, so the tap still counts', async () => {
    const outcomes: ShareOutcome[] = ['blocked', 'shared'];
    const share = vi.fn<PdfJobDeps['share']>(async () => outcomes.shift() ?? 'shared');
    const { job } = setup({ share });
    await job.start('share');
    expect(share).toHaveBeenCalledTimes(1);

    const sending = job.sendReady(); // not awaited
    expect(share).toHaveBeenCalledTimes(2);
    await sending;
  });

  it('(3) a share that is blocked again leaves the same file ready; a double tap shares once', async () => {
    const open = hold<ShareOutcome>();
    const calls: Array<Promise<ShareOutcome>> = [Promise.resolve('blocked'), open.promise];
    const share = vi.fn<PdfJobDeps['share']>(() => calls.shift() ?? Promise.resolve('shared'));
    const { job, last } = setup({ share });
    await job.start('share');

    const first = job.sendReady();
    const again = job.sendReady(); // a second tap while the share is open
    expect(share).toHaveBeenCalledTimes(2);

    // The share the person sees now is refused again: the same file stays ready.
    open.resolve('blocked');
    await first;
    await again;
    expect(last()).toEqual({ step: 'ready', file });
  });

  it('(3) sendReady does nothing when no file is ready', async () => {
    const { job, share, states } = setup();
    await job.sendReady();
    expect(share).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it('(4) a make that rejects gives failed with the make message', async () => {
    const error = new Error('fonts did not load');
    const { job, last, download } = setup({
      make: vi.fn(async () => {
        throw error;
      }),
    });
    await job.start('download');
    expect(last()).toEqual({ step: 'failed', message: PDF_MAKE_FAILED });
    expect(download).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith('The PDF could not be made', error);
  });

  it('(4) a make that throws before it returns a promise also gives failed', async () => {
    const error = new Error('sync');
    const { job, last } = setup({
      make: () => {
        throw error;
      },
    });
    await job.start('share');
    expect(last()).toEqual({ step: 'failed', message: PDF_MAKE_FAILED });
    expect(warn).toHaveBeenCalledExactlyOnceWith('The PDF could not be made', error);
  });

  it('(4) a share that throws gives failed with the share message, and Download PDF can still be used', async () => {
    const error = new TypeError('files are not supported');
    const { job, last, make, download } = setup({
      share: vi.fn(async () => {
        throw error;
      }),
    });
    await job.start('share');
    expect(last()).toEqual({ step: 'failed', message: PDF_SHARE_FAILED });
    expect(warn).toHaveBeenCalledExactlyOnceWith('The PDF could not be shared', error);

    await job.start('download');
    expect(make).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenCalledWith(file);
    expect(last()).toEqual({ step: 'idle' });
  });

  it('(4) a ready file whose share then throws gives failed with the share message', async () => {
    const error = new Error('nope');
    const outcomes: Array<ShareOutcome | Error> = ['blocked', error];
    const share = vi.fn<PdfJobDeps['share']>(async () => {
      const next = outcomes.shift() ?? 'shared';
      if (next instanceof Error) throw next;
      return next;
    });
    const { job, last } = setup({ share });
    await job.start('share');
    expect(warn).not.toHaveBeenCalled();
    await job.sendReady();
    expect(last()).toEqual({ step: 'failed', message: PDF_SHARE_FAILED });
    expect(warn).toHaveBeenCalledExactlyOnceWith('The PDF could not be shared', error);
  });

  it('(4) a download that throws does not leave the job making for ever', async () => {
    const error = new Error('no blob address');
    const { job, last } = setup({
      download: vi.fn(() => {
        throw error;
      }),
    });
    await job.start('download');
    expect(last()).toEqual({ step: 'failed', message: PDF_MAKE_FAILED });
    expect(warn).toHaveBeenCalledExactlyOnceWith('The PDF could not be saved', error);
  });

  it('(5) stop while making aborts the signal, ends in idle, and delivers nothing even if make resolves later', async () => {
    const pending = hold();
    let signal!: AbortSignal;
    const { job, states, download, share, last } = setup({
      make: vi.fn((_report, s) => {
        signal = s;
        return pending.promise;
      }),
    });
    const started = job.start('download');
    expect(signal.aborted).toBe(false);

    job.stop();
    expect(signal.aborted).toBe(true);
    expect(last()).toEqual({ step: 'idle' });

    pending.resolve(file);
    await started;
    expect(download).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(last()).toEqual({ step: 'idle' });
    expect(states).toEqual([making('download'), { step: 'idle' }]);
  });

  it('(5) stop while making: a make that rejects later (AbortError or anything) leaves idle', async () => {
    const pending = hold();
    const { job, last } = setup({ make: vi.fn(() => pending.promise) });
    const started = job.start('share');
    job.stop();
    pending.reject(new DOMException('stopped', 'AbortError'));
    await started;
    expect(last()).toEqual({ step: 'idle' });
    expect(warn).not.toHaveBeenCalled();

    const other = hold();
    const second = setup({ make: vi.fn(() => other.promise) });
    const secondStart = second.job.start('download');
    second.job.stop();
    other.reject(new Error('some other failure'));
    await secondStart;
    expect(second.last()).toEqual({ step: 'idle' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('(5) stop while the share menu is open: a share that throws later leaves idle and is not logged', async () => {
    const open = hold<ShareOutcome>();
    const share = vi.fn<PdfJobDeps['share']>(() => open.promise);
    const { job, last } = setup({ share });
    const started = job.start('share');
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1)); // the make has ended: the menu is open
    expect(last()).toEqual(making('share'));

    job.stop();
    open.reject(new TypeError('late'));
    await started;
    expect(last()).toEqual({ step: 'idle' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('(5) stop then start again: the old make cannot touch the new one', async () => {
    const olds = hold();
    const news = hold();
    const makes = [olds.promise, news.promise];
    const { job, download, last } = setup({ make: vi.fn(() => makes.shift() as Promise<PdfFile>) });

    const first = job.start('download');
    job.stop();
    const second = job.start('download');
    expect(last()).toEqual(making('download'));

    olds.resolve({ blob: file.blob, fileName: 'old.pdf' });
    await first;
    expect(download).not.toHaveBeenCalled();
    expect(last()).toEqual(making('download'));

    news.resolve(file);
    await second;
    expect(download).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledWith(file);
    expect(last()).toEqual({ step: 'idle' });
  });

  it('(5) stop does nothing when nothing is being made', () => {
    const { job, states } = setup();
    job.stop();
    expect(states).toEqual([]);
  });

  it('(6) a second start while making does not call make again', async () => {
    const pending = hold();
    const make = vi.fn<PdfJobDeps['make']>(() => pending.promise);
    const { job, download } = setup({ make });
    const first = job.start('download');
    await job.start('download');
    await job.start('share');
    expect(make).toHaveBeenCalledTimes(1);

    pending.resolve(file);
    await first;
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('(7) report(3, 10) shows as making with the count', async () => {
    const pending = hold();
    let report!: (done: number, total: number) => void;
    const { job, last } = setup({
      make: vi.fn((r) => {
        report = r;
        return pending.promise;
      }),
    });
    const started = job.start('share');
    expect(last()).toEqual(making('share', 0, 0));

    report(3, 10);
    expect(last()).toEqual({ step: 'making', intent: 'share', done: 3, total: 10 });

    pending.resolve(file);
    await started;
  });

  it('(7) a report that comes after stop or after the end is ignored', async () => {
    const pending = hold();
    let report!: (done: number, total: number) => void;
    const { job, states, last } = setup({
      make: vi.fn((r) => {
        report = r;
        return pending.promise;
      }),
    });
    const started = job.start('download');
    job.stop();
    report(5, 10);
    expect(last()).toEqual({ step: 'idle' });
    pending.resolve(file);
    await started;
    report(6, 10);
    expect(states).toEqual([making('download'), { step: 'idle' }]);
  });

  it('(7) a report that comes after the make has ended does not bring the busy state back', async () => {
    let report!: (done: number, total: number) => void;
    const { job, states } = setup({
      make: vi.fn(async (r) => {
        report = r;
        return file;
      }),
    });
    await job.start('download');
    report(6, 10);
    expect(states).toEqual([making('download'), { step: 'idle' }]);
  });

  it('dismiss takes failed and ready back to idle, and does nothing otherwise', async () => {
    const failing = setup({
      make: vi.fn(async () => {
        throw new Error('x');
      }),
    });
    await failing.job.start('download');
    failing.job.dismiss();
    expect(failing.last()).toEqual({ step: 'idle' });

    const blocked = setup({ share: vi.fn<PdfJobDeps['share']>(async () => 'blocked') });
    await blocked.job.start('share');
    expect(blocked.last().step).toBe('ready');
    blocked.job.dismiss();
    expect(blocked.last()).toEqual({ step: 'idle' });

    const idle = setup();
    idle.job.dismiss();
    expect(idle.states).toEqual([]);
  });

  it('a ready file that is dismissed cannot be sent', async () => {
    const share = vi.fn<PdfJobDeps['share']>(async () => 'blocked');
    const { job } = setup({ share });
    await job.start('share');
    job.dismiss();
    await job.sendReady();
    expect(share).toHaveBeenCalledTimes(1);
  });
});
