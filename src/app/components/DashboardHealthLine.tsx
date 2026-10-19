'use client';
import React, { useEffect, useSyncExternalStore } from 'react';
import { CheckCircle2, AlertTriangle, AlertOctagon, Loader2 } from 'lucide-react';
import {
  booksVersion,
  getHealthView,
  reloadHealth,
  subscribeBooks,
  watchHealth,
} from '@/lib/appStore';
import { buildHealthLine, type HealthLineModel, type Tone } from '@/lib/healthLine';

// The owner's dashboard line (spec section 12, I11, I12; task WEB12): "Books: OK at 02:17" or "Problem", the age of the last good backup and photo copy, the size of the database and of
// the backup folder, the days since the last Download everything and since Harsh's last weekly pull, and yesterday's review counts. The level, the reasons and every colour are the API's
// (GET /v1/dashboard/health through src/lib/healthLine.ts): this screen decides nothing. Owner only; the page does not mount it for anyone else.

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-700',
  amber: 'text-amber-700 font-semibold',
  red: 'text-red-700 font-semibold',
  unknown: 'text-muted-foreground',
};

const LEVEL_CLASS: Record<string, string> = {
  red: 'border-red-300 bg-red-50',
  amber: 'border-amber-300 bg-amber-50',
  green: 'border-emerald-200 bg-emerald-50/50',
  unknown: 'border-border bg-card',
};

function LevelIcon({ level }: { level: HealthLineModel['level'] }) {
  if (level === 'red') return <AlertOctagon size={18} className="text-red-600" />;
  if (level === 'amber') return <AlertTriangle size={18} className="text-amber-600" />;
  if (level === 'green') return <CheckCircle2 size={18} className="text-emerald-600" />;
  return <Loader2 size={18} className="text-muted-foreground" />;
}

/** The card, drawn from the model. */
export function HealthLineView({
  model,
  onRetry,
}: {
  model: HealthLineModel;
  onRetry?: () => void;
}) {
  const level = model.level ?? 'unknown';
  const books = model.facts.find((f) => f.id === 'books');
  return (
    <section
      data-testid="health-line"
      data-level={level}
      className={`rounded-xl border p-4 space-y-3 ${LEVEL_CLASS[level]}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LevelIcon level={model.level} />
          <h2 data-testid="health-headline" className="text-sm font-semibold text-foreground">
            {model.headline}
          </h2>
        </div>
        {books && (
          <span
            data-testid="health-books"
            data-tone={books.tone}
            className={`text-sm ${TONE_CLASS[books.tone]}`}
          >
            {books.label}: {books.value}
          </span>
        )}
      </div>

      {model.state === 'loading' && (
        <p data-testid="health-loading" className="text-xs text-muted-foreground">
          Checking the books…
        </p>
      )}

      {model.message && (
        <p
          role="alert"
          data-testid="health-error"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs text-red-700"
        >
          <span>
            {model.message}
            {model.stale ? ' The line below is the last one that was read.' : ''}
          </span>
          {onRetry && (
            <button
              type="button"
              data-testid="health-retry"
              className="btn-secondary py-1 text-xs"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </p>
      )}

      {model.facts.length > 0 && (
        <dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-x-4 gap-y-2 text-xs">
          {model.facts
            .filter((f) => f.id !== 'books')
            .map((fact) => (
              <div key={fact.id} data-testid={`health-${fact.id}`} data-tone={fact.tone}>
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className={TONE_CLASS[fact.tone]}>{fact.value}</dd>
              </div>
            ))}
        </dl>
      )}

      {model.reasons.length > 0 && (
        <ul data-testid="health-reasons" className="space-y-1 text-xs">
          {model.reasons.map((reason) => (
            <li
              key={reason.code}
              data-testid={`health-reason-${reason.code}`}
              data-tone={reason.tone}
              className={reason.tone === 'red' ? 'text-red-700' : 'text-amber-700'}
            >
              {reason.text}
            </li>
          ))}
        </ul>
      )}

      {model.review && (
        <div data-testid="health-review" className="border-t border-border/60 pt-2 text-xs">
          <p className="font-semibold text-foreground">Review of {model.review.dayLabel}</p>
          {model.review.items.length === 0 ? (
            <p data-testid="review-none" className="text-muted-foreground">
              Nothing to look at.
            </p>
          ) : (
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {model.review.items.map((item) => (
                <li key={item.id} data-testid={`review-${item.id}`} className="text-foreground">
                  {item.label}: <span className="font-semibold font-tabular">{item.count}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-muted-foreground">
            Walk-in customer: {model.review.walkin.bills} bill
            {model.review.walkin.bills === 1 ? '' : 's'},{' '}
            <span data-testid="review-walkin-cash">{model.review.walkin.cashTotal}</span> in cash
          </p>
        </div>
      )}
      {model.reviewMessage && (
        <p data-testid="health-review-error" className="text-xs text-muted-foreground">
          {model.reviewMessage}
        </p>
      )}
    </section>
  );
}

export default function DashboardHealthLine() {
  // drawn again when a read begins or ends
  useSyncExternalStore(subscribeBooks, booksVersion, () => 0);
  useEffect(() => watchHealth(), []);
  return (
    <HealthLineView model={buildHealthLine(getHealthView())} onRetry={() => void reloadHealth()} />
  );
}
