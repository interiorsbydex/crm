import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { crmSettings } from '../../lib/crmSettings';

// Boxes the Branch Head built in Admin → Custom Boxes (server: lib/customBoxes.ts).
// Each person sees only the boxes for their dashboard, counted over their own leads.

type Measure = 'count' | 'totalValue' | 'avgValue' | 'avgAgeDays';
type BoxResult =
  | { id: string; title: string; measure: Measure; split: 'none'; value: number | null }
  | { id: string; title: string; measure: Measure; split: 'stage' | 'source' | 'designer' | 'status'; rows: { key: string; value: number | null; leads: number }[] };

export const MEASURE_LABELS: Record<Measure, string> = {
  count: 'Number of leads',
  totalValue: 'Total value (client budget)',
  avgValue: 'Average value per lead',
  avgAgeDays: 'Average age (days since the lead was created)',
};

const money = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${n.toLocaleString('en-IN')}`;
};
function show(measure: Measure, v: number | null): string {
  if (v == null) return '—';
  if (measure === 'count') return String(v);
  if (measure === 'avgAgeDays') return `${v} days`;
  return money(v);
}

export default function CustomBoxes() {
  const [boxes, setBoxes] = useState<BoxResult[]>([]);
  useEffect(() => {
    api.get<{ boxes: BoxResult[] }>('/custom-boxes').then((d) => setBoxes(d.boxes)).catch(() => setBoxes([]));
  }, []);
  if (!boxes.length) return null;

  const rowName = (split: string, key: string) => {
    const s = crmSettings();
    if (split === 'stage') return s.stageLabels[key] ?? key;
    if (split === 'source') return s.leadSources.find((x) => x.value === key)?.label ?? key;
    if (split === 'status') return ({ ACTIVE: 'Active', ON_HOLD: 'On Hold', INACTIVE: 'Inactive' } as Record<string, string>)[key] ?? key;
    return key;
  };

  return (
    <section className="px-3 sm:px-6 pb-8 max-w-7xl mx-auto" data-testid="custom-boxes">
      <h3 className="font-bold text-stone-900 mb-3 tracking-tight">Custom boxes</h3>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {boxes.map((b) => (
          <div key={b.id} className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }} data-testid={`custom-box-${b.id}`}>
            <p className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1">{b.title}</p>
            {b.split === 'none' ? (
              <p className="text-2xl font-bold text-stone-900">{show(b.measure, b.value)}</p>
            ) : b.rows.length === 0 ? (
              <p className="text-sm text-stone-400">No leads match.</p>
            ) : (
              <table className="w-full text-sm mt-1">
                <tbody>
                  {b.rows.map((r) => (
                    <tr key={r.key} className="border-t border-stone-100 first:border-0">
                      <td className="py-1.5 text-stone-600">{rowName(b.split, r.key)}</td>
                      <td className="py-1.5 text-right font-semibold text-stone-900">{show(b.measure, r.value)}</td>
                      <td className="py-1.5 pl-2 text-right text-xs text-stone-400">{r.leads} lead{r.leads === 1 ? '' : 's'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-[11px] text-stone-400 mt-2">{MEASURE_LABELS[b.measure]}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
