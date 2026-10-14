'use client';
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Package, ScanLine, ShoppingCart, BookOpen } from 'lucide-react';
import type { AuthSession } from '@/lib/authStore';

const MOBILE_NAV = [
  { id: 'mnav-home', label: 'Home', href: '/', icon: <LayoutDashboard size={20} /> },
  { id: 'mnav-inventory', label: 'Inventory', href: '/inventory-management', icon: <Package size={20} /> },
  { id: 'mnav-scan', label: 'Scan', href: '/scan-detail', icon: <ScanLine size={24} />, isCenter: true },
  { id: 'mnav-sale', label: 'Sale', href: '/billing-pos', icon: <ShoppingCart size={20} /> },
  { id: 'mnav-catalogue', label: 'Catalogue', href: '/catalogue', icon: <BookOpen size={20} /> },
];

export default function MobileNav({ session }: { session: AuthSession }) {
  const pathname = usePathname();
  const visibleNav = session.role === 'Admin'
    ? MOBILE_NAV
    : MOBILE_NAV.filter((item) => ['mnav-home', 'mnav-inventory', 'mnav-catalogue'].includes(item.id));

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 lg:hidden">
      <div className="flex items-end justify-around px-2 pb-2 pt-1">
        {visibleNav?.map((item) => {
          const isActive = item?.href === '/' ? pathname === '/' : pathname?.startsWith(item?.href);
          if (item?.isCenter) {
            return (
              <Link
                key={item?.id}
                href={item?.href}
                className="flex flex-col items-center -mt-5"
              >
                <span className="w-14 h-14 rounded-full bg-primary flex items-center justify-center text-primary-foreground shadow-gold scan-button-pulse">
                  {item?.icon}
                </span>
                <span className="text-xs mt-1 font-semibold text-primary">{item?.label}</span>
              </Link>
            );
          }
          return (
            <Link
              key={item?.id}
              href={item?.href}
              className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-sm transition-colors ${
                isActive ? 'text-primary' : 'text-muted-foreground'
              }`}
            >
              {item?.icon}
              <span className="text-xs font-medium">{item?.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
