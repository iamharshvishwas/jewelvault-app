'use client';
import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import MobileNav from './MobileNav';
import Topbar from './Topbar';
import LoginScreen from './LoginScreen';
import { canAccessPath, getSession, type AuthSession } from '@/lib/authStore';

interface AppLayoutProps {
  children: React.ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [session, setSession] = useState<AuthSession | null>(null);
  const [ready, setReady] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setSession(getSession());
    setReady(true);
  }, []);

  if (!ready) return <div className="min-h-screen bg-background" />;
  if (!session) return <LoginScreen onLogin={setSession} />;

  const allowed = canAccessPath(session.role, pathname || '/');

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <div className="hidden lg:flex flex-shrink-0">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((p) => !p)}
          session={session}
          onSessionChange={setSession}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <Topbar onMenuClick={() => setSidebarCollapsed((p) => !p)} session={session} onSessionChange={setSession} />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="max-w-screen-2xl mx-auto px-4 lg:px-6 xl:px-8 2xl:px-10 py-5 pb-24 lg:pb-6">
            {allowed ? children : (
              <div className="jewel-card p-8 text-center max-w-lg mx-auto mt-16">
                <h1 className="text-xl font-bold text-foreground">Admin Access Required</h1>
                <p className="text-sm text-muted-foreground mt-2">
                  Staff can only use inventory, add/edit stock, print tags, and catalogue pages.
                </p>
                <Link href="/inventory-management" className="btn-primary mt-5 inline-flex">
                  Go to Inventory
                </Link>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <MobileNav session={session} />
    </div>
  );
}
