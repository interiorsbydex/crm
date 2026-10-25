import { describe, expect, it } from 'vitest';
import { requiredDipChecksComplete } from './dipChecklistRules.js';

describe('DIP required checks', () => {
  it('requires both client email approval and an internal email thread', () => {
    expect(requiredDipChecksComplete({ cxApprovalReceived: true, internalMailThreadCompleted: true })).toBe(true);
    expect(requiredDipChecksComplete({ cxApprovalReceived: false, internalMailThreadCompleted: true })).toBe(false);
    expect(requiredDipChecksComplete({ cxApprovalReceived: true, internalMailThreadCompleted: false })).toBe(false);
  });
  it('does not make optional Google review or the old NPS flag a second requirement', () => {
    const checks = { cxApprovalReceived: true, internalMailThreadCompleted: true, npsTriggered: false, googleReviewReceived: false };
    expect(requiredDipChecksComplete(checks)).toBe(true);
  });
});
