import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { api } from '../../lib/api';
import { getStoredUser } from '../../lib/auth';
import { Link } from 'react-router-dom';
import { cycleDescription } from '../../lib/crmSettings';

type Designer = { id: string; name: string };
type Validation = { leadId: string; name: string; bookingValue: number; rating: number | null; status: string; releasePct: number | null };
type Result = {
  designer: Designer;
  cycle: { label: string };
  core: {
    achievedLakh: number; targetLakh: number | null; standard: number; overachievement: number; total: number;
    bookingValue: number; bookingCount: number; targetMissing: boolean; note: string;
  };
  booster: {
    total: number;
    pitch: { pitches: number; credits: number; missingCompletionDates?: number };
    speed: { mode: string; sameDayPitchLeads: number; sameDayPitchCredits: number; sameDayBookingLeads: number; sameDayBookingCredits: number };
    zeroEscalation: { escalations: number; credits: number };
    attendance: { awarded: boolean; credits: number; enteredById: string | null; enteredAt: string | null; notEntered?: boolean };
  };
  totalCredits: number;
  eligibility: { band: string; boosterApplicable: boolean; coreIncentiveEligible: boolean; note: string };
  validation: { applicable: boolean; overall: string; rows: Validation[]; note: string };
};
type Resp = {
  designers: Designer[]; result: Result | null;
  review?: {
    status: 'PENDING_REVIEW'; reason: string; designerId: string; cycle: { label: string };
    leads: { id: string; leadId: string; name: string; reason: string }[];
  };
};

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });

