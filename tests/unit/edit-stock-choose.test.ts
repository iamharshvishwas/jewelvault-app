// FB-A3 (Siddhi #10): Edit Stock never edits a design nobody chose. The screen used to fall back to the FIRST design in the list when the address had no id (or an id that is not in the
// list), so a person who opened it from the menu or the dashboard edited, and saved, whichever design happened to be first. Now `designForEdit` answers "chosen", "choose" or
// "not found", and the chooser lists the designs to pick from. The browser half (the chooser on the real screen, a search, a pick, a made-up id, two browsers on one design) is
// tests/e2e/stock-edit.spec.ts.
//
// Run: npm test -- tests/unit/edit-stock-choose.test.ts      (or: npm test -- -t PT-FBA3)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ChooseDesign, {
  CHOOSE_LIST_LIMIT,
  designsToChooseFrom,
} from '@/app/edit-stock/components/ChooseDesign';
import { designForEdit } from '@/app/edit-stock/components/EditStockClient';
import type { Design, Sku } from '@/lib/mockData';

function sku(skuNumber: string, barcode: string): Sku {
  return {
    id: `id-${skuNumber}`,
    skuNumber,
    designId: '',
    designNumber: '',
    grossWeight: 10,
    originalNetWeight: 0,
    customerNetWeight: 9,
    stones: 0,
    stoneWeight: 0,
    kundan: 0,
    kundanWeight: 0,
    piroi: 0,
    labour: 0,
    status: 'In Stock',
    location: 'Main Showroom',
    barcode,
    createdAt: '',
    createdBy: '',
    notes: '',
    sellingMethod: 'By Weight',
    purity: '22K',
    material: 'Gold',
    category: 'Ring',
    subcategory: '',
  };
}

function design(designNumber: string, designName: string, barcode = `BC-${designNumber}`): Design {
  return {
    id: `id-${designNumber}`,
    designNumber,
    designName,
    category: 'Ring',
    subcategory: '',
    material: 'Gold',
    purity: '22K',
    sellingMethod: 'By Weight',
    description: '',
    notes: '',
    tags: [],
    images: [],
    primaryImage: '',
    skus: [sku(`${designNumber}-1`, barcode)],
    createdAt: '',
    createdBy: '',
    labour: 0,
    piroi: 0,
  };
}

const LIST = [
  design('R-001', 'Lotus Ring'),
  design('R-002', 'Peacock Ring'),
  design('C-001', 'Rope Chain'),
];

describe('PT-FBA3 designForEdit', () => {
  it('no id in the address means the person has not chosen: choose, never the first design', () => {
    expect(designForEdit(LIST, null)).toEqual({ kind: 'choose' });
    expect(designForEdit(LIST, '')).toEqual({ kind: 'choose' });
    expect(designForEdit([], null)).toEqual({ kind: 'choose' });
  });

  it('an id that is not in the list is not found, and the answer names the id', () => {
    expect(designForEdit(LIST, 'made-up-id')).toEqual({ kind: 'not-found', id: 'made-up-id' });
    expect(designForEdit([], 'id-R-001')).toEqual({ kind: 'not-found', id: 'id-R-001' });
  });

  it('a known id is that design, and never the first one of the list when the id is another', () => {
    const answer = designForEdit(LIST, 'id-C-001');
    expect(answer.kind).toBe('chosen');
    if (answer.kind === 'chosen') {
      expect(answer.design).toBe(LIST[2]);
      expect(answer.design).not.toBe(LIST[0]);
    }
    expect(designForEdit(LIST, 'id-R-002')).toEqual({ kind: 'chosen', design: LIST[1] });
  });
});

describe('PT-FBA3 the chooser', () => {
  it('has the heading, a search box, and one link for each design to /edit-stock?id=<id>', () => {
    const html = renderToStaticMarkup(createElement(ChooseDesign, { designs: LIST }));
    expect(html).toContain('Choose a design to edit');
    expect(html).toContain('aria-label="Search designs"');
    for (const d of LIST) {
      expect(html).toContain(`href="/edit-stock?id=${d.id}"`);
      expect(html).toContain(d.designNumber);
      expect(html).toContain(d.designName);
    }
    // nothing here saves anything
    expect(html).not.toContain('Save Changes');
  });

  it('says so when there are no designs at all', () => {
    const html = renderToStaticMarkup(createElement(ChooseDesign, { designs: [] }));
    expect(html).toContain('Choose a design to edit');
    expect(html).toContain('No designs yet');
  });

  it('the search finds a design by number, name or barcode, in any case, and says when nothing matches', () => {
    const numbersOf = (search: string) =>
      designsToChooseFrom(LIST, search).shown.map((d) => d.designNumber);
    expect(numbersOf('')).toEqual(['R-001', 'R-002', 'C-001']);
    expect(numbersOf('r-002')).toEqual(['R-002']);
    expect(numbersOf('  ROPE ')).toEqual(['C-001']);
    expect(numbersOf('bc-r-001')).toEqual(['R-001']);
    expect(numbersOf('ring')).toEqual(['R-001', 'R-002']);
    expect(numbersOf('zzz')).toEqual([]);
  });

  it('a big shop draws only the first page of the list and says how many there are', () => {
    const many = Array.from({ length: CHOOSE_LIST_LIMIT + 70 }, (_, i) =>
      design(`M-${String(i).padStart(4, '0')}`, `Many ${i}`)
    );
    const { shown, total } = designsToChooseFrom(many, '');
    expect(shown).toHaveLength(CHOOSE_LIST_LIMIT);
    expect(total).toBe(many.length);
    const html = renderToStaticMarkup(createElement(ChooseDesign, { designs: many }));
    expect(html.match(/href="\/edit-stock\?id=/g)).toHaveLength(CHOOSE_LIST_LIMIT);
    expect(html).toContain(`Showing ${CHOOSE_LIST_LIMIT} of ${many.length}`);
  });
});
