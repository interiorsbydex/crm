import { useEffect, useRef, useState } from 'react';

const CITIES = [
  'Chennai', 'Bengaluru', 'Hyderabad', 'Coimbatore', 'Madurai', 'Trichy',
  'Salem', 'Tiruppur', 'Erode', 'Hosur', 'Vellore', 'Thanjavur', 'Puducherry',
  'Pondicherry',
] as const;

const CHENNAI_AREAS = [
  'Alwarpet', 'Abiramapuram', 'Teynampet', 'Gopalapuram', 'Royapettah', 'Mylapore',
  'R.A. Puram', 'Nandanam', 'Thousand Lights', 'Nungambakkam', 'Egmore', 'Chetpet',
  'Kilpauk', 'Purasawalkam', 'Choolaimedu', 'Choolai', 'Anna Salai', 'T. Nagar',
  'West Mambalam', 'Saidapet', 'Kodambakkam', 'Ashok Nagar', 'K.K. Nagar',
  'Vadapalani', 'Saligramam', 'Virugambakkam', 'Adyar', 'Besant Nagar',
  'Gandhi Nagar', 'Indira Nagar', 'Kasturba Nagar', 'Thiruvanmiyur', 'Kotturpuram',
  'Kottur', 'Velachery', 'Taramani', 'Perungudi', 'Kandanchavadi', 'Sholinganallur',
  'Karapakkam', 'Thoraipakkam', 'Okkiyam Thoraipakkam', 'Kottivakkam', 'Palavakkam',
  'Neelankarai', 'Injambakkam', 'Uthandi', 'Akkarai', 'Semmenchery', 'Pallikaranai',
  'Medavakkam', 'Madipakkam', 'Keelkattalai', 'Adambakkam', 'Alandur',
  'Guindy', 'Ekkatuthangal', 'Nanganallur', 'Manapakkam', 'Mugalivakkam', 'Porur',
  'Ramapuram', 'Valasaravakkam', 'Maduravoyal', 'Anna Nagar', 'Anna Nagar West',
  'Anna Nagar East', 'Aminjikarai', 'Arumbakkam', 'Mogappair', 'Mogappair East',
  'Mogappair West', 'Nolambur', 'Koyambedu', 'Villivakkam', 'Padi', 'Korattur',
  'Ambattur', 'Pattaravakkam', 'Avadi', 'Thirumullaivoyal', 'Ayappakkam',
  'Perambur', 'Kolathur', 'Ayanavaram', 'Madhavaram', 'Manali', 'Tondiarpet',
  'Royapuram', 'Washermanpet', 'George Town', 'Broadway', 'Basin Bridge',
  'Vyasarpadi', 'Ennore', 'Thiruvottiyur', 'Red Hills', 'Tambaram', 'West Tambaram',
  'East Tambaram', 'Chromepet', 'Pallavaram', 'Pammal', 'Anakaputhur', 'Chitlapakkam',
  'Sembakkam', 'Selaiyur', 'Perungalathur', 'Vandalur', 'Guduvanchery', 'Urapakkam',
  'Kelambakkam',
] as const;

type ParsedLocation = { city: string; area: string; customArea: string; otherCity: string; customMode?: boolean };

const OTHER_AREA_VALUE = '__other_area__';

function canonicalCity(value: string): string | undefined {
  return CITIES.find((city) => city.toLowerCase() === value.toLowerCase());
}

function parseLocation(value: string): ParsedLocation {
  const trimmed = value.trim();
  if (!trimmed) return { city: '', area: '', customArea: '', otherCity: '' };

  const exactCity = canonicalCity(trimmed);
  if (exactCity) return { city: exactCity, area: '', customArea: '', otherCity: '' };

  const commaIndex = trimmed.lastIndexOf(',');
  if (commaIndex > 0) {
    const area = trimmed.slice(0, commaIndex).trim();
    const city = canonicalCity(trimmed.slice(commaIndex + 1).trim());
    if (city) {
      if (city === 'Chennai') {
        const knownArea = CHENNAI_AREAS.find((candidate) => candidate.toLowerCase() === area.toLowerCase());
        return { city, area: knownArea ?? '', customArea: knownArea ? '' : area, otherCity: '' };
      }
      return { city, area, customArea: '', otherCity: '' };
    }

    return { city: 'Other', area, customArea: '', otherCity: trimmed.slice(commaIndex + 1).trim() };
  }

  return { city: 'Other', area: '', customArea: '', otherCity: trimmed };
}

interface LeadLocationSelectorProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  required?: boolean;
  hasError?: boolean;
  /** Lenient launch: the area (not the city) may be left blank. */
  areaOptional?: boolean;
}

