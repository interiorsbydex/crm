/**
 * Shared lead-form field validation (task #55).
 *
 * Mirrors the server-side checks in server/src/routes/leads.ts so the client
 * shows the same inline errors before a request is ever sent. Both return
 * `null` when the value is valid (or empty, for the optional-field callers
 * that only validate non-empty input), or a short user-facing error string.
 */

import { isValidPhoneNumber, parsePhoneNumberFromString } from 'libphonenumber-js';

/** Email must contain an `@` and a domain with a TLD, e.g. `user@domain.com`. */
export function validateEmail(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? null : 'Invalid mail ID';
}

/**
 * Phone must be a plausible number: 7–15 digits after stripping spaces,
 * dashes, parens, dots and a leading `+`, and not an obviously fake pattern
 * (all-same-digit, or strictly sequential ascending/descending).
 */
export function validatePhone(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!/^[\d\s+\-().]+$/.test(v)) return 'Phone can only contain digits, spaces, + and -';
  const digits = v.replace(/[\s\-().+]/g, '');
  if (!/^\d{7,15}$/.test(digits)) return 'Enter a valid phone number (7–15 digits)';
  if (isObviouslyFakeNumber(digits)) return 'Enter a valid phone number';
  return null;
}

/**
 * Per-country phone validation (checklist item #4). The `PhoneInput`
 * component always produces values in `+<calling code><national number>`
 * form via its country selector, so once a leading `+` is present the exact
 * length/format rules for that country apply via libphonenumber-js.
 *
 * Values without a leading `+` (legacy numbers already on a lead, entered
 * before the country selector existed) fall back to `validatePhone` so
 * they aren't newly rejected just because they lack a country prefix.
 */
export function validatePhoneStrict(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (v.startsWith('+')) {
    try {
      if (!isValidPhoneNumber(v)) return 'Enter a valid phone number for the selected country';
      // Per-country format/length passed, but libphonenumber-js alone would
      // still accept structurally-valid-looking placeholders like
      // "+911111111111" or "+911234567890" — reject those the same way the
      // generic check does, applied to the national digits.
      const parsed = parsePhoneNumberFromString(v);
      const nationalDigits = parsed?.nationalNumber ?? v.replace(/\D/g, '');
      return isObviouslyFakeNumber(nationalDigits) ? 'Enter a valid phone number' : null;
    } catch {
      return 'Enter a valid phone number for the selected country';
    }
  }
  return validatePhone(v);
}

function isObviouslyFakeNumber(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true; // all the same digit, e.g. 1111111
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
