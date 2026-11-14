'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { NO_FILTER, filterDesigns } from '@/lib/inventoryFilter';
import type { Design } from '@/lib/mockData';

// FB-A3: what Edit Stock shows when the address names no design. It used to open the first design of the list, so a person coming from the menu or the dashboard edited a design nobody
// had chosen. This is a search box and a list; a row opens `/edit-stock?id=<id>`, where the form is.

/** How many designs are drawn at once: a big shop must not draw thousands of rows on a phone; the search narrows the list. */
export const CHOOSE_LIST_LIMIT = 50;

/** The designs to draw for what is typed (number, name, piece number or barcode, as the Inventory search does), the first page of them, and how many there are in all. */
export function designsToChooseFrom(
  designs: Design[],
  search: string
): { shown: Design[]; total: number } {
  const matching = filterDesigns(designs, { ...NO_FILTER, search });
  return { shown: matching.slice(0, CHOOSE_LIST_LIMIT), total: matching.length };
}

export default function ChooseDesign({ designs }: { designs: Design[] }) {
  const [search, setSearch] = useState('');
  const { shown, total } = designsToChooseFrom(designs, search);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Choose a design to edit</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pick the design whose stock you want to change. Nothing changes until you save.
        </p>
      </div>

      <div className="relative">
        <Search
          size={15}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search designs"
          placeholder="Design number, name, piece number or barcode"
          className="input-field pl-9"
        />
      </div>

      {designs.length === 0 ? (
        <div className="jewel-card p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No designs yet</p>
          <Link href="/inventory-management" className="btn-primary mt-4 inline-flex">
            Back to Inventory
          </Link>
        </div>
      ) : total === 0 ? (
        <div className="jewel-card p-8 text-center">
          <p className="text-sm font-semibold text-foreground">No design matches that</p>
          <p className="text-xs text-muted-foreground mt-1">
            Try a design number, a name, a piece number or a barcode.
          </p>
        </div>
      ) : (
        <>
          <ul className="space-y-2">
            {shown.map((design) => (
              <li key={design.id}>
                <Link
                  href={`/edit-stock?id=${design.id}`}
                  className="jewel-card p-3 flex items-center gap-3 hover:border-primary/50 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-sm font-bold text-primary">
                      {design.designNumber}
                    </p>
                    <p className="text-sm text-foreground truncate">{design.designName}</p>
                    <p className="text-xs text-muted-foreground">
                      {design.category} · {design.material} {design.purity}
                    </p>
                  </div>
                  <span className="text-xs font-semibold text-muted-foreground whitespace-nowrap">
                    {design.skus.length} piece{design.skus.length === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {total > shown.length && (
            <p className="text-xs text-muted-foreground text-center">
              Showing {shown.length} of {total}. Type a design number, name or barcode to narrow the
              list.
            </p>
          )}
        </>
      )}
    </div>
  );
}
