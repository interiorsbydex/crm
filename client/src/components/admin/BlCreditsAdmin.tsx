// Admin screens for Business Lead credits: the rules (Credit Rules tab) and
// each BL's booking target per cycle (Sales Performance Targets tab).
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { cycleDescription } from '../../lib/crmSettings';

type Cfg = {
  standardAboveTarget: 'keep_growing' | 'stop_at_100';
  overachievementCreditsPerLakh: number;
  pitchSlabs: { abovePerDesigner: number; credits: number }[];
  sameDayPitchCredits: number;
  sameDayBookingCredits: number;
};
type Resp = { config: Cfg; isDefault: boolean; updatedAt: string | null; defaults: Cfg };

function NumField({ label, hint, value, onChange, step = 'any' }: { label: string; hint?: string; value: number; onChange: (n: number) => void; step?: string }) {
  return (
    <label className="block text-xs text-gray-600">
      <span className="font-medium text-gray-800">{label}</span>
      <input type="number" min={0} step={step} value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm" />
      {hint && <span className="mt-0.5 block text-[11px] text-gray-400">{hint}</span>}
    </label>
  );
}

export default function BlCreditRulesAdmin() {
  const [data, setData] = useState<Resp | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Resp>('/incentive/bl-config')
      .then((d) => { setData(d); setCfg(d.config); })
      .catch((e: any) => toast.error(e?.message ?? 'Could not load BL credit rules'));
  }, []);

  if (!cfg || !data) return <p className="text-sm text-gray-400">Loading BL credit rules…</p>;
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg({ ...cfg, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<{ config: Cfg }>('/incentive/bl-config', { config: cfg });
      setCfg(res.config);
      setData({ ...data, isDefault: false, updatedAt: new Date().toISOString() });
      toast.success('BL credit rules saved');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save BL credit rules');
    } finally { setSaving(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-6" data-testid="bl-credit-rules">
      <div>
        <h2 className="font-semibold text-gray-900">Business Lead Credit Rules</h2>
        <p className="mt-1 text-xs text-gray-500">
          Credit tracking only — no payment. Each BL's booking target is set under Sales Performance Targets.
          {data.isDefault ? ' Showing the default rules from Annie\'s answers (not yet saved).' : data.updatedAt ? ` Last saved ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.` : ''}
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Core credits</h3>
        <p className="text-[11px] text-gray-400">Standard credits = eligible booking ÷ BL booking target × 100.</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs text-gray-600">
            <span className="font-medium text-gray-800">Standard credits above target</span>
            <select value={cfg.standardAboveTarget} onChange={(e) => set('standardAboveTarget', e.target.value as Cfg['standardAboveTarget'])}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm">
              <option value="keep_growing">Keep growing (no cap)</option>
              <option value="stop_at_100">Stop at 100 (only overachievement adds more)</option>
            </select>
          </label>
          <NumField label="Overachievement credits per ₹1 lakh" hint="Above target, worked out proportionally." value={cfg.overachievementCreditsPerLakh} onChange={(n) => set('overachievementCreditsPerLakh', n)} />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Team pitch booster</h3>
        <p className="text-[11px] text-gray-400">
          The team's completed pitches must be more than (pitches per designer × team size). The highest row reached applies; credits count only after Admin approves them on the BL's credits.
        </p>
        <div className="space-y-2">
          {cfg.pitchSlabs.map((s, i) => (
            <div key={i} className="flex items-end gap-3">
              <NumField label="More than … pitches per designer" value={s.abovePerDesigner} onChange={(n) => set('pitchSlabs', cfg.pitchSlabs.map((x, j) => j === i ? { ...x, abovePerDesigner: n } : x))} />
              <NumField label="Credits" value={s.credits} onChange={(n) => set('pitchSlabs', cfg.pitchSlabs.map((x, j) => j === i ? { ...x, credits: n } : x))} />
              <button onClick={() => set('pitchSlabs', cfg.pitchSlabs.filter((_, j) => j !== i))} className="mb-1 text-xs text-red-500 hover:underline">Remove</button>
            </div>
          ))}
          <button onClick={() => set('pitchSlabs', [...cfg.pitchSlabs, { abovePerDesigner: 0, credits: 0 }])} className="text-xs font-medium text-brand-600 hover:underline">+ Add row</button>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Same-day credits (per lead, once each)</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumField label="Lead pitched the day it came in" value={cfg.sameDayPitchCredits} onChange={(n) => set('sameDayPitchCredits', n)} />
          <NumField label="Lead booked the day it came in" value={cfg.sameDayBookingCredits} onChange={(n) => set('sameDayBookingCredits', n)} />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save BL credit rules'}
        </button>
        <button onClick={() => setCfg(data.defaults)} className="text-xs text-gray-500 hover:underline">Reset form to defaults</button>
      </div>
    </div>
  );
}

type TargetsResp = {
  cycle: { label: string }; locked: boolean;
  bls: { blId: string; name: string; bookingTargetValue: number | null }[];
};

/** Same rules as designer targets: Branch Head only, one per BL per cycle, a finished cycle is locked. */
export function BlTargetsAdmin({ cycleStart }: { cycleStart?: string }) {
  const [data, setData] = useState<TargetsResp | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get<TargetsResp>(`/incentive/bl-targets${cycleStart ? `?cycle=${encodeURIComponent(cycleStart)}` : ''}`)
      .then((d) => {
        setData(d);
        setDrafts(Object.fromEntries(d.bls.map((b) => [b.blId, b.bookingTargetValue == null ? '' : String(b.bookingTargetValue)])));
      })
      .catch((e: any) => toast.error(e?.message ?? 'Could not load BL targets'));
  }, [cycleStart]);
  useEffect(() => { load(); }, [load]);

  const save = async (blId: string) => {
    setSaving(blId);
    try {
      await api.post('/incentive/bl-targets', { blId, bookingTargetValue: drafts[blId], cycle: cycleStart });
      toast.success('BL target saved');
      load();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save BL target');
    } finally { setSaving(null); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 mt-4" data-testid="bl-targets">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-gray-900">Business Lead Booking Targets</h2>
        {data && <span className="text-xs text-gray-400">{data.cycle.label}</span>}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Used for each BL's own core credits ({cycleDescription()} cycle). Once a cycle ends its target is locked.
      </p>
      {!data ? <p className="text-sm text-gray-400">Loading…</p> : data.bls.length === 0 ? <p className="text-sm text-gray-400">No active Business Leads.</p> : (
        <table className="w-full text-sm">
          <thead className="text-gray-500 text-xs">
            <tr><th className="text-left px-3 py-2 font-medium">Business Lead</th><th className="text-left px-3 py-2 font-medium">Booking Target (₹)</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.bls.map((b) => (
              <tr key={b.blId}>
                <td className="px-3 py-2 font-medium text-gray-800">{b.name}</td>
                <td className="px-3 py-2">
                  <input type="number" min={0} disabled={data.locked} aria-label={`Booking target for ${b.name}`}
                    value={drafts[b.blId] ?? ''} onChange={(e) => setDrafts((prev) => ({ ...prev, [b.blId]: e.target.value }))}
                    className="w-40 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    placeholder="e.g. 12000000" />
                </td>
                <td className="px-3 py-2 text-right">
                  {!data.locked && (
                    <button onClick={() => save(b.blId)} disabled={saving === b.blId || drafts[b.blId] === ''}
                      className="rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-600 disabled:opacity-40">
                      {saving === b.blId ? 'Saving…' : 'Save'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