export default function LeadLocationSelector({
  value,
  onChange,
  onBlur,
  required = false,
  hasError = false,
  areaOptional = false,
}: LeadLocationSelectorProps) {
  const [selection, setSelection] = useState<ParsedLocation>(() => parseLocation(value));
  const lastEmitted = useRef<string | null>(null);
  const emit = (next: string) => { lastEmitted.current = next; onChange(next); };

  useEffect(() => {
    // Ignore echoes of values this component itself just emitted.
    if (lastEmitted.current !== null && value === lastEmitted.current) return;
    setSelection(parseLocation(value));
  }, [value]);

  const controlStyle = {
    border: hasError ? '1px solid #EF4444' : '1px solid #EDE8E3',
    background: '#FDFAF7',
  };
  const controlClass = 'w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all';

  const chooseCity = (city: string) => {
    const next = { city, area: '', customArea: '', otherCity: '' };
    setSelection(next);
    // Lenient: a city alone is a valid location (area can be filled in later).
    emit(areaOptional && city && city !== 'Other' ? city : '');
  };

  const chooseArea = (area: string) => {
    setSelection((current) => ({ ...current, area: area === OTHER_AREA_VALUE ? '' : area, customArea: '', customMode: area === OTHER_AREA_VALUE }));
    if (area === OTHER_AREA_VALUE) {
      emit(areaOptional ? 'Chennai' : '');
    } else {
      emit(area ? `${area}, Chennai` : areaOptional ? 'Chennai' : '');
    }
  };

  const changeArea = (area: string) => {
    const next = { ...selection, area, customArea: '' };
    setSelection(next);
    const city = next.city === 'Other' ? next.otherCity.trim() : next.city;
    emit(area.trim() && city ? `${area.trim()}, ${city}` : areaOptional && city ? city : '');
  };

  const changeCustomChennaiArea = (customArea: string) => {
    setSelection((current) => ({ ...current, customArea, area: '', customMode: true }));
    emit(customArea.trim() ? `${customArea.trim()}, Chennai` : areaOptional ? 'Chennai' : '');
  };

  const changeOtherCity = (otherCity: string) => {
    const next = { ...selection, otherCity };
    setSelection(next);
    emit(next.area.trim() && otherCity.trim() ? `${next.area.trim()}, ${otherCity.trim()}` : areaOptional && otherCity.trim() ? otherCity.trim() : '');
  };

  return (
    <div className="space-y-2">
      <select
        aria-label="City"
        value={selection.city}
        onChange={(event) => chooseCity(event.target.value)}
        onBlur={onBlur}
        required={required}
        className={controlClass}
        style={controlStyle}
      >
        <option value="">Select city…</option>
        {CITIES.map((city) => <option key={city} value={city}>{city}</option>)}
        <option value="Other">Other</option>
      </select>

      {selection.city === 'Chennai' && (
        <>
          <select
            aria-label="Chennai area"
            value={selection.customMode || selection.customArea ? OTHER_AREA_VALUE : selection.area}
            onChange={(event) => chooseArea(event.target.value)}
            onBlur={onBlur}
            required={!areaOptional && !selection.customMode && !selection.customArea}
            className={controlClass}
            style={controlStyle}
          >
            <option value="">Select Chennai area…</option>
            {CHENNAI_AREAS.map((area) => <option key={area} value={area}>{area}</option>)}
            <option value={OTHER_AREA_VALUE}>Others</option>
          </select>
          {(selection.customMode || selection.customArea !== '') && (
            <input
              aria-label="Other Chennai area"
              value={selection.customArea}
              onChange={(event) => changeCustomChennaiArea(event.target.value)}
              onBlur={onBlur}
              required={!areaOptional}
              placeholder="Enter Chennai area"
              className={controlClass}
              style={controlStyle}
            />
          )}
        </>
      )}

      {selection.city === 'Other' && (
        <input
          aria-label="Other city"
          value={selection.otherCity}
          onChange={(event) => changeOtherCity(event.target.value)}
          onBlur={onBlur}
          required
          placeholder="Enter city"
          className={controlClass}
          style={controlStyle}
        />
      )}

      {selection.city !== '' && selection.city !== 'Chennai' && (
        <input
          aria-label={`${selection.city === 'Other' ? 'Selected city' : selection.city} area`}
          value={selection.area}
          onChange={(event) => changeArea(event.target.value)}
          onBlur={onBlur}
          required={!areaOptional}
          placeholder={`Enter area in ${selection.city === 'Other' ? 'the selected city' : selection.city}`}
          className={controlClass}
          style={controlStyle}
        />
      )}
    </div>
  );
}