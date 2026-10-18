'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { Ban, FilePenLine } from 'lucide-react';
import { billNumberOf, getBillFacts, saveCancel } from '@/lib/appStore';
import { inr } from '@/lib/billing';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { ownerActionFailure, savedCancelFrom, type SavedCancel } from '@/lib/ownerActions';
import { formatGrams } from '@/lib/pricing';
import ReasonDialog from './ReasonDialog';
import { useOwnerActions } from './useOwnerActions';

// The owner's actions on a bill: CANCEL (X5) and RE-ISSUE (X10) (spec K1, K3, K6, X5, X10, A4; task WEB11). A bill is never edited and never deleted: a wrong bill is cancelled (it stays in the
// books, marked Cancelled, with the reason), or re-issued, which cancels it and saves the corrected bill in one step, the money already received moving to the new one. The buttons are
// drawn for the owner only, and only for a bill that is still active; a re-issue is offered for an estimate (dues brought forward have no lines to correct: cancel them and add a new
// opening balance). The re-issue opens the billing screen with this bill's lines in it (`/billing-pos?reissue=<id>`), where the customer cannot be changed.

interface OwnerBillActionsProps {
  billId: string;
  /** `compact` for a row of a table. */
  compact?: boolean;
}

const part = (paise: number) => inr(paise, paise % 100 !== 0);

function CancelDone({ saved }: { saved: SavedCancel }) {
  return (
    <div className="space-y-1.5 text-xs text-foreground">
      <p data-testid="cancel-result" className="text-sm font-semibold">
        {saved.billNo} is cancelled. Nothing is owed on it.
      </p>
      {saved.pieces > 0 && (
        <p data-testid="cancel-pieces">
          {saved.pieces} piece{saved.pieces === 1 ? ' is' : 's are'} back in stock.
        </p>
      )}
      {saved.releasedPaise > 0 && (
        <p data-testid="cancel-released">
          {part(saved.releasedPaise)} received on this bill is no longer on it
          {saved.parts.length > 0 && (
            <>
              :{' '}
              {saved.parts
                .map((p) => `${part(p.paise)} went to ${billNumberOf(p.billId) ?? 'another bill'}`)
                .join(', ')}
            </>
          )}
          {saved.keptPaise > 0 && (
            <>; {part(saved.keptPaise)} is held as the customer&apos;s advance</>
          )}
          .
        </p>
      )}
      {saved.releasedFineMg > 0 && (
        <p data-testid="cancel-released-fine">
          {formatGrams(saved.releasedFineMg)} g of silver received on this bill is no longer on it
          {saved.appliedFineMg > 0 && (
            <>; {formatGrams(saved.appliedFineMg)} g went to other bills</>
          )}
          {saved.keptFineMg > 0 && (
            <>; {formatGrams(saved.keptFineMg)} g is held as silver advance</>
          )}
          .
        </p>
      )}
    </div>
  );
}

export default function OwnerBillActions({ billId, compact = false }: OwnerBillActionsProps) {
  const allowed = useOwnerActions();
  useRowCacheVersion('bills');
  const [cancelling, setCancelling] = useState(false);
  const facts = getBillFacts(billId);
  if (!allowed || !facts) return null;

  // the buttons go as soon as the bill is cancelled, but the dialog stays until the owner closes it: it holds the answer (or the words of an outcome that could not be confirmed),
  // and the poll that follows the write may show the bill cancelled before the owner has read either
  const live = facts.status === 'active';
  const size = compact ? 'py-1 px-2 text-xs' : 'py-2 text-xs';
  return (
    <>
      {live && (
        <span data-testid="owner-bill-actions" className="inline-flex flex-wrap items-center gap-2">
          {facts.docType === 'estimate' && (
            <Link
              href={`/billing-pos?reissue=${facts.id}`}
              data-testid="reissue-bill"
              className={`btn-secondary inline-flex items-center gap-1 ${size}`}
            >
              <FilePenLine size={13} /> Re-issue
            </Link>
          )}
          <button
            type="button"
            data-testid="cancel-bill"
            onClick={() => setCancelling(true)}
            className={`inline-flex items-center gap-1 rounded-sm border border-red-200 font-semibold text-red-600 hover:bg-red-50 ${size}`}
          >
            <Ban size={13} /> Cancel
          </button>
        </span>
      )}
      {cancelling && (
        <ReasonDialog
          testId="cancel"
          title={`Cancel ${facts.billNo}`}
          intro={
            <>
              <p>
                {facts.billNo} stays in the books, marked Cancelled, with your reason. Nothing is
                owed on it and its pieces go back to stock.
              </p>
              <p className="text-xs text-muted-foreground">
                Money already received on it stays with the customer: it is applied to their other
                bills or held as an advance. To correct a bill instead, use Re-issue. A cancel
                cannot be undone.
              </p>
            </>
          }
          reasonLabel="Why is this bill cancelled?"
          confirmLabel="Cancel this bill"
          savingLabel="Cancelling…"
          run={async (reason) => {
            const answer = await saveCancel(facts.customerId, facts.id, { reason });
            return <CancelDone saved={savedCancelFrom(answer)} />;
          }}
          failureOf={(error) => ownerActionFailure(error, { action: 'cancel' })}
          onClose={() => setCancelling(false)}
        />
      )}
    </>
  );
}
