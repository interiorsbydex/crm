import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';

type Cfg = {
  bookingCreditRatePerLakh: number;
  overachievementCreditsPerLakh: number;
  boosterEligibleCore: number;
  coreIncentiveEligibleCore: number;
  pitchBrackets: { minPitches: number; credits: number }[];
  sameDayPitchCredits: number;
  sameDayBookingCredits: number;
  speedCreditMode: 'once_per_cycle' | 'per_lead';
  attendanceCredits: number;
  zeroEscalationCredits: number;
  npsRelease: { minRating: number; releasePct: number }[];
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

export default function IncentiveRulesAdmin() {
  const [data, setData] = useState<Resp | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<Resp>('/incentive/config')
      .then((d) => { setData(d); setCfg(d.config); })
      .catch((e: any) => toast.error(e?.message ?? 'Could not load credit rules'));
  }, []);

  if (!cfg || !data) return <p className="text-sm text-gray-400">Loading credit rules…</p>;
  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg({ ...cfg, [k]: v });

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<{ config: Cfg }>('/incentive/config', { config: cfg });
      setCfg(res.config);
      setData({ ...data, isDefault: false, updatedAt: new Date().toISOString() });
      toast.success('Credit rules saved');
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save credit rules');
    } finally { setSaving(false); }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-6" data-testid="incentive-rules">
      <div>
        <h2 className="font-semibold text-gray-900">Designer Credit Rules</h2>
        <p className="mt-1 text-xs text-gray-500">
          Credit tracking only — no payment. Monthly booking targets are set under Sales Performance Targets.
          {data.isDefault ? ' Showing the default rules from the credit calculator document (not yet saved).' : data.updatedAt ? ` Last saved ${new Date(data.updatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}.` : ''}
        </p>
      </div>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Core credits</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label="Booking credit per ₹1 lakh" hint="Counted on booked value up to the target." value={cfg.bookingCreditRatePerLakh} onChange={(n) => set('bookingCreditRatePerLakh', n)} />
          <NumField label="Overachievement credits per ₹1 lakh" hint="Above target; added to core, not capped." value={cfg.overachievementCreditsPerLakh} onChange={(n) => set('overachievementCreditsPerLakh', n)} />
          <NumField label="Core credits for booster to apply" value={cfg.boosterEligibleCore} onChange={(n) => set('boosterEligibleCore', n)} />
          <NumField label="Core credits for core incentive + NPS" value={cfg.coreIncentiveEligibleCore} onChange={(n) => set('coreIncentiveEligibleCore', n)} />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Booster credits</h3>
        <p className="text-[11px] text-gray-400">Pitch brackets: a designer gets the credits of the highest row whose minimum they reach; below the first row is 0.</p>
        <div className="space-y-2">
          {cfg.pitchBrackets.map((b, i) => (
            <div key={i} className="flex items-end gap-3">
              <NumField label="Minimum pitches" step="1" value={b.minPitches} onChange={(n) => set('pitchBrackets', cfg.pitchBrackets.map((x, j) => j === i ? { ...x, minPitches: n } : x))} />
              <NumField label="Credits" value={b.credits} onChange={(n) => set('pitchBrackets', cfg.pitchBrackets.map((x, j) => j === i ? { ...x, credits: n } : x))} />
              <button onClick={() => set('pitchBrackets', cfg.pitchBrackets.filter((_, j) => j !== i))} className="mb-1 text-xs text-red-500 hover:underline">Remove</button>
            </div>
          ))}
          <button onClick={() => set('pitchBrackets', [...cfg.pitchBrackets, { minPitches: 0, credits: 0 }])} className="text-xs font-medium text-brand-600 hover:underline">+ Add bracket</button>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NumField label="Same-day lead → pitch" value={cfg.sameDayPitchCredits} onChange={(n) => set('sameDayPitchCredits', n)} />
          <NumField label="Same-day lead → booking" value={cfg.sameDayBookingCredits} onChange={(n) => set('sameDayBookingCredits', n)} />
          <label className="block text-xs text-gray-600">
            <span className="font-medium text-gray-800">Speed credits awarded</span>
            <select value={cfg.speedCreditMode} onChange={(e) => set('speedCreditMode', e.target.value as Cfg['speedCreditMode'])}
              className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm">
              <option value="once_per_cycle">Once per cycle</option>
              <option value="per_lead">For every qualifying lead</option>
            </select>
          </label>
          <NumField label="Attendance (manual)" value={cfg.attendanceCredits} onChange={(n) => set('attendanceCredits', n)} />
          <NumField label="Zero escalations" value={cfg.zeroEscalationCredits} onChange={(n) => set('zeroEscalationCredits', n)} />
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">NPS / CX release</h3>
        <p className="text-[11px] text-gray-400">Highest row whose minimum rating is reached applies; below the first row is 0%. Display only — never changes credits.</p>
        <div className="space-y-2">
          {cfg.npsRelease.map((b, i) => (
            <div key={i} className="flex items-end gap-3">
              <NumField label="Minimum rating" step="0.5" value={b.minRating} onChange={(n) => set('npsRelease', cfg.npsRelease.map((x, j) => j === i ? { ...x, minRating: n } : x))} />
              <NumField label="Release %" value={b.releasePct} onChange={(n) => set('npsRelease', cfg.npsRelease.map((x, j) => j === i ? { ...x, releasePct: n } : x))} />
              <button onClick={() => set('npsRelease', cfg.npsRelease.filter((_, j) => j !== i))} className="mb-1 text-xs text-red-500 hover:underline">Remove</button>
            </div>
          ))}
          <button onClick={() => set('npsRelease', [...cfg.npsRelease, { minRating: 0, releasePct: 0 }])} className="text-xs font-medium text-brand-600 hover:underline">+ Add row</button>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-lg bg-brand-500 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40">
          {saving ? 'Saving…' : 'Save credit rules'}
        </button>
        <button onClick={() => setCfg(data.defaults)} className="text-xs text-gray-500 hover:underline">Reset form to defaults</button>
      </div>
    </div>
  );
}
