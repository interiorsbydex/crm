import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DateInput } from './ui/DateTimeInputs';

// Shared "More Filters" fields for the Leads screen and the Sales Pipeline.

const labelCls = 'block text-xs font-semibold text-stone-500 mb-1.5';
const boxCls = 'w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300';
const boxStyle = { border: '1px solid #EDE8E3', background: '#FDFAF7' };
const dateCls = 'w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300';

let cachedLocations: string[] | null = null;

/** Location: pick from the locations already on the leads this user can see. */
export function LocationFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [locations, setLocations] = useState<string[]>(cachedLocations ?? []);
  useEffect(() => {
    api.get<{ locations: string[] }>('/leads/locations')
      .then(({ locations }) => { cachedLocations = locations; setLocations(locations); })
      .catch(() => {});
  }, []);
  const options = value && !locations.some((l) => l.toLowerCase() === value.toLowerCase()) ? [value, ...locations] : locations;
  return (
    <div>
      <label className={labelCls}>Location</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={boxCls} style={boxStyle} data-testid="filter-location">
        <option value="">All locations</option>
        {options.map((l) => <option key={l} value={l}>{l}</option>)}
      </select>
    </div>
  );
}

/** Possession: "Possession Received", or a possession date range. */
export function PossessionFilter({ possession, from, to, onChange }: {
  possession: string; from: string; to: string;
  onChange: (key: 'possession' | 'possessionDateFrom' | 'possessionDateTo', v: string) => void;
}) {
  return (
    <>
      <div>
        <label className={labelCls}>Possession</label>
        <select value={possession} data-testid="filter-possession" className={boxCls} style={boxStyle}
          onChange={(e) => {
            onChange('possession', e.target.value);
            if (e.target.value === 'received') { onChange('possessionDateFrom', ''); onChange('possessionDateTo', ''); }
          }}>
          <option value="">Any</option>
          <option value="received">Possession Received</option>
          <option value="date">Possession date given</option>
        </select>
      </div>
      {possession !== 'received' && (
        <>
          <div>
            <label className={labelCls}>Possession date (from)</label>
            <DateInput value={from} onChange={(v) => onChange('possessionDateFrom', v)} className={dateCls} />
          </div>
          <div>
            <label className={labelCls}>Possession date (to)</label>
            <DateInput value={to} onChange={(v) => onChange('possessionDateTo', v)} className={dateCls} />
          </div>
        </>
      )}
    </>
  );
}
