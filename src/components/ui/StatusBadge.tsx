import React from 'react';
import type { SkuStatus } from '@/lib/mockData';

const STATUS_MAP: Record<SkuStatus, { className: string; label: string }> = {
  'In Stock': { className: 'status-badge-instock', label: 'In Stock' },
  Reserved: { className: 'status-badge-reserved', label: 'Reserved' },
  'On Approval': { className: 'status-badge-approval', label: 'On Approval' },
  Sold: { className: 'status-badge-sold', label: 'Sold' },
  Returned: { className: 'status-badge-returned', label: 'Returned' },
  Repair: { className: 'status-badge-repair', label: 'Repair' },
  Transferred: { className: 'status-badge-transferred', label: 'Transferred' },
  Missing: { className: 'status-badge-missing', label: 'Missing' },
  Damaged: { className: 'status-badge-damaged', label: 'Damaged' },
  Archived: { className: 'status-badge-archived', label: 'Archived' },
};

interface StatusBadgeProps {
  status: SkuStatus;
  size?: 'xs' | 'sm' | 'md';
}

export default function StatusBadge({ status, size = 'md' }: StatusBadgeProps) {
  const config = STATUS_MAP[status] ?? { className: 'status-badge-archived', label: status };
  return (
    <span
      className={`
        inline-flex items-center font-semibold rounded-full
        ${size === 'xs' ? 'text-[10px] px-1.5 py-0.5' : size === 'sm' ? 'text-xs px-2 py-0.5' : 'text-xs px-2.5 py-1'}
        ${config.className}
      `}
    >
      {config.label}
    </span>
  );
}
