import { describe, expect, it } from 'vitest';
import { assertOnboardingTargetEditable, parseOnboardingTargetValue } from './onboardingTargetValue.js';

describe('Explicit onboarding target value', () => {
  it('keeps omission separate from an intentional clear', () => {
    expect(parseOnboardingTargetValue(undefined)).toBeUndefined();
    expect(parseOnboardingTargetValue(null)).toBeNull();
    expect(parseOnboardingTargetValue('')).toBeNull();
  });
  it('records the entered net total without subtracting discount, tax or furniture again', () => {
    expect(parseOnboardingTargetValue('1000000')).toBe(1000000);
    expect(parseOnboardingTargetValue('123456.78')).toBe(123456.78);
    expect(parseOnboardingTargetValue(0)).toBe(0);
  });
  it.each([-1, 'invalid', Infinity, NaN, true, {}, Number.MAX_VALUE])('rejects invalid amount %s', (value) => {
    expect(() => parseOnboardingTargetValue(value)).toThrow('valid non-negative amount');
  });
});

describe('Booking-credit protection', () => {
  it('permits the recorded amount during onboarding before the booking is confirmed', () => {
    expect(() => assertOnboardingTargetEditable('ONBOARDING', null)).not.toThrow();
    expect(() => assertOnboardingTargetEditable('ONBOARDING_MEETING', null)).not.toThrow();
  });
  it('prevents a later amount edit from changing already-booked credit', () => {
    expect(() => assertOnboardingTargetEditable('ONBOARDING', new Date())).toThrow('after DIP booking');
    expect(() => assertOnboardingTargetEditable('DESIGN_IN_PROGRESS', null)).toThrow('after DIP booking');
  });
});
