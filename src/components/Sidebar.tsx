'use client';
import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import AppLogo from '@/components/ui/AppLogo';
import {
  BUSINESS_OWNER_INITIALS,
  BUSINESS_OWNER_NAME,
  BUSINESS_SHORT_NAME,
} from '@/lib/businessConfig';
import { signOut, type AuthSession } from '@/lib/authStore';
import {
  LayoutDashboard,
  Package,
  Tag,
  ShoppingCart,
  Users,
  Warehouse,
  BarChart3,
  Settings,
  ChevronDown,
  ChevronRight,
  Plus,
  Printer,
  ReceiptText,
  UserCircle,
  CreditCard,
  Layers,
  SlidersHorizontal,
  Shield,
  Hash,
  FileText,
  Gem,
  Menu,
  X,
  ScanLine,
} from 'lucide-react';

interface NavItem {
  id: string;
  label: string;
  href?: string;
  icon: React.ReactNode;
  badge?: number;
  children?: NavItem[];
}

const NAV_ITEMS: NavItem[] = [
  {
    id: 'nav-dashboard',
    label: 'Dashboard',
    href: '/',
    icon: <LayoutDashboard size={18} />,
  },
  {
    id: 'nav-inventory',
    label: 'Inventory',
    icon: <Package size={18} />,
    children: [
      { id: 'nav-designs', label: 'Designs', href: '/inventory-management', icon: <Gem size={15} /> },
      { id: 'nav-catalogue', label: 'Customer Catalogue', href: '/catalogue', icon: <ShoppingCart size={15} /> },
      { id: 'nav-all-skus', label: 'All SKUs', href: '/inventory-management', icon: <Tag size={15} /> },
      { id: 'nav-categories', label: 'Categories', href: '/settings?tab=categories', icon: <Layers size={15} /> },
      { id: 'nav-add-design', label: 'Add Design', href: '/add-design', icon: <Plus size={15} /> },
      { id: 'nav-print-tags', label: 'Print Tags', href: '/print-tags', icon: <Printer size={15} /> },
    ],
  },
  {
    id: 'nav-scan',
    label: 'Scan Article',
    href: '/scan-detail',
    icon: <ScanLine size={18} />,
  },
  {
    id: 'nav-sales',
    label: 'Sales',
    icon: <ShoppingCart size={18} />,
    children: [
      { id: 'nav-new-sale', label: 'New Estimate', href: '/billing-pos', icon: <Plus size={15} /> },
      { id: 'nav-order-book', label: 'Order Book', href: '/order-book', icon: <FileText size={15} /> },
      { id: 'nav-invoices', label: 'Saved Estimates', href: '/estimate', icon: <ReceiptText size={15} /> },
    ],
  },
  {
    id: 'nav-customers',
    label: 'Customers',
    icon: <Users size={18} />,
    children: [
      { id: 'nav-cust-list', label: 'Customers & Ledger', href: '/customer-ledger', icon: <UserCircle size={15} /> },
      { id: 'nav-payments', label: 'Receive Payment', href: '/customer-ledger', icon: <CreditCard size={15} /> },
    ],
  },
  {
    id: 'nav-stock',
    label: 'Stock',
    icon: <Warehouse size={18} />,
    children: [
      { id: 'nav-stock-list', label: 'Stock List', href: '/inventory-management', icon: <Package size={15} /> },
      { id: 'nav-edit-stock', label: 'Edit Stock', href: '/edit-stock', icon: <SlidersHorizontal size={15} /> },
      { id: 'nav-stock-tags', label: 'Print Tags', href: '/print-tags', icon: <Printer size={15} /> },
    ],
  },
  {
    id: 'nav-reports',
    label: 'Reports',
    href: '/reports',
    icon: <BarChart3 size={18} />,
  },
  {
    id: 'nav-settings',
    label: 'Settings',
    icon: <Settings size={18} />,
    children: [
      { id: 'nav-materials', label: 'Materials & Purities', href: '/settings?tab=materials', icon: <Gem size={15} /> },
      { id: 'nav-cat-settings', label: 'Categories', href: '/settings?tab=categories', icon: <Layers size={15} /> },
      { id: 'nav-custom-fields', label: 'Custom Fields', href: '/settings?tab=custom-fields', icon: <SlidersHorizontal size={15} /> },
      { id: 'nav-tag-templates', label: 'Tag Templates', href: '/settings?tab=tag-templates', icon: <Printer size={15} /> },
      { id: 'nav-invoice-settings', label: 'Estimate Settings', href: '/settings?tab=invoice-settings', icon: <FileText size={15} /> },
      { id: 'nav-taxes', label: 'Taxes', href: '/settings?tab=taxes', icon: <Hash size={15} /> },
      { id: 'nav-users', label: 'Users & Permissions', href: '/settings?tab=users', icon: <Shield size={15} /> },
      { id: 'nav-numbering', label: 'Numbering', href: '/settings?tab=numbering', icon: <Hash size={15} /> },
      { id: 'nav-business', label: 'Business Settings', href: '/settings?tab=business', icon: <Settings size={15} /> },
    ],
  },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  session: AuthSession;
  onSessionChange: (session: AuthSession | null) => void;
}

function navForRole(session: AuthSession) {
  if (session.role === 'Admin') return NAV_ITEMS;
  return NAV_ITEMS
    .filter((item) => ['nav-dashboard', 'nav-inventory', 'nav-stock'].includes(item.id))
    .map((item) => {
      if (!item.children) return item;
      return {
        ...item,
        children: item.children.filter((child) =>
          ['nav-designs', 'nav-catalogue', 'nav-all-skus', 'nav-add-design', 'nav-print-tags', 'nav-stock-list', 'nav-edit-stock', 'nav-stock-tags'].includes(child.id)
        ),
      };
    });
}

