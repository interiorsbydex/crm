import { describe, expect, it } from 'vitest';
import { resolveImportOwnership } from './importOwnership.js';

const staff = [
  { id: 'd', name: 'Designer One', role: 'DESIGNER' },
  { id: 'b', name: 'BL One', role: 'BL' },
  { id: 'c', name: 'CRE One', role: 'CRE' },
  { id: 'c2', name: 'CRE Two', role: 'CRE' },
];
describe('historical import ownership', () => {
  it('preserves Designer, BL and CRE independently without inferring current team membership', () => {
    expect(resolveImportOwnership({ designerName: ' designer one ', blName: 'BL ONE', creName: 'CRE One' }, staff, 'DQL', 'ACTIVE'))
      .toMatchObject({ assignedDesignerId: 'd', assignedBLId: 'b', assignedCREId: 'c', outcome: 'PRESERVED', allocationEligible: false });
  });
  it('keeps a CRE named in the legacy Designer column visible to CRE scope', () => {
    expect(resolveImportOwnership({ designerName: 'CRE One' }, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ assignedDesignerId: 'c', assignedCREId: 'c', outcome: 'PRESERVED', allocationEligible: false });
  });
  it('supports a separate CRE column without replacing a real Designer', () => {
    expect(resolveImportOwnership({ creName: 'CRE One' }, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ assignedDesignerId: 'c', assignedCREId: 'c', outcome: 'PRESERVED' });
  });
  it('does not auto-replace an unknown designer and retains a known BL', () => {
    expect(resolveImportOwnership({ designerName: 'Unknown', blName: 'BL One' }, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ assignedDesignerId: undefined, assignedBLId: 'b', allocationEligible: false, outcome: 'MANUAL_REVIEW' });
  });
  it('does not silently discard an unknown BL or CRE', () => {
    for (const fields of [{ blName: 'Unknown' }, { creName: 'Unknown' }]) {
      expect(resolveImportOwnership(fields, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
        .toMatchObject({ allocationEligible: false, outcome: 'MANUAL_REVIEW' });
    }
  });
  it('does not choose between duplicate matching names', () => {
    const ambiguous = [...staff, { id: 'other', name: 'DESIGNER ONE', role: 'DESIGNER' }];
    const result = resolveImportOwnership({ designerName: 'Designer One' }, ambiguous, 'EFFECTIVE_LEAD', 'ACTIVE');
    expect(result).toMatchObject({ assignedDesignerId: undefined, allocationEligible: false, outcome: 'MANUAL_REVIEW' });
    expect(result.reason).toContain('matches multiple users');
  });
  it('does not invent the role of an unlabeled historical owner', () => {
    expect(resolveImportOwnership({ ownerName: 'CRE One' }, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ assignedDesignerId: undefined, assignedCREId: undefined, allocationEligible: false, outcome: 'MANUAL_REVIEW' });
  });
  it('leaves conflicting CRE fields for review rather than picking one', () => {
    expect(resolveImportOwnership({ designerName: 'CRE One', creName: 'CRE Two' }, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ assignedDesignerId: undefined, assignedCREId: undefined, allocationEligible: false, outcome: 'MANUAL_REVIEW' });
  });
  it('does not auto-allocate a BL-held lead that has no designer', () => {
    expect(resolveImportOwnership({ blName: 'BL One' }, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ assignedBLId: 'b', assignedDesignerId: undefined, allocationEligible: false, outcome: 'PRESERVED' });
  });
  it('allocates only ownerless Active Effective Leads (to a CRE) and Active MQLs (by Lead Routing)', () => {
    expect(resolveImportOwnership({}, staff, 'EFFECTIVE_LEAD', 'ACTIVE'))
      .toMatchObject({ allocationEligible: true, qualifiedAllocationEligible: false, outcome: 'ALLOCATION_PENDING' });
    expect(resolveImportOwnership({}, staff, 'MQL', 'ACTIVE'))
      .toMatchObject({ allocationEligible: false, qualifiedAllocationEligible: true, outcome: 'ALLOCATION_PENDING' });
    expect(resolveImportOwnership({ designerName: 'Designer' }, staff, 'MQL', 'ACTIVE'))
      .toMatchObject({ qualifiedAllocationEligible: false });
    for (const [stage, status] of [['MQL', 'ON_HOLD'], ['DQL', 'ACTIVE'], ['EFFECTIVE_LEAD', 'ON_HOLD'], ['EFFECTIVE_LEAD', 'INACTIVE']]) {
      expect(resolveImportOwnership({}, staff, stage, status))
        .toMatchObject({ assignedDesignerId: undefined, allocationEligible: false, qualifiedAllocationEligible: false, outcome: 'MANUAL_REVIEW' });
    }
  });
});
