// FB-A4 (Siddhi #11): "Copy previous group" in Add Design. A design with many weight groups of nearly the same numbers meant typing every field again for each group. The button makes the
// next group from the last one, so the person changes only what differs (usually the weight). This is the unit half: `copyGroup`. The browser half (the button on the real screen, the
// copied values, 10 + n pieces saved with unique numbers, the help line about Pieces) is tests/e2e/add-design.spec.ts.
//
// Run: npm test -- tests/unit/add-design-copy-group.test.ts      (or: npm test -- -t PT-FBA4)
import { describe, expect, it } from 'vitest';
import { copyGroup, type GroupRow } from '@/app/add-design/components/AddDesignClient';

// every field has a value of its own, so that a field the copy forgets cannot hide behind another one that happens to be equal
const GROUP: GroupRow = {
  id: 'group-0',
  pieces: '3',
  grossWeight: '12.500',
  originalNetWeight: '10.125',
  customerNetWeight: '11.250',
  stones: '4',
  stoneWeight: '0.800',
  kundan: '6',
  kundanWeight: '0.450',
  piroi: '150.00',
  labour: '40.00',
  retailLabour: '353.00',
  semiWholesaleLabour: '320.00',
  wholesaleLabour: '290.00',
  notes: 'bridal set',
};

describe('PT-FBA4 copyGroup', () => {
  it('makes a new group with its own id', () => {
    const copy = copyGroup(GROUP);
    expect(copy).not.toBe(GROUP);
    expect(copy.id).not.toBe(GROUP.id);
    expect(copy.id).not.toBe('');
    expect(copyGroup(GROUP).id).not.toBe(copy.id);
  });

  it('copies the weights, the stones, the kundan, the piroi and the three labour rates', () => {
    const copy = copyGroup(GROUP);
    expect(copy.grossWeight).toBe(GROUP.grossWeight);
    expect(copy.customerNetWeight).toBe(GROUP.customerNetWeight);
    expect(copy.originalNetWeight).toBe(GROUP.originalNetWeight);
    expect(copy.stones).toBe(GROUP.stones);
    expect(copy.stoneWeight).toBe(GROUP.stoneWeight);
    expect(copy.kundan).toBe(GROUP.kundan);
    expect(copy.kundanWeight).toBe(GROUP.kundanWeight);
    expect(copy.piroi).toBe(GROUP.piroi);
    expect(copy.retailLabour).toBe(GROUP.retailLabour);
    expect(copy.semiWholesaleLabour).toBe(GROUP.semiWholesaleLabour);
    expect(copy.wholesaleLabour).toBe(GROUP.wholesaleLabour);
  });

  it('copies the pieces too (the person changes that one) and every other field: nothing but the id differs', () => {
    const copy = copyGroup(GROUP);
    expect(copy.pieces).toBe('3');
    const { id: copyId, ...copied } = copy;
    const { id: originalId, ...original } = GROUP;
    expect(copyId).not.toBe(originalId);
    expect(copied).toEqual(original);
  });

  it('leaves the group it copied from as it was', () => {
    const before = { ...GROUP };
    copyGroup(GROUP);
    expect(GROUP).toEqual(before);
  });
});
