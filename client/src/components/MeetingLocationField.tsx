import { useState } from 'react';

const OTHER = '__other__';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: string[];
}

/**
 * Location dropdown with an "Other" choice that reveals a free-text box, so
 * users can type any location. A saved value outside the preset list is shown
 * as typed text.
 */
export default function MeetingLocationField({ value, onChange, options }: Props) {
  const [otherMode, setOtherMode] = useState(false);
  const isCustom = otherMode || (value !== '' && !options.includes(value));
  const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400';

  return (
    <div className="space-y-2">
      <select
        aria-label="Location"
        value={isCustom ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) { setOtherMode(true); onChange(''); }
          else { setOtherMode(false); onChange(e.target.value); }
        }}
        required={!isCustom}
        className={inputClass}
      >
        <option value="">Select location…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
        <option value={OTHER}>Other (type location)</option>
      </select>
      {isCustom && (
        <input
          type="text"
          aria-label="Other location"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          maxLength={250}
          placeholder="Type the location…"
          className={inputClass}
        />
      )}
    </div>
  );
}
