import React from 'react';

const AUDIT_ENTRIES = [
  { id: 'audit-001', date: '2026-08-15 14:32', user: 'Jaishri Admin', action: 'Status Changed', entity: 'SET-00572-003', oldValue: 'In Stock', newValue: 'Sold', field: 'Status' },
  { id: 'audit-002', date: '2026-08-15 14:30', user: 'Jaishri Admin', action: 'Invoice Created', entity: 'JG-2026-0841', oldValue: '', newValue: '', field: '' },
  { id: 'audit-003', date: '2026-07-02 11:00', user: 'Meena Patel', action: 'Labour Updated', entity: 'SET-00572', oldValue: '₹11,500', newValue: '₹12,500', field: 'Labour' },
  { id: 'audit-004', date: '2026-06-10 10:10', user: 'Jaishri Admin', action: 'SKU Created', entity: 'SET-00572-003', oldValue: '', newValue: 'In Stock', field: 'Status' },
  { id: 'audit-005', date: '2026-06-10 10:05', user: 'Jaishri Admin', action: 'SKU Created', entity: 'SET-00572-002', oldValue: '', newValue: 'In Stock', field: 'Status' },
  { id: 'audit-006', date: '2026-06-10 10:00', user: 'Jaishri Admin', action: 'SKU Created', entity: 'SET-00572-001', oldValue: '', newValue: 'In Stock', field: 'Status' },
  { id: 'audit-007', date: '2026-06-10 09:30', user: 'Jaishri Admin', action: 'Design Created', entity: 'SET-00572', oldValue: '', newValue: '', field: '' },
];

const ACTION_COLORS: Record<string, string> = {
  'Design Created': 'bg-blue-100 text-blue-700',
  'SKU Created': 'bg-emerald-100 text-emerald-700',
  'Status Changed': 'bg-amber-100 text-amber-700',
  'Invoice Created': 'bg-purple-100 text-purple-700',
  'Labour Updated': 'bg-orange-100 text-orange-700',
};

export default function DesignAuditLog() {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-foreground">Audit Trail — {AUDIT_ENTRIES.length} events</h3>
      <div className="space-y-2">
        {AUDIT_ENTRIES.map((entry) => (
          <div key={entry.id} className="flex items-start gap-3 p-3 bg-muted/30 rounded-lg hover:bg-muted/50 transition-colors">
            <div className="flex-shrink-0 mt-0.5">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${ACTION_COLORS[entry.action] ?? 'bg-muted text-muted-foreground'}`}>
                {entry.action}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono font-bold text-foreground">{entry.entity}</span>
                {entry.oldValue && entry.newValue && (
                  <span className="text-xs text-muted-foreground">
                    {entry.field}: <span className="line-through text-red-500">{entry.oldValue}</span>
                    {' → '}
                    <span className="text-emerald-600 font-semibold">{entry.newValue}</span>
                  </span>
                )}
              </div>
            </div>
            <div className="flex-shrink-0 text-right">
              <p className="text-xs font-semibold text-foreground">{entry.user}</p>
              <p className="text-xs text-muted-foreground">{entry.date}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
