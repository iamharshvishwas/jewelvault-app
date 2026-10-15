'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import Topbar from './Topbar';
import LoginScreen from './LoginScreen';
import { PREVIEW_MODE, canAccessPath, retryProfile, signOut, useSession } from '@/lib/authStore';

interface AppLayoutProps {
  children: React.ReactNode;
}

// U7: the one gate. It shows, in this order, a loading screen, the login screen, then the app. The state it reads is the
// module-level one in authStore, so moving from page to page (each page wraps itself in this layout) never shows the
// loading screen again, and no page reads the session on its own.
export default function AppLayout({ children }: AppLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { status, session, role, notice, error } = useSession();
  const pathname = usePathname();

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="jewel-card p-6 max-w-sm w-full space-y-4 text-center">
          <p role="alert" className="text-sm font-semibold text-red-600">
            {error}
          </p>
          <div className="flex gap-2 justify-center">
            <button type="button" className="btn-primary" onClick={() => retryProfile()}>
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

  const allowed = canAccessPath(role, pathname || '/');

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((p) => !p)}
          session={session}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar onMenuClick={() => setSidebarCollapsed((p) => !p)} session={session} />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="max-w-screen-2xl mx-auto px-4 lg:px-6 xl:px-8 2xl:px-10 py-5 pb-24 lg:pb-6">
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
      <MobileNav session={session} />

      {PREVIEW_MODE && (
        <div
          role="note"
          className="fixed bottom-16 lg:bottom-2 left-1/2 -translate-x-1/2 z-50 rounded-full bg-amber-100 border border-amber-300 px-3 py-0.5 text-[11px] font-semibold text-amber-900 shadow-sm pointer-events-none"
        >
          Preview: sample data, kept only in this browser. Nothing is saved to a server.
        </div>
      )}
    </div>
  );
}
