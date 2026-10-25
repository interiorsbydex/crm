/** Explicit recorded amount only: never infer tax, discount or furniture twice. */
export function parseOnboardingTargetValue(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error('Target value must be a valid non-negative amount');
  const amount = Number(value);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents)) {
    throw new Error('Target value must be a valid non-negative amount');
  }
  return cents / 100;
}

export function assertOnboardingTargetEditable(stage: string, bookingCompletedAt: Date | null): void {
  if (!['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING'].includes(stage)
    || bookingCompletedAt) {
    throw new Error('Target value cannot be changed after DIP booking confirmation');
  }
}