export default function Sidebar({ collapsed, onToggle, session, onSessionChange }: SidebarProps) {
  const pathname = usePathname();
  const visibleNav = navForRole(session);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(session.role === 'Admin' ? ['nav-inventory', 'nav-sales'] : ['nav-inventory', 'nav-stock'])
  );

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isActive = (href?: string) => {
    if (!href) return false;
    if (href === '/') return pathname === '/';
    return pathname.startsWith(href);
  };

  return (
    <aside
      className={`
        flex flex-col h-full bg-card border-r border-border transition-all duration-300 ease-in-out
        ${collapsed ? 'w-16' : 'w-60'}
      `}
    >
      {/* Logo */}
      <div className={`flex items-center border-b border-border ${collapsed ? 'justify-center px-3 py-4' : 'px-4 py-4 gap-2'}`}>
        <Link href="/" className={`flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity ${collapsed ? 'justify-center' : ''}`}>
          <AppLogo size={32} />
          {!collapsed && (
            <span className="font-bold text-sm text-foreground tracking-tight leading-tight">
              {BUSINESS_SHORT_NAME}
            </span>
          )}
        </Link>
        <button
          onClick={onToggle}
          className="ml-auto btn-ghost p-1.5 rounded-sm"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <Menu size={16} /> : <X size={16} />}
        </button>
      </div>

      {/* Nav Items */}
      <nav className="flex-1 overflow-y-auto py-3 scrollbar-thin">
        {visibleNav.map((item) => {
          const hasChildren = item.children && item.children.length > 0;
          const isExpanded = expandedSections.has(item.id);
          const active = isActive(item.href);

          if (collapsed) {
            return (
              <div key={item.id} className="relative group px-2 mb-1">
                {item.href ? (
                  <Link
                    href={item.href}
                    className={`
                      flex items-center justify-center w-full p-2.5 rounded-sm nav-item-hover
                      ${active ? 'bg-secondary text-primary' : 'text-muted-foreground'}
                    `}
                  >
                    {item.icon}
                  </Link>
                ) : (
                  <button
                    className="flex items-center justify-center w-full p-2.5 rounded-sm nav-item-hover text-muted-foreground"
                    onClick={() => toggleSection(item.id)}
                  >
                    {item.icon}
                  </button>
                )}
                {/* Tooltip */}
                <div className="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 bg-foreground text-primary-foreground text-xs rounded-sm whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none z-50 transition-opacity duration-150">
                  {item.label}
                </div>
              </div>
            );
          }

          return (
            <div key={item.id} className="px-2 mb-0.5">
              {hasChildren ? (
                <>
                  <button
                    onClick={() => toggleSection(item.id)}
                    className={`
                      w-full flex items-center gap-2.5 px-3 py-2 rounded-sm nav-item-hover text-sm
                      ${isExpanded ? 'text-foreground font-600' : 'text-muted-foreground font-500'}
                    `}
                  >
                    <span className={isExpanded ? 'text-primary' : ''}>{item.icon}</span>
                    <span className="flex-1 text-left font-medium">{item.label}</span>
                    {isExpanded ? (
                      <ChevronDown size={14} className="text-muted-foreground" />
                    ) : (
                      <ChevronRight size={14} className="text-muted-foreground" />
                    )}
                  </button>
                  {isExpanded && (
                    <div className="ml-4 mt-0.5 border-l border-border pl-3 space-y-0.5">
                      {item.children!.map((child) => {
                        const childActive = isActive(child.href);
                        return (
                          <Link
                            key={child.id}
                            href={child.href || '/'}
                            className={`
                              flex items-center gap-2 px-2 py-1.5 rounded-sm text-xs nav-item-hover
                              ${childActive ? 'nav-active font-semibold' : 'text-muted-foreground font-medium'}
                            `}
                          >
                            {child.icon}
                            <span className="flex-1">{child.label}</span>
                            {child.badge ? (
                              <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full font-semibold">
                                {child.badge}
                              </span>
                            ) : null}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <Link
                  href={item.href || '/'}
                  className={`
                    flex items-center gap-2.5 px-3 py-2 rounded-sm nav-item-hover text-sm
                    ${active ? 'nav-active font-semibold' : 'text-muted-foreground font-medium'}
                  `}
                >
                  <span>{item.icon}</span>
                  <span className="flex-1">{item.label}</span>
                </Link>
              )}
            </div>
          );
        })}
      </nav>

      {/* User */}
      {!collapsed && (
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-sm hover:bg-muted transition-colors">
            <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-xs font-bold text-primary">{session.role === 'Admin' ? BUSINESS_OWNER_INITIALS : 'ST'}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground truncate">{session.role === 'Admin' ? BUSINESS_OWNER_NAME : session.displayName}</p>
              <p className="text-xs text-muted-foreground">{session.role}</p>
            </div>
            <button
              type="button"
              onClick={() => {
                signOut();
                onSessionChange(null);
              }}
              className="text-xs text-primary hover:underline"
            >
              Logout
            </button>
          </div>
        </div>
      )}
      {collapsed && (
        <div className="border-t border-border p-2 flex justify-center">
          <button
            type="button"
            onClick={() => {
              signOut();
              onSessionChange(null);
            }}
            className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center"
            title="Logout"
          >
            <span className="text-xs font-bold text-primary">{session.role === 'Admin' ? BUSINESS_OWNER_INITIALS : 'ST'}</span>
          </button>
        </div>
      )}
    </aside>
  );
}
