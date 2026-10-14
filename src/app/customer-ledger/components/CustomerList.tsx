'use client';
import React, { useState } from 'react';
import { Search, AlertCircle } from 'lucide-react';
import type { Customer } from '@/lib/mockData';

interface CustomerListProps {
  customers: Customer[];
  selectedId: string | null;
  onSelect: (c: Customer) => void;
}

export default function CustomerList({ customers, selectedId, onSelect }: CustomerListProps) {
  const [query, setQuery] = useState('');

  const filtered = customers.filter(
    (c) =>
      c.name.toLowerCase().includes(query.toLowerCase()) ||
      c.mobile.includes(query)
  );

  return (
    <div className="jewel-card overflow-hidden">
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search customers..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input-field pl-8 text-xs py-1.5"
          />
        </div>
      </div>
      <div className="divide-y divide-border max-h-[calc(100vh-200px)] overflow-y-auto scrollbar-thin">
        {filtered.map((customer) => (
          <button
            key={`cust-list-${customer.id}`}
            onClick={() => onSelect(customer)}
            className={`w-full px-3 py-3 text-left transition-colors hover:bg-muted/50 ${
              selectedId === customer.id ? 'bg-gold-subtle border-r-2 border-r-primary' : ''
            }`}
          >
            <div className="flex items-center gap-2.5">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold ${
                selectedId === customer.id ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}>
                {customer.name.charAt(0)}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate">{customer.name}</p>
                <p className="text-xs text-muted-foreground">{customer.mobile}</p>
              </div>
              {customer.outstanding > 0 && (
                <div className="flex items-center gap-1 text-amber-600">
                  <AlertCircle size={11} />
                  <span className="text-xs font-semibold font-tabular">
                    ₹{(customer.outstanding / 1000).toFixed(1)}K
                  </span>
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}