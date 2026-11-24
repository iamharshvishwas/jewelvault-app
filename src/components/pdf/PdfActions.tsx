'use client';

import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Download, Loader2, Share2 } from 'lucide-react';
import { canSharePdf, downloadPdf, sharePdf } from '@/lib/pdf/deliver';
import { createPdfJob, type PdfJobDeps, type PdfJobState } from '@/lib/pdf/pdfJob';

// PDF-4: the Download PDF and Share buttons of a screen that has a PDF file: the saved estimate, and (PDF-6) the Stock Catalogue. The steps are the PDF job's (src/lib/pdf/pdfJob.ts);
// this only draws its state:
//   - idle: `Download PDF`, and `Share` where the browser can share a PDF file. That is asked of the browser only, never while the page is built or hydrated (the server's answer is
//     no), so the static page never has `Share`.
//   - making: the busy words (`Making PDF…`, with the photo count when the screen reports one) in place of the two buttons, and `Stop`
//   - ready: the browser refused a share after a slow make (the tap was too old), so `Share` has become `Send PDF`; one more tap shares the file already made
//   - failed: the sentence of the failure, on a line of its own after the row; the buttons stay, to try again
// The parts go into the screen's own row of buttons (a flex row that wraps), before its Print. A screen that goes away stops a PDF still being made: nothing is saved after it.

export interface PdfActionsProps {
  /** Makes the PDF. Called at each tap, so it takes what the screen shows at that moment. */
  make: PdfJobDeps['make'];
  /** The title handed to the share menu: 'Estimate {invoiceNumber}' or 'Stock Catalogue'. */
  shareTitle: string;
  testIdPrefix: 'estimate-pdf' | 'catalogue-pdf';
  disabled?: boolean;
  /** The buttons' title when disabled. */
  disabledReason?: string;
}

type PdfJob = ReturnType<typeof createPdfJob>;

const noSubscription = () => () => {};

/** The busy words: the catalogue counts its photos, the estimate has none to count. */
function busyWords(state: Extract<PdfJobState, { step: 'making' }>): string {
  return state.total > 0 ? `Making PDF… photos ${state.done} of ${state.total}` : 'Making PDF…';
}

export default function PdfActions({
  make,
  shareTitle,
  testIdPrefix,
  disabled = false,
  disabledReason,
}: PdfActionsProps) {
  const [state, setState] = useState<PdfJobState>({ step: 'idle' });
  const canShare = useSyncExternalStore(noSubscription, canSharePdf, () => false);
  // The job is made once the screen is up and lives as long as it; at each tap it takes the screen's latest `make` and title. The screen going away stops it.
  const latest = useRef({ make, shareTitle });
  useEffect(() => {
    latest.current = { make, shareTitle };
  });
  const job = useRef<PdfJob | null>(null);
  useEffect(() => {
    const made = createPdfJob(
      {
        make: (report, signal) => latest.current.make(report, signal),
        download: downloadPdf,
        share: (file) => sharePdf(file, latest.current.shareTitle),
      },
      setState
    );
    job.current = made;
    return () => {
      made.stop();
      job.current = null;
    };
  }, []);

  const testId = (part: string) => `${testIdPrefix}-${part}`;
  const title = disabled ? disabledReason : undefined;

  return (
    <>
      {state.step === 'making' ? (
        <>
          <span
            role="status"
            data-testid={testId('progress')}
            className="btn-primary pointer-events-none py-2 opacity-60"
          >
            <Loader2 size={15} className="animate-spin" />
            {busyWords(state)}
          </span>
          <button
            type="button"
            data-testid={testId('stop')}
            onClick={() => job.current?.stop()}
            className="btn-secondary py-2"
          >
            Stop
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            data-testid={testId('download')}
            onClick={() => void job.current?.start('download')}
            disabled={disabled}
            title={title}
            className="btn-primary py-2"
          >
            <Download size={15} />
            Download PDF
          </button>
          {state.step === 'ready' ? (
            // nothing is awaited before the share: it has to start inside this tap
            <button
              type="button"
              data-testid={testId('send')}
              onClick={() => void job.current?.sendReady()}
              className="btn-primary py-2"
            >
              <Share2 size={15} />
              Send PDF
            </button>
          ) : (
            canShare && (
              <button
                type="button"
                data-testid={testId('share')}
                onClick={() => void job.current?.start('share')}
                disabled={disabled}
                title={title}
                className="btn-secondary py-2"
              >
                <Share2 size={15} />
                Share
              </button>
            )
          )}
        </>
      )}
      {state.step === 'failed' && (
        <p
          role="alert"
          data-testid={testId('error')}
          className="order-last basis-full text-xs font-semibold text-red-600"
        >
          {state.message}
        </p>
      )}
    </>
  );
}
