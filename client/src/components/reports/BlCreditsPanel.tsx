// Business Lead's own credits (server: lib/blCredits.ts). A BL sees their own;
// a Branch Head picks any BL, or sees one fixed BL when `blId` is given, and
// approves the team pitch booster.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { getStoredUser } from '../../lib/auth';
import { downloadCsv } from '../../lib/csv';

type Bl = { id: string; name: string };
type BookingRow = { id: string; leadId: string; name: string; value: number; bookedAt: string; cancelledAt: string | null; heldBy: string };
type Slab = { abovePerDesigner: number; credits: number; abovePitches: number };
type Result = {
  bl: Bl;
  cycle: { label: string };
  core: {
    achievementPct: number | null; standard: number; overachievement: number; total: number; targetMissing: boolean;
    bookingValue: number; reversedValue: number; eligibleValue: number; targetValue: number | null;
    bookings: BookingRow[]; cancelledInCycle: BookingRow[]; reversals: BookingRow[]; undatedCancellations: BookingRow[];
  };
  booster: {
    pitch: {
      teamPitches: number; teamSize: number; team: { id: string; name: string; share: number; pitches: number }[];
      slabs: Slab[]; reached: Slab | null; next: Slab | null; calculatedCredits: number; credits: number;
      approval: { status: 'APPROVED' | 'NOT_APPROVED' | 'AWAITING'; byId: string | null; at: string | null };
    };
    sameDayPitch: { leads: { id: string; leadId: string; name: string }[]; credits: number };
    sameDayBooking: { leads: BookingRow[]; reversed: BookingRow[]; credits: number };
    total: number;
  };
  totalCredits: number;
  missingCompletionDates: number;
};
type Resp = { bls: Bl[]; result: Result | null };

const fmt = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
const lakh = (n: number) => `₹${fmt(n / 100000)}L`;
const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : fmt(n));

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

function Row({ label, detail, credits, children }: { label: string; detail?: string; credits: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 text-sm">
      <div>
        <p className="text-gray-800">{label}</p>
        {detail && <p className="text-[11px] text-gray-400">{detail}</p>}
      </div>
      <div className="flex items-center gap-3">
        <span className="font-semibold text-gray-900">{credits}</span>
        {children}
      </div>
    </div>
  );
}

