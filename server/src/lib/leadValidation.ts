// ── Shared lead contact-format validation ──────────────────────────────────────
// Used by every lead ingestion path (authenticated create/update, CSV import,
// Meta/Google webhooks) so phone/email format rules — including rejection of
// obviously-fake placeholder numbers — are enforced consistently everywhere.

import { isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function isValidPhone(phone: string): boolean {
  if (!/^[\d\s+\-().]+$/.test(phone.trim())) return false;
  const digits = phone.replace(/[\s\-().+]/g, '');
  if (!/^\d{7,15}$/.test(digits)) return false;
  return !isObviouslyFakePhone(digits);
}

/** Rejects all-same-digit or strictly sequential ascending/descending numbers (e.g. "1111111", "1234567"). */
function isObviouslyFakePhone(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  let ascending = true;
  let descending = true;
  for (let i = 1; i < digits.length; i++) {
    const prev = Number(digits[i - 1]);
    const cur = Number(digits[i]);
    if (cur !== (prev + 1) % 10) ascending = false;
    if (cur !== (prev + 9) % 10) descending = false;
  }
  return ascending || descending;
}

/**
 * Per-country phone validation (checklist item #4). The lead form's
 * country-code selector always sends numbers in `+<calling code><national
 * number>` form, so once a leading `+` is present we can validate the exact
 * length/format rules for that specific country via libphonenumber-js
 * instead of the generic 7-15 digit check.
 *
 * Values without a leading `+` (legacy numbers already in the system, or
 * other ingestion paths — CSV import, ad webhooks — that don't use the
 * country-code selector) fall back to the original generic `isValidPhone`
 * check so they are not newly rejected.
 */
export function isValidPhoneStrict(phone: string): boolean {
  const v = phone.trim();
  if (!v) return false;
  if (v.startsWith('+')) {
    try {
      if (!isValidPhoneNumber(v)) return false;
      // Per-country format/length is valid, but still reject obviously-fake
      // placeholder digit sequences (all-same-digit, sequential) the same
      // way the generic check does — libphonenumber-js alone would let
      // "+911111111111" or "+911234567890" through since those are
      // structurally valid-looking numbers.
      const parsed = parsePhoneNumberFromString(v);
      const nationalDigits = parsed?.nationalNumber ?? v.replace(/\D/g, '');
      return !isObviouslyFakePhone(nationalDigits);
    } catch {
      return false;
    }
  }
  return isValidPhone(v);
}
