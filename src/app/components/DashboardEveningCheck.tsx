'use client';
import React, { useEffect, useSyncExternalStore } from 'react';
import { Banknote, IndianRupee, Smartphone } from 'lucide-react';
import {
  booksVersion,
  computeEvening,
  reloadDailyTotals,
  subscribeBooks,
  watchDailyTotals,
  type EveningView,
} from '@/lib/appStore';
import { useBusinessToday } from '@/lib/businessClock';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { paiseShown } from '@/lib/ledgerView';
import { dayLabel } from '@/lib/rateGuard';

// The owner's evening check (spec V4, C14): today's Cash net, today's UPI net and the total outstanding, in one place. The two nets are the cash book of the day (V4, read from the API:
// a payment, a refund or a void moves them), the outstanding is the sum of the customers' outstanding (V2, in memory): the same figures as the Payments report, the Outstanding tile and the
// customer cards, because they come from the same selectors (src/lib/selectors.ts). A cash book that cannot be read shows a dash and says so: never a made-up zero.

function Tile({
  id,
  label,
  value,
  note,
  icon,
  tone,
}: {
  id: string;
  label: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <div className={`rounded-xl p-4 flex items-center gap-3 ${tone}`}>
      {icon}
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p data-testid={id} className="text-xl font-bold text-foreground font-tabular">
          {value}
        </p>
        <p className="text-[11px] text-muted-foreground">{note}</p>
      </div>
    </div>
  );
}

/** The card, drawn from the figures it is given (the container below gives it the day's). */
export function EveningCheckView({ view, onRetry }: { view: EveningView; onRetry?: () => void }) {
  const cash = (net: number | null) => (net === null ? '—' : paiseShown(net));
  return (
    <section data-testid="evening-check" className="jewel-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">Evening check</h2>
        <span data-testid="evening-date" className="text-xs text-muted-foreground">
          {dayLabel(view.date)}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile
          id="evening-cash"
          label="Cash today"
          value={cash(view.cashNetPaise)}
          note="Received less handed back"
          icon={<Banknote size={16} className="text-emerald-600" />}
          tone="bg-emerald-50"
        />
        <Tile
          id="evening-upi"
          label="UPI today"
          value={cash(view.upiNetPaise)}
          note="Received less handed back"
          icon={<Smartphone size={16} className="text-blue-600" />}
          tone="bg-blue-50"
        />
        <Tile
          id="evening-outstanding"
          label="Outstanding"
          value={paiseShown(view.outstandingPaise)}
          note="Across all customers"
          icon={<IndianRupee size={16} className="text-amber-600" />}
          tone="bg-amber-50"
        />
      </div>
      {view.state === 'failed' && (
        <p
          role="alert"
          data-testid="evening-error"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          <span>{view.message ?? "Today's cash book could not be loaded."}</span>
          {onRetry && (
            <button
              type="button"
              data-testid="evening-retry"
              className="btn-secondary py-1 text-xs"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </p>
      )}
      {(view.state === 'loading' || view.state === 'idle') && view.cashNetPaise === null && (
        <p data-testid="evening-loading" className="text-xs text-muted-foreground">
          Loading today&apos;s cash book…
        </p>
      )}
    </section>
  );
}

export default function DashboardEveningCheck() {
  const today = useBusinessToday();
  // drawn again when the cash book is read, or the customers' books or the receipts change
  useSyncExternalStore(subscribeBooks, booksVersion, () => 0);
  useRowCacheVersion('customer-balances', 'receipts');
  useEffect(() => (today ? watchDailyTotals(today, today) : undefined), [today]);
  // the static page has no day: it says nothing until the browser knows it
  if (!today) return null;
  return (
    <EveningCheckView
      view={computeEvening(today)}
      onRetry={() => void reloadDailyTotals(today, today)}
    />
  );
}
