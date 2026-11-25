'use client';
import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ClipboardList,
  LayoutDashboard,
  Package,
  ReceiptText,
  ScanLine,
  ShoppingCart,
} from 'lucide-react';
import { canAccessPath } from '@/lib/access';
import type { AuthSession } from '@/lib/authStore';

const MOBILE_NAV = [
  { id: 'mnav-home', label: 'Home', href: '/', icon: <LayoutDashboard size={20} /> },
  {
    id: 'mnav-inventory',
    label: 'Inventory',
    href: '/inventory-management',
    icon: <Package size={20} />,
  },
  {
    id: 'mnav-scan',
    label: 'Scan',
    href: '/scan-detail',
    icon: <ScanLine size={24} />,
    isCenter: true,
  },
  { id: 'mnav-sale', label: 'Sale', href: '/billing-pos', icon: <ShoppingCart size={20} /> },
  // FB-A2: the saved estimates were not reachable from a phone (the owner and the biller; staff may not open the screen)
  { id: 'mnav-estimates', label: 'Estimates', href: '/estimate', icon: <ReceiptText size={20} /> },
  // FB-F1: the Order Book (every role)
  { id: 'mnav-orders', label: 'Orders', href: '/order-book', icon: <ClipboardList size={20} /> },
];

export default function MobileNav({ session }: { session: AuthSession }) {
  const pathname = usePathname();
  // U5: only the screens the person may open (the same table as the route gate, src/lib/access.ts; the session is the Holder).
  const visibleNav = MOBILE_NAV.filter((item) => canAccessPath(session, item.href));

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-50 lg:hidden">
      <div className="flex items-end justify-around px-2 pb-2 pt-1">
        {visibleNav?.map((item) => {
          const isActive = item?.href === '/' ? pathname === '/' : pathname?.startsWith(item?.href);
          if (item?.isCenter) {
            return (
              <Link key={item?.id} href={item?.href} className="flex flex-col items-center -mt-5">
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
              // six buttons for the owner (FB-F1 added Orders): a narrow side padding keeps them all inside a 375 px phone
              className={`flex flex-col items-center gap-0.5 px-1.5 py-1.5 rounded-sm transition-colors ${
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
