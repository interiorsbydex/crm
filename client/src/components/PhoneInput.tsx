// ── Phone input with country-code selector (checklist item #4) ─────────────
// Renders a country-code dropdown next to a plain digit input. The combined
// value is always emitted as `+<calling code><national digits>` (e.g.
// "+919876543210") so per-country validation (validatePhoneStrict /
// isValidPhoneStrict) can apply the correct length/format rules for
// whichever country is selected.
//
// Legacy numbers already stored without a `+` prefix are parsed with India
// assumed as the default country (this CRM's primary market) and are left
// exactly as-is unless the user edits them — so existing valid Indian
// numbers are never retroactively rejected.

import { useMemo, useState } from 'react';
import { getCountries, getCountryCallingCode, parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

const PREFERRED_COUNTRIES: CountryCode[] = ['IN', 'US', 'GB', 'AE', 'SG', 'AU', 'CA'];

function countryFlag(iso: CountryCode): string {
  return iso
    .toUpperCase()
    .replace(/./g, (char) => String.fromCodePoint(127397 + char.charCodeAt(0)));
}

let regionNames: Intl.DisplayNames | null | undefined;
function countryName(iso: CountryCode): string {
  try {
    if (regionNames === undefined) {
      regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    }
    return regionNames?.of(iso) ?? iso;
  } catch {
    return iso;
  }
}

type CountryOption = { iso: CountryCode; name: string; callingCode: string };

const ALL_COUNTRIES: CountryOption[] = getCountries()
  .map((iso) => ({ iso, name: countryName(iso), callingCode: getCountryCallingCode(iso) }))
  .sort((a, b) => a.name.localeCompare(b.name));

const COUNTRY_OPTIONS: CountryOption[] = [
  ...(PREFERRED_COUNTRIES.map((iso) => ALL_COUNTRIES.find((c) => c.iso === iso)).filter(Boolean) as CountryOption[]),
  ...ALL_COUNTRIES.filter((c) => !PREFERRED_COUNTRIES.includes(c.iso)),
];

function splitValue(value: string): { iso: CountryCode; national: string } {
  const v = (value || '').trim();
  if (v.startsWith('+')) {
    try {
      const parsed = parsePhoneNumberFromString(v);
      if (parsed?.country) {
        return { iso: parsed.country, national: parsed.nationalNumber };
      }
    } catch {
      // fall through to legacy handling below
    }
  }
  // Legacy value with no recognizable country prefix — default to India,
  // keep the raw digits untouched so it round-trips unless the user edits it.
  return { iso: 'IN', national: v.replace(/\D/g, '') };
}

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  id?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  hasError?: boolean;
}

export default function PhoneInput({ value, onChange, onBlur, id, placeholder, required, disabled, hasError }: PhoneInputProps) {
  // Lazy-init from the incoming value; the parent form remounts this
  // component (modal open/close) whenever it needs to load a different lead.
  const initial = useMemo(() => splitValue(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [iso, setIso] = useState<CountryCode>(initial.iso);
  const [national, setNational] = useState<string>(initial.national);

  const emit = (nextIso: CountryCode, nextNational: string) => {
    const digits = nextNational.replace(/\D/g, '');
    if (!digits) {
      onChange('');
      return;
    }
    const callingCode = getCountryCallingCode(nextIso);
    onChange(`+${callingCode}${digits}`);
  };

  return (
    <div className="flex gap-1.5">
      <select
        aria-label="Country code"
        value={iso}
        disabled={disabled}
        onChange={(e) => {
          const nextIso = e.target.value as CountryCode;
          setIso(nextIso);
          emit(nextIso, national);
        }}
        className="w-[86px] shrink-0 rounded-xl px-1.5 py-2 text-sm focus:outline-none focus:ring-2 transition-all"
        style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
      >
        {COUNTRY_OPTIONS.map((c) => (
          <option key={c.iso} value={c.iso}>
            {countryFlag(c.iso)} +{c.callingCode}
          </option>
        ))}
      </select>
      <input
        id={id}
        type="tel"
        inputMode="tel"
        value={national}
        disabled={disabled}
        required={required}
        placeholder={placeholder}
        onChange={(e) => {
          const nextNational = e.target.value;
          setNational(nextNational);
          emit(iso, nextNational);
        }}
        onBlur={onBlur}
        className="w-full min-w-0 flex-1 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 transition-all"
        style={{
          border: hasError ? '1px solid #EF4444' : '1px solid #EDE8E3',
          background: '#FDFAF7',
        }}
      />
    </div>
  );
}
