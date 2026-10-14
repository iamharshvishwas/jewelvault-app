'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { getCategories } from '@/lib/catalogStore';

const MATERIALS = ['Gold', 'Silver'];
const PURITIES = ['18K', '20K', '22K', '24K', '800', '925', '999'];
const STATUSES = ['In Stock', 'Reserved', 'On Approval', 'Sold', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived'];
const LOCATIONS = ['Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition'];

interface FilterSection {
  id: string;
  label: string;
  options: string[];
}

export default function InventoryFilters() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['fs-material', 'fs-category', 'fs-status']));
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [categories, setCategories] = useState<string[]>(() => getCategories());

  useEffect(() => {
    const interval = setInterval(() => setCategories(getCategories()), 1000);
    return () => clearInterval(interval);
  }, []);

  const filterSections: FilterSection[] = useMemo(
    () => [
      { id: 'fs-material', label: 'Material', options: MATERIALS },
      { id: 'fs-category', label: 'Category', options: categories },
      { id: 'fs-purity', label: 'Purity', options: PURITIES },
      { id: 'fs-status', label: 'Status', options: STATUSES },
      { id: 'fs-location', label: 'Location', options: LOCATIONS },
    ],
    [categories]
  );

  const toggle = (sectionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  const toggleOption = (sectionId: string, option: string) => {
    setSelected((prev) => {
      const sectionSet = new Set(prev[sectionId] ?? []);
      if (sectionSet.has(option)) sectionSet.delete(option);
      else sectionSet.add(option);
      return { ...prev, [sectionId]: sectionSet };
    });
  };

  const totalActive = Object.values(selected).reduce((a, s) => a + s.size, 0);

  const clearAll = () => setSelected({});

  return (
    <aside className="hidden lg:block w-52 xl:w-56 flex-shrink-0">
      <div className="jewel-card p-3 sticky top-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
          <span className="text-xs font-semibold text-foreground uppercase tracking-wider">Filters</span>
          {totalActive > 0 && (
            <button onClick={clearAll} className="flex items-center gap-1 text-xs text-primary hover:underline">
              <X size={11} /> Clear ({totalActive})
            </button>
          )}
        </div>

        {/* Search within inventory */}
        <div className="mb-3">
          <input
            type="text"
            placeholder="Search designs, SKUs..."
            className="input-field text-xs py-1.5"
          />
        </div>

        {/* Filter Sections */}
        <div className="space-y-1">
          {filterSections.map((section) => {
            const isExpanded = expanded.has(section.id);
            const sectionSelected = selected[section.id] ?? new Set();

            return (
              <div key={section.id} className="border-b border-border last:border-0 pb-2 mb-2 last:pb-0 last:mb-0">
                <button
                  onClick={() => toggle(section.id)}
                  className="w-full flex items-center justify-between py-1.5 text-xs font-semibold text-foreground hover:text-primary transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    {section.label}
                    {sectionSelected.size > 0 && (
                      <span className="bg-primary text-primary-foreground text-xs px-1.5 py-0.5 rounded-full font-semibold">
                        {sectionSelected.size}
                      </span>
                    )}
                  </span>
                  {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>

                {isExpanded && (
                  <div className="space-y-1 mt-1">
                    {section.options.map((option) => {
                      const checked = sectionSelected.has(option);
                      return (
                        <label
                          key={`filter-${section.id}-${option}`}
                          className="flex items-center gap-2 cursor-pointer group"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleOption(section.id, option)}
                            className="w-3.5 h-3.5 rounded border-border accent-primary"
                          />
                          <span className={`text-xs transition-colors ${checked ? 'text-primary font-semibold' : 'text-muted-foreground group-hover:text-foreground'}`}>
                            {option}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Weight Range */}
        <div className="mt-3 pt-3 border-t border-border">
          <p className="text-xs font-semibold text-foreground mb-2">Weight Range (g)</p>
          <div className="flex items-center gap-2">
            <input type="number" placeholder="Min" className="input-field text-xs py-1.5 w-full" min={0} step={0.001} />
            <span className="text-muted-foreground text-xs">–</span>
            <input type="number" placeholder="Max" className="input-field text-xs py-1.5 w-full" min={0} step={0.001} />
          </div>
        </div>
      </div>
    </aside>
  );
}
