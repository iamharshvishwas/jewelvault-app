'use client';
import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal, X } from 'lucide-react';
import { getCategories } from '@/lib/catalogStore';
import { getDesigns } from '@/lib/designStore';
import { getLocations } from '@/lib/settingsStore';
import { countActiveFilters, locationOptions, type FilterSection } from '@/lib/inventoryFilter';
import {
  clearInventoryFilter,
  setInventorySearch,
  setInventoryWeight,
  toggleInventoryOption,
  useInventoryFilter,
} from '@/lib/inventoryFilterStore';

const MATERIALS = ['Gold', 'Silver'];
const PURITIES = ['18K', '20K', '22K', '24K', '800', '925', '999'];
// the ten statuses of a piece (spec D8)
const STATUSES = [
  'In Stock',
  'Reserved',
  'On Approval',
  'Sold',
  'Returned',
  'Repair',
  'Transferred',
  'Missing',
  'Damaged',
  'Archived',
];

interface PanelSection {
  id: string;
  key: FilterSection;
  label: string;
  options: string[];
}

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((item, i) => item === b[i]);

export default function InventoryFilters() {
  const [expanded, setExpanded] = useState<Set<string>>(
    new Set(['fs-material', 'fs-category', 'fs-status'])
  );
  // under 1024 px the panel is closed behind a "Filters" button; from 1024 px up it is always there and this is not used
  const [panelOpen, setPanelOpen] = useState(false);
  const filter = useInventoryFilter();
  const [categories, setCategories] = useState<string[]>(() => getCategories());
  const [locations, setLocations] = useState<string[]>(() =>
    locationOptions(getDesigns(), getLocations())
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setCategories(getCategories());
      const next = locationOptions(getDesigns(), getLocations());
      setLocations((prev) => (sameList(prev, next) ? prev : next));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // what is ticked belongs to this screen: leaving it clears the filter, so a design added elsewhere is never hidden by a tick nobody remembers
  useEffect(() => clearInventoryFilter, []);

  const filterSections: PanelSection[] = useMemo(
    () => [
      { id: 'fs-material', key: 'material', label: 'Material', options: MATERIALS },
      { id: 'fs-category', key: 'category', label: 'Category', options: categories },
      { id: 'fs-purity', key: 'purity', label: 'Purity', options: PURITIES },
      { id: 'fs-status', key: 'status', label: 'Status', options: STATUSES },
      { id: 'fs-location', key: 'location', label: 'Location', options: locations },
    ],
    [categories, locations]
  );

  const toggle = (sectionId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
  };

  const totalActive = countActiveFilters(filter);

  return (
    // from 1024 px up the wrapper is not there (display: contents) and the panel is a column beside the grid, as it always was; under it the wrapper holds the button and
    // the panel one above the other, and the panel is the width of the screen
    <div className="lg:contents">
      <button
        type="button"
        onClick={() => setPanelOpen((open) => !open)}
        aria-expanded={panelOpen}
        aria-controls="inventory-filters-panel"
        className="lg:hidden btn-secondary w-full justify-between py-2 text-xs"
      >
        <span className="flex items-center gap-2">
          <SlidersHorizontal size={14} />
          Filters{totalActive > 0 ? ` (${totalActive})` : ''}
        </span>
        {panelOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>
      <aside
        id="inventory-filters-panel"
        className={`${panelOpen ? 'block' : 'hidden'} lg:block w-full lg:w-52 xl:w-56 flex-shrink-0`}
      >
        <div className="jewel-card p-3 sticky top-4">
          {/* Header */}
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
            <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Filters
            </span>
            {totalActive > 0 && (
              <button
                onClick={clearInventoryFilter}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <X size={11} /> Clear ({totalActive})
              </button>
            )}
          </div>

          {/* Search within inventory */}
          <div className="mb-3">
            <input
              type="text"
              value={filter.search}
              onChange={(e) => setInventorySearch(e.target.value)}
              placeholder="Search designs, SKUs..."
              aria-label="Search designs and SKUs"
              className="input-field text-xs py-1.5"
            />
          </div>

          {/* Filter Sections */}
          <div className="space-y-1">
            {filterSections.map((section) => {
              const isExpanded = expanded.has(section.id);
              const sectionSelected = new Set(filter[section.key]);

              return (
                <div
                  key={section.id}
                  className="border-b border-border last:border-0 pb-2 mb-2 last:pb-0 last:mb-0"
                >
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
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 mt-1 lg:flex lg:flex-col">
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
                              onChange={() => toggleInventoryOption(section.key, option)}
                              className="w-3.5 h-3.5 rounded border-border accent-primary"
                            />
                            <span
                              className={`text-xs transition-colors ${checked ? 'text-primary font-semibold' : 'text-muted-foreground group-hover:text-foreground'}`}
                            >
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
              <input
                type="number"
                value={filter.weightMin}
                onChange={(e) => setInventoryWeight('min', e.target.value)}
                placeholder="Min"
                aria-label="Minimum gross weight in grams"
                className="input-field text-xs py-1.5 w-full"
                min={0}
                step={0.001}
              />
              <span className="text-muted-foreground text-xs">–</span>
              <input
                type="number"
                value={filter.weightMax}
                onChange={(e) => setInventoryWeight('max', e.target.value)}
                placeholder="Max"
                aria-label="Maximum gross weight in grams"
                className="input-field text-xs py-1.5 w-full"
                min={0}
                step={0.001}
              />
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
