'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import Topbar from './Topbar';
import LoginScreen from './LoginScreen';
import ChangePasswordScreen from './ChangePasswordScreen';
import ConnectionBanner from './ConnectionBanner';
import { canAccessPath, retrySession, signOut, useSession } from '@/lib/authStore';
import {
  isGateOpen,
  progressText,
  resourcesFor,
  retryHydrate,
  startHydrate,
  useHydrate,
} from '@/lib/cache/hydrate';

interface AppLayoutProps {
  children: React.ReactNode;
}

// U7: the one gate. It shows, in this order, a loading screen, the login screen, then the app. The state it reads is the
// module-level one in authStore, so moving from page to page (each page wraps itself in this layout) never shows the
// loading screen again, and no page reads the session on its own. Between the login screen and the app stands one more screen
// for one kind of person: a user whose password is still the temporary one sees the change-password screen and nothing else (U11).
// `epoch` goes up each time the gate is opened for a person and a role (a login, start-up, a change of role): the page body is
// keyed on it, so that a role that changed in the middle of a shift starts the page afresh instead of keeping what the old role saw.
// WEB04 (C4, C7): once the gate is open the poller (src/lib/cache/poll.ts, started by importing it through ConnectionBanner) brings in what other people changed, and the banner
// at the top says when the server cannot be reached or is waking up.
// WEB03 (C2): between the login and the app stands the data gate. A signed-in person sees no data page until the first full hydrate of THIS role in THIS
// epoch has finished (src/lib/cache/hydrate.ts): "3 of 8 tables" while it runs, the plain message and a retry button if it fails, never sample data and
// never an empty list. The load lives at module level, so moving from page to page (each page wraps itself in this layout) never loads again.
export default function AppLayout({ children }: AppLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { status, session, role, notice, error, epoch } = useSession();
  const hydrate = useHydrate();
  const pathname = usePathname();

  // asked again by every page that mounts, answered once: a load of the same role and epoch is not started twice
  useEffect(() => {
    if (status === 'signedIn' && role) startHydrate(role, epoch);
  }, [status, role, epoch]);

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="jewel-card p-6 max-w-sm w-full space-y-4 text-center">
          <p role="alert" className="text-sm font-semibold text-red-600">
            {error}
          </p>
          <div className="flex gap-2 justify-center">
            <button type="button" className="btn-primary" onClick={() => retrySession()}>
              Try again
            </button>
            <button type="button" className="btn-secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p role="status" className="text-sm text-muted-foreground">
          Loading...
        </p>
      </div>
    );
  }
  if (status === 'signedOut' || !session) return <LoginScreen notice={notice} />;
  if (status === 'mustChangePassword') return <ChangePasswordScreen session={session} />;
  if (!isGateOpen(hydrate, role, epoch)) {
    return <DataGate failed={hydrate.status === 'error' ? hydrate.error : null} state={hydrate} />;
  }

  const allowed = canAccessPath(role, pathname || '/');

  // WEB13 (QA UI-03): the print shell. On screen the shell is as tall as the window and `main` scrolls inside it; on paper that would cut a page at the window's height and print the bars.
  // The names app-shell, app-main-column, app-scroll, app-page and app-chrome are the hooks of the print rules in src/styles/tailwind.css (@media print): the bars are not printed, the
  // shell lets go of the height, and the page is as long as what is on it, whatever the page is (the estimate, the tags, any other screen a person prints).
  return (
    <div className="app-shell flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <div className="app-chrome hidden lg:flex flex-shrink-0">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((p) => !p)}
          session={session}
        />
      </div>

      {/* Main Content */}
      <div className="app-main-column flex-1 flex flex-col overflow-hidden">
        {/* C7: "Offline: changes cannot be saved" or "Waking up…"; every Save control is off while it shows */}
        <div className="app-chrome contents">
          <ConnectionBanner />
        </div>
        <div className="app-chrome contents">
          <Topbar onMenuClick={() => setSidebarCollapsed((p) => !p)} session={session} />
        </div>
        <main className="app-scroll flex-1 overflow-y-auto scrollbar-thin">
          <div
            key={epoch}
            className="app-page max-w-screen-2xl mx-auto px-4 lg:px-6 xl:px-8 2xl:px-10 py-5 pb-24 lg:pb-6"
          >
            {allowed ? (
              children
            ) : (
              <div className="jewel-card p-8 text-center max-w-lg mx-auto mt-16">
                <h1 className="text-xl font-bold text-foreground">Not available for your role</h1>
                <p className="text-sm text-muted-foreground mt-2">
                  This screen is not part of your access. Ask the owner if you need it.
                </p>
                <Link href="/" className="btn-primary mt-5 inline-flex">
                  Go to Dashboard
                </Link>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <div className="app-chrome contents">
        <MobileNav session={session} />
      </div>
    </div>
  );
}

/** C2: the loading screen of the data. The numbers are those of the load that is running; before it has started the count is that of the role's tables. */
function DataGate({
  failed,
  state,
}: {
  failed: string | null;
  state: ReturnType<typeof useHydrate>;
}) {
  const { role } = useSession();
  if (failed !== null) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="jewel-card p-6 max-w-sm w-full space-y-4 text-center">
          <h1 className="text-base font-bold text-foreground">The data could not be loaded</h1>
          <p role="alert" className="text-sm font-semibold text-red-600">
            {failed}
          </p>
          <div className="flex gap-2 justify-center">
            <button type="button" className="btn-primary" onClick={() => retryHydrate()}>
              Try again
            </button>
            <button type="button" className="btn-secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }
  const total = state.tablesTotal || (role ? resourcesFor(role).length : 0);
  const done = state.tablesTotal ? state.tablesDone : 0;
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="jewel-card p-6 max-w-sm w-full space-y-3 text-center">
        <p role="status" className="text-sm font-semibold text-foreground">
          Loading your data
        </p>
        <div
          role="progressbar"
          aria-label="Loading your data"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-2 w-full overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-all"
            style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }}
          />
        </div>
        <p data-testid="hydrate-progress" className="text-xs text-muted-foreground font-tabular">
          {progressText({ tablesDone: done, tablesTotal: total })}
        </p>
      </div>
    </div>
  );
}
