// PDF-2: the steps behind the Download PDF and Share buttons, with no screen in it: no window, document or navigator. The three things it needs (make the PDF, save it, share it) come
// in as `deps`, and every change of state goes out through `onState`, so a test runs it with fakes and Task 4's component only draws the state.
//   - a share that the browser refuses (`blocked`: the make was slow, so the old tap is too old) does not make the PDF again: the state is `ready`, and one more tap (`sendReady`) shares
//     the same file, with the share called at once, inside that tap
//   - `stop` aborts the make; whatever the make or the share does after that is ignored, so nothing is delivered after Stop
import type { ShareOutcome } from './deliver';
import type { PdfFile } from './types';

export type PdfIntent = 'download' | 'share';

export type PdfJobState =
  | { step: 'idle' }
  | { step: 'making'; intent: PdfIntent; done: number; total: number } // total 0: no photo count
  | { step: 'ready'; file: PdfFile } // made; the share needs one more tap
  | { step: 'failed'; message: string };

export interface PdfJobDeps {
  make(report: (done: number, total: number) => void, signal: AbortSignal): Promise<PdfFile>;
  download(file: PdfFile): void;
  share(file: PdfFile): Promise<ShareOutcome>;
}

export const PDF_MAKE_FAILED = 'The PDF could not be made. Please try again.';
export const PDF_SHARE_FAILED = 'The PDF could not be shared. Please use Download PDF.';

export function createPdfJob(
  deps: PdfJobDeps,
  onState: (state: PdfJobState) => void
): {
  start(intent: PdfIntent): Promise<void>; // ignored while making
  sendReady(): Promise<void>; // shares the ready file; no new make
  stop(): void; // aborts a make; back to idle, nothing delivered
  dismiss(): void; // failed or ready -> idle
} {
  let state: PdfJobState = { step: 'idle' };
  // Each run (a start, a sendReady) takes the next number, and Stop moves the count on: a run whose number is no longer the current one was stopped, and its late result is ignored.
  let current = 0;
  let abort: AbortController | null = null;

  function set(next: PdfJobState) {
    state = next;
    onState(next);
  }

  /** Opens the share menu. `blocked` leaves the file ready for one more tap; a throw is a failure; `shared` and `cancelled` (the menu closed) are the end. */
  async function shareFile(file: PdfFile, run: number): Promise<void> {
    let outcome: ShareOutcome;
    try {
      outcome = await deps.share(file);
    } catch {
      if (run === current) set({ step: 'failed', message: PDF_SHARE_FAILED });
      return;
    }
    if (run !== current) return;
    set(outcome === 'blocked' ? { step: 'ready', file } : { step: 'idle' });
  }

  async function start(intent: PdfIntent): Promise<void> {
    if (state.step === 'making') return;
    const run = ++current;
    const controller = new AbortController();
    abort = controller;
    let making = true;
    set({ step: 'making', intent, done: 0, total: 0 });

    let file: PdfFile;
    try {
      file = await deps.make((done, total) => {
        if (making && run === current) set({ step: 'making', intent, done, total });
      }, controller.signal);
    } catch {
      making = false;
      if (run === current) set({ step: 'failed', message: PDF_MAKE_FAILED });
      return;
    }
    making = false;
    if (run !== current) return;

    if (intent === 'share') {
      await shareFile(file, run);
      return;
    }
    try {
      deps.download(file);
    } catch {
      // The save could not start: say so, rather than leave Stop on the screen for ever.
      set({ step: 'failed', message: PDF_MAKE_FAILED });
      return;
    }
    set({ step: 'idle' });
  }

  async function sendReady(): Promise<void> {
    if (state.step !== 'ready') return;
    const { file } = state;
    const run = ++current;
    abort = null;
    set({ step: 'making', intent: 'share', done: 0, total: 0 });
    // No await before the share: it has to start inside the tap that called this.
    await shareFile(file, run);
  }

  function stop() {
    if (state.step !== 'making') return;
    current += 1;
    abort?.abort();
    abort = null;
    set({ step: 'idle' });
  }

  function dismiss() {
    if (state.step === 'failed' || state.step === 'ready') set({ step: 'idle' });
  }

  return { start, sendReady, stop, dismiss };
}
