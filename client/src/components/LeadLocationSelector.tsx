import { useEffect, useRef, useState } from 'react';
import { useCrmSettings } from '../lib/crmSettings';

// Cities and their areas come from Admin → CRM Settings. A city with areas
// listed gets an area dropdown (plus "Others", typable); a city without gets a
// typable area box. "Other" lets the user type a city that isn't listed.
type City = { name: string; areas: string[] };

type ParsedLocation = { city: string; area: string; customArea: string; otherCity: string; customMode?: boolean };

const OTHER_AREA_VALUE = '__other_area__';

function canonicalCity(cities: City[], value: string): City | undefined {
  return cities.find((city) => city.name.toLowerCase() === value.toLowerCase());
}

function parseLocation(cities: City[], value: string): ParsedLocation {
  const trimmed = value.trim();
  if (!trimmed) return { city: '', area: '', customArea: '', otherCity: '' };

  const exactCity = canonicalCity(cities, trimmed);
  if (exactCity) return { city: exactCity.name, area: '', customArea: '', otherCity: '' };

  const commaIndex = trimmed.lastIndexOf(',');
  if (commaIndex > 0) {
    const area = trimmed.slice(0, commaIndex).trim();
    const city = canonicalCity(cities, trimmed.slice(commaIndex + 1).trim());
    if (city) {
      if (city.areas.length) {
        const knownArea = city.areas.find((candidate) => candidate.toLowerCase() === area.toLowerCase());
        return { city: city.name, area: knownArea ?? '', customArea: knownArea ? '' : area, otherCity: '' };
      }
      return { city: city.name, area, customArea: '', otherCity: '' };
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
  const cities = useCrmSettings().cities;
  const [selection, setSelection] = useState<ParsedLocation>(() => parseLocation(cities, value));
  const cityAreas = cities.find((c) => c.name === selection.city)?.areas ?? [];
  const lastEmitted = useRef<string | null>(null);
  const emit = (next: string) => { lastEmitted.current = next; onChange(next); };

  useEffect(() => {
    // Ignore echoes of values this component itself just emitted.
    if (lastEmitted.current !== null && value === lastEmitted.current) return;
    setSelection(parseLocation(cities, value));
  }, [value, cities]);

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
    const city = selection.city;
    if (area === OTHER_AREA_VALUE) {
      emit(areaOptional ? city : '');
    } else {
      emit(area ? `${area}, ${city}` : areaOptional ? city : '');
    }
  };

  const changeArea = (area: string) => {
    const next = { ...selection, area, customArea: '' };
    setSelection(next);
    const city = next.city === 'Other' ? next.otherCity.trim() : next.city;
    emit(area.trim() && city ? `${area.trim()}, ${city}` : areaOptional && city ? city : '');
  };

  const changeCustomArea = (customArea: string) => {
    setSelection((current) => ({ ...current, customArea, area: '', customMode: true }));
    emit(customArea.trim() ? `${customArea.trim()}, ${selection.city}` : areaOptional ? selection.city : '');
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
        {cities.map((city) => <option key={city.name} value={city.name}>{city.name}</option>)}
        <option value="Other">Other</option>
      </select>

      {cityAreas.length > 0 && (
        <>
          <select
            aria-label={`${selection.city} area`}
            value={selection.customMode || selection.customArea ? OTHER_AREA_VALUE : selection.area}
            onChange={(event) => chooseArea(event.target.value)}
            onBlur={onBlur}
            required={!areaOptional && !selection.customMode && !selection.customArea}
            className={controlClass}
            style={controlStyle}
          >
            <option value="">Select {selection.city} area…</option>
            {cityAreas.map((area) => <option key={area} value={area}>{area}</option>)}
            <option value={OTHER_AREA_VALUE}>Others</option>
          </select>
          {(selection.customMode || selection.customArea !== '') && (
            <input
              aria-label={`Other ${selection.city} area`}
              value={selection.customArea}
              onChange={(event) => changeCustomArea(event.target.value)}
              onBlur={onBlur}
              required={!areaOptional}
              placeholder={`Enter ${selection.city} area`}
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

      {selection.city !== '' && cityAreas.length === 0 && (
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