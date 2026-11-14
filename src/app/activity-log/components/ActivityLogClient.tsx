'use client';

import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Loader2 } from 'lucide-react';
import {
  createAuditFeed,
  describeAudit,
  type AuditFeedState,
  type AuditLine,
} from '@/lib/activityLog';
import { readAuditPage } from '@/lib/cache/booksServer';
import { useRowCacheVersion } from '@/lib/cache/useRowCache';
import { getSettings } from '@/lib/settingsStore';

// FB-D4 (Siddhi #12): the owner's activity log. Who logged in and out, and every change the shop's books took, newest first, in India time, in plain words (src/lib/activityLog.ts). The
// screen reads ONE page of 200 rows from `GET /v1/audit-log` when it opens and one more for each press of "Load more": a shop whose log has 10,000 rows draws 200 until it is asked for more.
// Nothing is changed or deleted here; the API gives the log to the owner alone.

const Row = React.memo(function Row({ id, line }: { id: number; line: AuditLine }) {
  return (
    // the id of the audit row (the server's own) is on the row so that a test can tell that no row was drawn twice or left out
    <tr data-testid="activity-row" data-audit-id={id} className="table-row-hover">
      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{line.when}</td>
      <td className="px-3 py-2.5 font-semibold text-foreground whitespace-nowrap">{line.who}</td>
      <td className="px-3 py-2.5 text-foreground">{line.what}</td>
    </tr>
  );
});

/** The log as the feed holds it now (drawn from the state it is given: the container below gives it the screen's). */
export function ActivityLogView({
  state,
  users,
  onMore,
}: {
  state: AuditFeedState;
  users: ReadonlyMap<string, string>;
  onMore: () => void;
}) {
  const lines = useMemo(
    () => state.rows.map((row) => ({ id: row.id, line: describeAudit(row, users) })),
    [state.rows, users]
  );
  const loading = state.state === 'loading';
  const first = state.rows.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Activity Log</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Who did what, newest first. Times are India time.
        </p>
      </div>

      <div className="jewel-card overflow-hidden">
        {first && loading && (
          <p data-testid="activity-loading" className="p-6 text-sm text-muted-foreground">
            Loading the activity log...
          </p>
        )}
        {first && state.state === 'ready' && (
          <p data-testid="activity-empty" className="p-6 text-sm text-muted-foreground">
            Nothing has been logged yet.
          </p>
        )}
        {!first && (
          <div className="overflow-x-auto scrollbar-thin">
            <table data-testid="activity-table" className="w-full text-xs">
              <thead>
                <tr className="bg-muted/60 border-b border-border">
                  {['When', 'Who', 'What'].map((heading) => (
                    <th
                      key={heading}
                      className="px-3 py-2.5 text-left font-semibold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((one) => (
                  <Row key={one.id} id={one.id} line={one.line} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.state === 'failed' && (
          <p
            role="alert"
            data-testid="activity-error"
            className="m-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
          >
            {state.message}
          </p>
        )}
        {!first && (
          <p data-testid="activity-count" className="px-4 pt-3 text-xs text-muted-foreground">
            {state.rows.length} {state.rows.length === 1 ? 'entry' : 'entries'} shown
          </p>
        )}
        {(state.more || (first && state.state === 'failed')) && (
          <div className="p-4">
            <button
              type="button"
              data-testid="activity-load-more"
              onClick={onMore}
              disabled={loading}
              className="btn-secondary py-2"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : null}
              {first ? 'Try again' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function ActivityLogClient() {
  const [feed] = useState(() => createAuditFeed(readAuditPage));
  const state = useSyncExternalStore(feed.subscribe, feed.state, feed.state);
  // the names of the people: the users the Settings screen lists (the same read, from memory)
  const usersVersion = useRowCacheVersion('users');
  const users = useMemo(
    () => new Map(getSettings().users.map((user) => [user.id, user.name])),
    // the version is what changes when the users in memory do
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [usersVersion]
  );

  useEffect(() => {
    void feed.open();
  }, [feed]);

  return <ActivityLogView state={state} users={users} onMore={() => void feed.loadMore()} />;
}
