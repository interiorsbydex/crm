import type { ReactNode } from 'react';
import SettingsScreen from './SettingsScreen';

// Admin → Dashboards → BL dashboard rules (server: lib/blBoard.ts). The rules behind
// "Needs Attention" and "Today's Focus" on the Business Lead dashboard.

interface Rules {
  inactiveDqlDays: number;
  proposalFollowUpDays: number;
  highValueFrom: number;
  npsTrendMonths: number;
  attention: Record<string, boolean>;
  focus: Record<string, boolean>;
}
interface Catalog { attention: { key: string; label: string }[]; focus: { key: string; label: string }[] }

const CARD = 'bg-white rounded-xl border border-gray-200 p-5 space-y-3';
const INPUT = 'w-32 rounded border border-gray-200 px-2 py-1 text-sm';

function Num({ label, value, onChange, suffix, min = 0, max }: { label: ReactNode; value: number; onChange: (n: number) => void; suffix?: string; min?: number; max?: number }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
      <span className="min-w-[280px]">{label}</span>
      <input type="number" className={INPUT} value={value} min={min} max={max}
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))} />
      {suffix && <span className="text-xs text-gray-400">{suffix}</span>}
    </label>
  );
}

export default function BlBoardRulesAdmin() {
  return (
    <SettingsScreen<Rules, Catalog>
      path="/bl-board-rules"
      title="BL dashboard rules"
      testId="bl-board-rules-admin"
      intro={<>What the Business Lead dashboard counts in "Needs Attention" and "Today's Focus", and how far back the NPS trend goes. Untick an item to take it off the dashboard. Changes show straight away.</>}
    >
      {(r, set, data) => (
        <>
          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">Needs Attention</h3>
            <Num label="A DQL lead is inactive after" suffix="days with no activity" min={1} max={365} value={r.inactiveDqlDays} onChange={(n) => set({ ...r, inactiveDqlDays: n })} />
            <Num label="A proposal needs follow-up after" suffix="days with nothing planned and no activity (PP and PD stages)" min={1} max={365} value={r.proposalFollowUpDays} onChange={(n) => set({ ...r, proposalFollowUpDays: n })} />
            <Num label="A lead is high value from (₹)" suffix={`₹${(r.highValueFrom / 100000).toLocaleString('en-IN')} L`} min={0} value={r.highValueFrom} onChange={(n) => set({ ...r, highValueFrom: n })} />
            <div className="flex flex-wrap gap-x-5 gap-y-1 pt-1">
              {(data.catalog?.attention ?? []).map((i) => (
                <label key={i.key} className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" checked={r.attention[i.key] !== false} onChange={(e) => set({ ...r, attention: { ...r.attention, [i.key]: e.target.checked } })} />
                  {i.label}
                </label>
              ))}
            </div>
          </div>
          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">Today's Focus</h3>
            <p className="text-xs text-gray-500">"General approvals" are team-member requests on projects waiting for the BL. "Discount approvals" are requests waiting for the BL (not yet passed to the Branch Head).</p>
            <div className="flex flex-wrap gap-x-5 gap-y-1">
              {(data.catalog?.focus ?? []).map((i) => (
                <label key={i.key} className="flex items-center gap-1.5 text-sm text-gray-700">
                  <input type="checkbox" checked={r.focus[i.key] !== false} onChange={(e) => set({ ...r, focus: { ...r.focus, [i.key]: e.target.checked } })} />
                  {i.label}
                </label>
              ))}
            </div>
          </div>
          <div className={CARD}>
            <h3 className="text-sm font-semibold text-gray-800">NPS (OBM clients)</h3>
            <Num label="The trend line shows the last" suffix="months" min={2} max={12} value={r.npsTrendMonths} onChange={(n) => set({ ...r, npsTrendMonths: n })} />
          </div>
        </>
      )}
    </SettingsScreen>
  );
}
