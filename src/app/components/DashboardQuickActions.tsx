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
import { canAccessPath, canAny, type Holder, type TickKey } from '@/lib/access';

export interface QuickAction {
  id: string;
  label: string;
  href: string;
  icon: React.ReactNode;
  color: string;
  /**
   * The tick of what the action does, when that asks for more than opening the screen it goes to (any one of them). An action is offered when the person may open its screen
   * (`canAccessPath`, the table of src/lib/access.ts: Scan Article and New Sale are `bill_make`, Add Design the screen is `stock_add`, Edit Stock `stock_edit`; Inventory and Print Tags are open)
   * and holds this tick if it has one.
   */
  needs?: readonly [TickKey, ...TickKey[]];
}

// Two lists, as there always were: the sales desk (what the owner and the biller had) and the stock room (what staff had). The Owner holds the stock ticks too and still got the sales desk and
// not the stock room, so no filter by ticks alone gives each of the three roles its list: the person who makes bills or takes payments works the sales desk, everybody else the stock room, and
// each list is filtered by the tick of each action.
const SALES_DESK: QuickAction[] = [
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
    // the ledger opens with `customer_view`; taking the payment is `payment_receive` (which needs `customer_view`)
    id: 'qa-payment',
    label: 'Receive Payment',
    href: '/customer-ledger',
    icon: <CreditCard size={18} />,
    color: 'bg-secondary text-foreground border border-border',
    needs: ['payment_receive'],
  },
];

const STOCK_ROOM: QuickAction[] = [
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

/** The quick actions a person gets, in order: the list of their desk, each action for the tick of what it does. Nobody who is not known gets one. */
export function quickActionsFor(who: Holder | null): QuickAction[] {
  const list = canAny(who, ['bill_make', 'payment_receive']) ? SALES_DESK : STOCK_ROOM;
  return list.filter(
    (action) =>
      canAccessPath(who, action.href) && (action.needs === undefined || canAny(who, action.needs))
  );
}

export default function DashboardQuickActions({ holder }: { holder: Holder | null }) {
  const actions = quickActionsFor(holder);
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
