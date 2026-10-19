'use client';
import React, { useEffect, useSyncExternalStore } from 'react';
import { DatabaseBackup, Loader2 } from 'lucide-react';
import SaveButton from '@/components/ui/SaveButton';
import { booksVersion, getHealthView, subscribeBooks, watchHealth } from '@/lib/appStore';
import { downloadServer, type DownloadState } from '@/lib/cache/downloadServer';
import { buildDownloadCard, type DownloadCardModel } from '@/lib/healthLine';

// The owner's "Download everything" card (spec B3, I12, O53; task WEB12b): the date of the last download, amber from 28 days and red from 36 (the API counts them, the card repeats the
// state), and the button that makes the zip of the books in the browser and records it. The flow is src/lib/cache/downloadServer.ts, the files are src/lib/downloadEverything.ts.
// Owner only; the page does not mount it for anybody else, and the API refuses the record to every other caller.

const BOX_CLASS: Record<string, string> = {
  red: 'border-red-300 bg-red-50',
  amber: 'border-amber-300 bg-amber-50',
  ok: 'border-border bg-card',
  unknown: 'border-border bg-card',
};
const LAST_CLASS: Record<string, string> = {
  red: 'text-red-700 font-semibold',
  amber: 'text-amber-700 font-semibold',
  ok: 'text-foreground font-semibold',
  unknown: 'text-muted-foreground',
};

const IDLE: DownloadState = { status: 'idle' };
const rowsShown = (n: number) => new Intl.NumberFormat('en-IN').format(n);

/** The card, drawn from the model of the line and the state of the download. */
export function DownloadCardView({
  card,
  state,
  onDownload,
  onDismiss,
}: {
  card: DownloadCardModel;
  state: DownloadState;
  onDownload: () => void;
  onDismiss: () => void;
}) {
  const working = state.status === 'working';
  return (
    <section
      data-testid="download-card"
      data-tone={card.tone}
      className={`rounded-xl border p-4 space-y-3 ${BOX_CLASS[card.tone]}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2 min-w-0">
          <DatabaseBackup size={18} className="mt-0.5 text-primary flex-shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">Download everything</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Once a month, save a copy of all the books to your own computer. Keep it on your
              computer and on a USB stick: it is the only copy outside the web host.
            </p>
          </div>
        </div>
        <SaveButton
          type="button"
          data-testid="download-button"
          className="btn-primary py-2 text-xs"
          disabled={working}
          onClick={onDownload}
        >
          {working ? (
            <>
              <Loader2 size={14} className="animate-spin" /> Working…
            </>
          ) : (
            'Download everything'
          )}
        </SaveButton>
      </div>

      <p className="text-xs" data-testid="download-card-last">
        <span className="text-muted-foreground">Last download: </span>
        <span className={LAST_CLASS[card.tone]}>
          {card.date ? `${card.date} · ${card.last}` : card.last}
          {card.since ? ` · ${card.since}` : ''}
        </span>
      </p>

      {card.reminder && (
        <p
          data-testid="download-card-reminder"
          className={`text-xs ${card.tone === 'red' ? 'text-red-700' : 'text-amber-700'}`}
        >
          {card.reminder}
        </p>
      )}

      {state.status === 'working' && (
        <p
          role="status"
          data-testid="download-status"
          data-step={state.step}
          className="text-xs text-foreground"
        >
          {state.text}
        </p>
      )}
      {state.status === 'done' && (
        <div
          role="status"
          data-testid="download-status"
          data-step="done"
          className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-xs text-emerald-800"
        >
          <p>
            Saved as <span className="font-semibold">{state.filename}</span> ({state.files} files,{' '}
            {rowsShown(state.rows)} rows). Keep it outside this system: on your computer and on a
            USB stick.
          </p>
          <button
            type="button"
            data-testid="download-dismiss"
            className="mt-1 text-xs text-primary hover:underline"
            onClick={onDismiss}
          >
            Done
          </button>
        </div>
      )}
      {state.status === 'failed' && (
        <div
          role="alert"
          data-testid="download-error"
          className="rounded-lg border border-red-200 bg-white px-3 py-2 text-xs text-red-700"
        >
          <p>{state.message}</p>
          <button
            type="button"
            data-testid="download-dismiss"
            className="mt-1 text-xs text-primary hover:underline"
            onClick={onDismiss}
          >
            Close this message
          </button>
        </div>
      )}
    </section>
  );
}

export default function DashboardDownloadCard() {
  // drawn again when the line is read, and when the download moves a step
  useSyncExternalStore(subscribeBooks, booksVersion, () => 0);
  useEffect(() => watchHealth(), []);
  const state = useSyncExternalStore(downloadServer.subscribe, downloadServer.getState, () => IDLE);
  return (
    <DownloadCardView
      card={buildDownloadCard(getHealthView())}
      state={state}
      onDownload={() => void downloadServer.run()}
      onDismiss={() => downloadServer.dismiss()}
    />
  );
}
