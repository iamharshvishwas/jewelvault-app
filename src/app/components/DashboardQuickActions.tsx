import React from 'react';
import Link from 'next/link';
import {
  Plus,
  ScanLine,
  ShoppingCart,
  Printer,
  ClipboardCheck,
  CreditCard,
  Package,
} from 'lucide-react';
import type { AuthRole } from '@/lib/authStore';

const QUICK_ACTIONS = [
  {
    id: 'qa-add-design',
    label: 'Add Design',
    href: '/inventory-management',
    icon: <Plus size={18} />,
    color: 'bg-primary text-primary-foreground',
  },
  {
    id: 'qa-scan',
    label: 'Scan Article',
    href: '/billing-pos',
    icon: <ScanLine size={18} />,
    color: 'bg-foreground text-primary-foreground',
  },
  {
    id: 'qa-new-sale',
    label: 'New Sale',
    href: '/billing-pos',
    icon: <ShoppingCart size={18} />,
    color: 'bg-emerald-600 text-white',
  },
  {
    id: 'qa-print-tags',
    label: 'Print Tags',
    href: '/print-tags',
    icon: <Printer size={18} />,
    color: 'bg-secondary text-foreground border border-border',
  },
  {
    id: 'qa-audit',
    label: 'Stock Audit',
    href: '/inventory-management',
    icon: <ClipboardCheck size={18} />,
    color: 'bg-secondary text-foreground border border-border',
  },
  {
    id: 'qa-payment',
    label: 'Receive Payment',
    href: '/customer-ledger',
    icon: <CreditCard size={18} />,
    color: 'bg-secondary text-foreground border border-border',
  },
];

const STAFF_QUICK_ACTIONS = [
  {
    id: 'qa-inventory',
    label: 'Inventory',
    href: '/inventory-management',
    icon: <Package size={18} />,
    color: 'bg-primary text-primary-foreground',
  },
  {
    id: 'qa-add-design',
    label: 'Add Design',
    href: '/add-design',
    icon: <Plus size={18} />,
    color: 'bg-secondary text-foreground border border-border',
  },
  {
    id: 'qa-edit-stock',
    label: 'Edit Stock',
    href: '/edit-stock',
    icon: <ClipboardCheck size={18} />,
    color: 'bg-secondary text-foreground border border-border',
  },
  {
    id: 'qa-print-tags',
    label: 'Print Tags',
    href: '/print-tags',
    icon: <Printer size={18} />,
    color: 'bg-secondary text-foreground border border-border',
  },
];

export default function DashboardQuickActions({ role = 'owner' }: { role?: AuthRole }) {
  const actions = role === 'staff' ? STAFF_QUICK_ACTIONS : QUICK_ACTIONS;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-2">
      {actions?.map((action) => (
        <Link
          key={action?.id}
          href={action?.href}
          className={`
            flex flex-col items-center justify-center gap-2 p-3 rounded-xl font-medium text-xs
            transition-all duration-150 hover:scale-105 hover:shadow-jewel-md cursor-pointer
            ${action?.color}
          `}
        >
          {action?.icon}
          <span className="text-center leading-tight">{action?.label}</span>
        </Link>
      ))}
    </div>
  );
}