function cycleOptions() {
  const now = new Date();
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i - (now.getDate() < 16 ? 1 : 0), 20);
    return { value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-20`, label: i === 0 ? 'Current cycle' : i === 1 ? 'Previous cycle' : `${i} cycles ago` };
  });
}

function Box({ label, value, sub, tone = 'gray' }: { label: string; value: string; sub?: string; tone?: 'gray' | 'brand' | 'green' }) {
  const bg = tone === 'brand' ? 'bg-brand-50' : tone === 'green' ? 'bg-green-50' : 'bg-gray-50';
  return (
    <div className={`${bg} rounded-xl p-4`}>
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

function Row({ label, detail, credits }: { label: string; detail?: string; credits: number }) {
  return (
    <div className="flex items-center justify-between py-2 text-sm">
      <div>
        <p className="text-gray-800">{label}</p>
        {detail && <p className="text-[11px] text-gray-400">{detail}</p>}
      </div>
      <span className="font-semibold text-gray-900">{credits > 0 ? `+${fmt(credits)}` : '0'}</span>
    </div>
  );
}

export default function CreditsPanel({ showTitle = true }: { showTitle?: boolean }) {
  const role = getStoredUser()?.role ?? '';
  const canEnterAttendance = role === 'BRANCH_HEAD' || role === 'BL';
  const [cycle, setCycle] = useState(cycleOptions()[0].value);
  const [designerId, setDesignerId] = useState('');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const requestSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const p = new URLSearchParams({ cycle });
    if (designerId) p.set('designerId', designerId);
    api.get<Resp>(`/incentive/credits?${p}`)
      .then((d) => { if (seq === requestSeq.current) { setData(d); setError(null); } })
      .catch((e: any) => { if (seq === requestSeq.current) setError(e?.message ?? 'Could not load credits'); })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [cycle, designerId]);
  useEffect(() => { load(); }, [load]);

  const setAttendance = async (awarded: boolean) => {
    if (!data?.result) return;
    setSaving(true);
    try {
      await api.put('/incentive/attendance', { designerId: data.result.designer.id, cycle, awarded });
      toast.success(awarded ? 'Attendance credit approved' : 'Attendance credit removed');
      load();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save attendance');
    } finally { setSaving(false); }
  };

  const r = data?.result;
  const bandStyle = r?.eligibility.band === 'CORE_ELIGIBLE' ? 'border-green-200 bg-green-50 text-green-800'
    : r?.eligibility.band === 'BOOSTER_ONLY' ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-gray-200 bg-gray-50 text-gray-700';

  const body = (
    <div className="space-y-4" data-testid="credits-panel">
      <div className="flex flex-wrap items-end gap-3">
        {showTitle && <h3 className="mr-auto text-sm font-semibold text-gray-900">Credits ({cycleDescription()} cycle)</h3>}
        {data && data.designers.length > 1 && (
          <label className="text-xs text-gray-500">Designer
            <select value={designerId || r?.designer.id || data.review?.designerId || ''} onChange={(e) => setDesignerId(e.target.value)}
              className="ml-2 rounded-lg border border-gray-200 px-2 py-1 text-xs">
              {data.designers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs text-gray-500">Cycle
          <select value={cycle} onChange={(e) => setCycle(e.target.value)} className="ml-2 rounded-lg border border-gray-200 px-2 py-1 text-xs">
            {cycleOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>

      {loading ? <p className="py-6 text-center text-sm text-gray-400">Loading credits…</p>
        : error ? <p className="py-6 text-center text-sm text-red-500">{error}</p>
        : data?.review ? (
          <div className="space-y-3" data-testid="credit-cancellation-review">
            <p className="text-xs text-gray-500">{data.designers.find((d) => d.id === data.review?.designerId)?.name} · {data.review.cycle.label}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Box label="Core credits" value="Unavailable" tone="brand" />
              <Box label="Booster credits" value="Unavailable" />
              <Box label="Total credits" value="Unavailable" tone="green" />
            </div>
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
              <p className="font-semibold">Unavailable pending review</p>
              <p className="mt-1">{data.review.reason}</p>
              <ul className="mt-2 space-y-1">
                {data.review.leads.map((lead) => (
                  <li key={lead.id}>
                    <Link className="underline" to={`/leads/${lead.id}`}>{lead.leadId} — {lead.name}</Link>
                    <span> · {lead.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )
        : !r ? <p className="py-6 text-center text-sm text-gray-400">No designers to show.</p> : (
          <>
            <p className="text-xs text-gray-500">{r.designer.name} · {r.cycle.label}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Box label="Core credits" value={fmt(r.core.total)} sub={r.core.targetMissing ? 'No target set for this cycle' : `Target ₹${fmt(r.core.targetLakh ?? 0)}L · booked ₹${fmt(r.core.achievedLakh)}L`} tone="brand" />
              <Box label="Booster credits" value={fmt(r.booster.total)} sub={r.eligibility.boosterApplicable ? 'Applicable' : 'Tracked, not yet applicable'} />
              <Box label="Total credits" value={fmt(r.totalCredits)} tone="green" />
            </div>
            <div className={`rounded-xl border px-4 py-3 text-xs ${bandStyle}`}>{r.eligibility.note}</div>

            <div className="rounded-xl border border-gray-100 px-4 py-2 divide-y divide-gray-50">
              <p className="py-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Core credits</p>
              <Row label="Standard booking credits" detail={r.core.note} credits={r.core.standard} />
              <Row label="Booking overachievement" detail="Extra credits per ₹1L above target" credits={r.core.overachievement} />
            </div>

            <div className="rounded-xl border border-gray-100 px-4 py-2 divide-y divide-gray-50">
              <p className="py-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Booster credits</p>
              <Row label="Monthly pitches" detail={`${r.booster.pitch.pitches} pitch${r.booster.pitch.pitches === 1 ? '' : 'es'} this cycle`} credits={r.booster.pitch.credits} />
              {!!r.booster.pitch.missingCompletionDates && (
                <p className="px-3 py-2 text-xs text-amber-700" data-testid="credit-pitch-completion-warning">
                  {r.booster.pitch.missingCompletionDates} completed PP meeting(s) have no completion-date history and are excluded from cycle-based pitch credits.
                </p>
              )}
              <Row label="Same-day lead → pitch" detail={`${r.booster.speed.sameDayPitchLeads} qualifying lead(s)`} credits={r.booster.speed.sameDayPitchCredits} />
              <Row label="Same-day lead → booking" detail={`${r.booster.speed.sameDayBookingLeads} qualifying lead(s)`} credits={r.booster.speed.sameDayBookingCredits} />
              <Row label="Zero escalations" detail={`${r.booster.zeroEscalation.escalations} flag(s) not resolved within this cycle`} credits={r.booster.zeroEscalation.credits} />
              <div className="flex items-center justify-between py-2 text-sm">
                <div>
                  <p className="text-gray-800">Attendance (manual)</p>
                  <p className="text-[11px] text-gray-400">
                    {r.booster.attendance.notEntered ? 'Not entered yet'
                      : `${r.booster.attendance.awarded ? 'Approved' : 'Not approved'} · entered ${r.booster.attendance.enteredAt ? new Date(r.booster.attendance.enteredAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : ''}`}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-gray-900">{r.booster.attendance.credits > 0 ? `+${r.booster.attendance.credits}` : '0'}</span>
                  {canEnterAttendance && (
                    <button disabled={saving} onClick={() => setAttendance(!r.booster.attendance.awarded)}
                      className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                      {r.booster.attendance.awarded ? 'Remove' : 'Approve'}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-gray-100 px-4 py-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">NPS / client validation</p>
                <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${r.validation.overall === 'VERIFIED' ? 'bg-green-100 text-green-700' : r.validation.overall === 'PENDING_VALIDATION' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>
                  {r.validation.overall === 'NOT_APPLICABLE' ? 'Not applicable yet' : r.validation.overall === 'VERIFIED' ? 'Verified' : 'Pending Validation'}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-gray-400">{r.validation.note}</p>
              {r.validation.rows.length > 0 && (
                <table className="mt-2 w-full text-xs">
                  <thead><tr className="text-left text-[10px] uppercase tracking-wide text-gray-400"><th className="py-1">Lead</th><th>Rating</th><th>Status</th><th>Release</th></tr></thead>
                  <tbody>
                    {r.validation.rows.map((v) => (
                      <tr key={v.leadId} className="border-t border-gray-50">
                        <td className="py-1.5">{v.leadId}</td>
                        <td>{v.rating ?? '—'}</td>
                        <td>{v.status === 'VERIFIED' ? 'Verified' : 'Pending Validation'}</td>
                        <td>{v.releasePct == null ? '—' : `${v.releasePct}%`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
    </div>
  );

  if (role !== 'BL') return body;
  return (
    <div className="space-y-6">
      <div className="space-y-2" data-testid="bl-own-credits">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">My BL Credits</p>
        <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
          Not yet available. A separate BL credit calculation is on hold, so no BL credit totals are shown here. The figures below are your team designers' credits, not your own.
        </div>
      </div>
      <div className="space-y-2" data-testid="team-designer-credits">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Team Designer Credits</p>
        {body}
      </div>
    </div>
  );
}
