'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import AppLogo from '@/components/ui/AppLogo';
import { Search, Bell, LogOut, Menu, Plus } from 'lucide-react';
import { BUSINESS_OWNER_INITIALS, BUSINESS_SHORT_NAME } from '@/lib/businessConfig';
import { signOut, type AuthSession } from '@/lib/authStore';

interface TopbarProps {
  onMenuClick: () => void;
  session: AuthSession;
  onSessionChange: (session: AuthSession | null) => void;
}

export default function Topbar({ onMenuClick, session, onSessionChange }: TopbarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  return (
    <header className="h-14 bg-card border-b border-border flex items-center gap-3 px-4 lg:px-6 flex-shrink-0">
      {/* Mobile logo */}
      <div className="flex items-center gap-2 lg:hidden">
        <button onClick={onMenuClick} className="btn-ghost p-1.5">
          <Menu size={20} />
        </button>
        <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
          <AppLogo size={28} />
          <span className="font-bold text-sm text-foreground">{BUSINESS_SHORT_NAME}</span>
        </Link>
      </div>

      {/* Search */}
      <div className="flex-1 max-w-lg hidden sm:block">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search Design, SKU, Barcode, Customer or Mobile..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input-field pl-9 py-2 text-sm w-full"
          />
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {/* Quick Add */}
        <Link href="/add-design" className="btn-primary hidden sm:flex py-2">
          <Plus size={15} />
          <span>Add Design</span>
        </Link>

        {/* New Sale */}
        {session.role === 'Admin' && (
          <Link href="/billing-pos" className="btn-secondary hidden md:flex py-2">
            <span>New Sale</span>
          </Link>
        )}

        {/* Notifications */}
        <button className="relative btn-ghost p-2">
          <Bell size={18} />
          <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full" />
        </button>

        {/* Avatar */}
        <button
          type="button"
          onClick={() => {
            signOut();
            onSessionChange(null);
          }}
          className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center"
          title={`Logout ${session.displayName}`}
        >
          <span className="text-xs font-bold text-primary">{session.role === 'Admin' ? BUSINESS_OWNER_INITIALS : 'ST'}</span>
        </button>
        <button
          type="button"
          onClick={() => {
            signOut();
            onSessionChange(null);
          }}
          className="btn-ghost p-2 hidden sm:inline-flex"
          title="Logout"
        >
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}
