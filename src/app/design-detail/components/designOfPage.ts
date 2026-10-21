import type { Design } from '@/lib/mockData';

// The design that the address of the design page names (`/design-detail?id=<design id>`), taken from the designs the store gives (which read the cache; in the preview build, the sample store).
// There are three answers and none of them is a guess: the address names no design, it names one that is not in the stock, or it names one and here it is. The page used to show the FIRST design of
// the list when it could not find the one asked for, which is a different piece of jewellery under the right address; it never falls back to another design.
export type DesignOfPage =
  | { kind: 'none' }
  | { kind: 'missing' }
  | { kind: 'found'; design: Design };

export function designOfPage(designs: readonly Design[], id: string | null): DesignOfPage {
  if (!id) return { kind: 'none' };
  const design = designs.find((d) => d.id === id);
  return design ? { kind: 'found', design } : { kind: 'missing' };
}
