import React from 'react';
import DesignSkuTable from './DesignSkuTable';
import type { Design } from '@/lib/mockData';

// C15: the sample "Sales History" and "Audit Log" tabs (they were written for a made-up design) are not connected and not reachable in M1; the real ones are M2 (INV-04 to INV-08).
// What is left is the design's own pieces, under a heading in the place the tab bar was.
export default function DesignTabs({ design }: { design: Design }) {
  return (
    <div className="jewel-card overflow-hidden">
      <div className="flex border-b border-border px-4 bg-muted/20">
        <h2 className="px-4 py-3 text-sm tab-active">SKUs &amp; Stock</h2>
      </div>
      <div className="p-4">
        <DesignSkuTable design={design} />
      </div>
    </div>
  );
}