function LeadList({ title, rows, tone = 'text-gray-600' }: { title: string; rows: BookingRow[]; tone?: string }) {
  if (!rows.length) return null;
  return (
    <div className={`px-1 py-2 text-xs ${tone}`}>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((b) => (
          <li key={b.id}>
            <Link className="underline" to={`/leads/${b.id}`}>{b.leadId} — {b.name}</Link>
            <span> · {lakh(b.value)} · {b.heldBy}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BlCreditsPanel({ blId: fixedBlId }: { blId?: string }) {
  const isBranchHead = getStoredUser()?.role === 'BRANCH_HEAD';
  const [cycle, setCycle] = useState(cycleOptions()[0].value);
  const [pickedBlId, setPickedBlId] = useState('');
  const [data, setData] = useState<Resp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showDetail, setShowDetail] = useState(false);
  const requestSeq = useRef(0);
  const blId = fixedBlId || pickedBlId;

  const load = useCallback(() => {
    const seq = ++requestSeq.current;
    setLoading(true);
    const p = new URLSearchParams({ cycle });
    if (blId) p.set('blId', blId);
    api.get<Resp>(`/incentive/bl-credits?${p}`)
      .then((d) => { if (seq === requestSeq.current) { setData(d); setError(null); } })
      .catch((e: any) => { if (seq === requestSeq.current) setError(e?.message ?? 'Could not load BL credits'); })
      .finally(() => { if (seq === requestSeq.current) setLoading(false); });
  }, [cycle, blId]);
  useEffect(() => { load(); }, [load]);

  const r = data?.result;

  const setApproval = async (approved: boolean) => {
    if (!r) return;
    setSaving(true);
    try {
      await api.put('/incentive/bl-pitch-approval', { blId: r.bl.id, cycle, approved });
      toast.success(approved ? 'Pitch booster approved' : 'Pitch booster approval removed');
      load();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save approval');
    } finally { setSaving(false); }
  };

  const exportCsv = () => {
    if (!r) return;
    const line = (section: string, item: string, detail: string, credits: number | string) => ({ BL: r.bl.name, Cycle: r.cycle.label, Section: section, Item: item, Detail: detail, Credits: credits });
    const p = r.booster.pitch;
    downloadCsv(`bl_credits_${r.bl.name.replace(/\s+/g, '_')}_${r.cycle.label.replace(/\s+/g, '_')}`, [
      line('Core', 'Standard credits', `Eligible booking ${lakh(r.core.eligibleValue)} of target ${r.core.targetValue == null ? 'not set' : lakh(r.core.targetValue)}`, r.core.standard),
      line('Core', 'Overachievement', 'Per ₹1L above target', r.core.overachievement),
      line('Booster', 'Team pitch booster', `${p.teamPitches} pitches, team size ${p.teamSize}; ${p.approval.status === 'APPROVED' ? 'approved' : 'not approved yet'}`, p.credits),
      line('Booster', 'Same-day pitch', `${r.booster.sameDayPitch.leads.length} lead(s)`, r.booster.sameDayPitch.credits),
      line('Booster', 'Same-day booking', `${r.booster.sameDayBooking.leads.length} lead(s), ${r.booster.sameDayBooking.reversed.length} reversed`, r.booster.sameDayBooking.credits),
      line('Total', 'Core credits', '', r.core.total),
      line('Total', 'Booster credits', '', r.booster.total),
      line('Total', 'Total credits', '', r.totalCredits),
      ...r.core.bookings.map((b) => line('Booking', b.leadId, `${b.name}; ${b.heldBy}`, b.value)),
      ...r.core.reversals.map((b) => line('Cancellation reversed', b.leadId, `${b.name}; ${b.heldBy}`, -b.value)),
    ]);
  };

  const p = r?.booster.pitch;
  return (
    <div className="space-y-4" data-testid="bl-credits-panel">
      <div className="flex flex-wrap items-end gap-3">
        {!fixedBlId && data && data.bls.length > 1 && (
          <label className="text-xs text-gray-500">Business Lead
            <select value={blId || r?.bl.id || ''} onChange={(e) => setPickedBlId(e.target.value)}
              className="ml-2 rounded-lg border border-gray-200 px-2 py-1 text-xs" data-testid="bl-credits-bl-select">
              {data.bls.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
        )}
        <label className="text-xs text-gray-500">Cycle
          <select value={cycle} onChange={(e) => setCycle(e.target.value)} className="ml-2 rounded-lg border border-gray-200 px-2 py-1 text-xs">
            {cycleOptions().map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {r && (
          <button type="button" onClick={exportCsv}
            className="text-xs font-medium text-gray-500 hover:text-gray-800 border border-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-50 transition-colors">
            ↓ Export CSV
          </button>
        )}
      </div>

      {loading ? <p className="py-6 text-center text-sm text-gray-400">Loading BL credits…</p>
        : error ? <p className="py-6 text-center text-sm text-red-500">{error}</p>
        : !r || !p ? <p className="py-6 text-center text-sm text-gray-400">No Business Leads to show.</p> : (
          <>
            <p className="text-xs text-gray-500">{r.bl.name} · {r.cycle.label}</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Box label="Core credits" value={r.core.targetMissing ? '—' : fmt(r.core.total)} tone="brand"
                sub={r.core.targetMissing ? 'No BL booking target set for this cycle (Admin → Sales Performance Targets)'
                  : `${fmt(r.core.achievementPct ?? 0)}% of ${lakh(r.core.targetValue ?? 0)} target · eligible ${lakh(r.core.eligibleValue)}`} />
              <Box label="Booster credits" value={fmt(r.booster.total)}
                sub={p.approval.status === 'APPROVED' ? 'Pitch booster approved' : p.calculatedCredits > 0 ? `+${fmt(p.calculatedCredits)} pitch booster awaiting Admin approval` : undefined} />
              <Box label="Total credits" value={fmt(r.totalCredits)} tone="green" />
            </div>

            {r.core.undatedCancellations.length > 0 && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                {r.core.undatedCancellations.length} booking(s) are now inactive but the CRM has no date for the cancellation, so they were not reversed. Check them below.
              </div>
            )}

            <div className="rounded-xl border border-gray-100 px-4 py-2 divide-y divide-gray-50">
              <p className="py-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Core credits</p>
              <Row label="Standard credits" credits={fmt(r.core.standard)}
                detail={`Eligible booking ÷ BL target × 100. Booked ${lakh(r.core.bookingValue)} (${r.core.bookings.length} booking${r.core.bookings.length === 1 ? '' : 's'})${r.core.reversedValue ? ` − ${lakh(r.core.reversedValue)} cancelled from earlier cycles` : ''}.`} />
              <Row label="Overachievement" detail="Extra credits per ₹1 lakh above the target" credits={signed(r.core.overachievement)} />
            </div>

            <div className="rounded-xl border border-gray-100 px-4 py-2 divide-y divide-gray-50">
              <p className="py-2 text-xs font-semibold uppercase tracking-wider text-gray-500">Booster credits</p>
              <Row label="Team pitch booster"
                detail={`${p.teamPitches} completed team pitches · team size ${fmt(p.teamSize)} · ${p.reached ? `above ${fmt(p.reached.abovePitches)} (${p.reached.abovePerDesigner} per designer)` : p.next ? `need more than ${fmt(p.next.abovePitches)} for +${fmt(p.next.credits)}` : 'no designers in the team this cycle'}`
                  + (p.approval.status === 'APPROVED' ? ' · approved' : p.approval.status === 'NOT_APPROVED' ? ' · not approved' : p.calculatedCredits > 0 ? ' · awaiting Admin approval' : '')}
                credits={p.approval.status === 'APPROVED' ? signed(p.credits) : p.calculatedCredits > 0 ? `(+${fmt(p.calculatedCredits)})` : '0'}>
                {isBranchHead && p.calculatedCredits > 0 && (
                  <button disabled={saving} onClick={() => setApproval(p.approval.status !== 'APPROVED')} data-testid="bl-pitch-approve"
                    className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                    {p.approval.status === 'APPROVED' ? 'Remove approval' : 'Approve'}
                  </button>
                )}
              </Row>
              <Row label="Same-day pitch" detail={`${r.booster.sameDayPitch.leads.length} lead(s) pitched on the day they came in`} credits={signed(r.booster.sameDayPitch.credits)} />
              <Row label="Same-day booking"
                detail={`${r.booster.sameDayBooking.leads.length} lead(s) booked on the day they came in${r.booster.sameDayBooking.reversed.length ? ` · ${r.booster.sameDayBooking.reversed.length} reversed (cancelled)` : ''}`}
                credits={signed(r.booster.sameDayBooking.credits)} />
              {r.missingCompletionDates > 0 && (
                <p className="py-2 text-xs text-amber-700">{r.missingCompletionDates} completed pitch meeting(s) have no completion date and are not counted.</p>
              )}
            </div>

            <button type="button" onClick={() => setShowDetail((v) => !v)} className="text-xs font-medium text-brand-600 hover:underline">
              {showDetail ? 'Hide details' : 'Show bookings, cancellations and team'}
            </button>
            {showDetail && (
              <div className="rounded-xl border border-gray-100 px-4 py-2 divide-y divide-gray-50">
                <LeadList title="Bookings counted this cycle" rows={r.core.bookings} />
                <LeadList title="Cancelled earlier-cycle bookings reversed this cycle" rows={r.core.reversals} tone="text-red-700" />
                <LeadList title="Booked and cancelled within this cycle (no credit)" rows={r.core.cancelledInCycle} />
                <LeadList title="Inactive with no cancellation date (not reversed)" rows={r.core.undatedCancellations} tone="text-amber-700" />
                <div className="px-1 py-2 text-xs text-gray-600">
                  <p className="font-medium">Team this cycle</p>
                  <p className="text-[11px] text-gray-400">Someone in the team for part of the cycle counts as part of a designer (days in team ÷ days in cycle).</p>
                  <ul className="mt-1 space-y-0.5">
                    {p.team.map((m) => <li key={m.id}>{m.name} · {fmt(m.share)} · {m.pitches} pitch{m.pitches === 1 ? '' : 'es'}</li>)}
                  </ul>
                </div>
              </div>
            )}
          </>
        )}
    </div>
  );
}
