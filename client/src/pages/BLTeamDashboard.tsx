/**
 * BLTeamDashboard — Business Lead dashboard in the designer format.
 * "Whole team" shows one row per designer in the BL's cohort plus a team total;
 * picking a designer opens that designer's full dashboard (same layout the
 * designer sees). Existing BL-level tiles (collections, delivery) follow below
 * the team table via `teamExtras`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../lib/api';
import DesignerDashboard from './DesignerDashboard';
import DashboardContent from '../components/dashboard/DashboardContent';
import { cycleDescription } from '../lib/crmSettings';

interface Designer { id: string; name: string }
interface Row {
  designer: Designer;
  activeLeads: number;
  ppDone: number;
  onboardings: number;
  bookingAchieved: number;
  bookingTarget: number | null;
  coreCredits: number | null;
  boosterCredits: number | null;
  creditUnavailableReason: string | null;
}

const fmt = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};

export default function BLTeamDashboard({ teamExtras }: { teamExtras?: ReactNode }) {
  const [designers, setDesigners] = useState<Designer[]>([]);
  const [designerId, setDesignerId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ data: { scope: { designers: Designer[] } } }>('/designer-reports/my-lead-funnel')
      .then((r) => setDesigners(r.data.scope.designers))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (designers.length === 0) { setRows([]); setLoading(false); return; }
    setLoading(true);
    Promise.all(designers.map(async (designer): Promise<Row> => {
      const d: any = await api.get(`/dashboard?designerId=${encodeURIComponent(designer.id)}`);
      return {
        designer,
        activeLeads: d.personalStats?.activeLeads ?? 0,
        ppDone: d.personalStats?.ppDone ?? 0,
        onboardings: d.personalStats?.onboardings ?? 0,
        bookingAchieved: d.designerDash?.bookingAchieved ?? 0,
        bookingTarget: d.designerDash?.bookingTarget ?? null,
        coreCredits: d.designerDash?.incentive?.coreCreditsEarned ?? null,
        boosterCredits: d.designerDash?.incentive?.boosterCredits ?? null,
        creditUnavailableReason: d.designerDash?.incentive?.unavailableReason ?? null,
      };
    }))
      .then((r) => { setRows(r); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [designers]);

  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const sumCredits = (key: 'coreCredits' | 'boosterCredits') =>
    rows.some((r) => r[key] == null)
      ? rows.some((r) => r.creditUnavailableReason?.includes('pending review')) ? 'Unavailable (pending review)' : 'Unavailable'
      : sum((r) => r[key] ?? 0);
  const targets = rows.map((r) => r.bookingTarget);
  const totalTarget = targets.some((t) => t != null) ? targets.reduce<number>((a, t) => a + (t ?? 0), 0) : null;

  return (
    <div data-testid="bl-team-dashboard">
      <div className="px-6 pt-6 max-w-7xl mx-auto flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Dashboard</h1>
          <p className="text-sm text-stone-400 mt-0.5">
            {designerId ? 'One designer — same view the designer sees' : 'Whole team — one row per designer'}
          </p>
        </div>
        <label className="text-xs text-stone-500">
          Designer
          <select
            data-testid="bl-dashboard-designer-select"
            className="mt-1 block rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-stone-800"
            value={designerId}
            onChange={(e) => setDesignerId(e.target.value)}
          >
            <option value="">Whole team</option>
            {designers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      </div>

      {error && (
        <div className="px-6 pt-4 max-w-7xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>
        </div>
      )}

      <DashboardContent />

      {designerId ? (
        <DesignerDashboard key={designerId} designerId={designerId} designerName={designers.find((d) => d.id === designerId)?.name} />
      ) : (
        <>
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
              <div className="px-5 py-3" style={{ borderBottom: '1px solid #EDE8E3' }}>
                <h3 className="font-bold text-stone-900">Team by designer</h3>
                <p className="text-xs text-stone-400 mt-0.5">
                  Active leads: current. PP done and onboarded: all-time. Booking, targets and designer credits: current {cycleDescription()} cycle.
                  Credits below belong to designers, not the BL's personal incentive calculation. Click a designer to open their full dashboard.
                </p>
              </div>
              {loading ? (
                <p className="text-sm text-stone-400 text-center py-8">Loading…</p>
              ) : rows.length === 0 ? (
                <p className="text-sm text-stone-400 text-center py-8" data-testid="bl-team-empty">No designers are assigned to you yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] uppercase tracking-wide text-stone-400">
                        {['Designer', 'Active leads', 'PP done', 'Onboarded', 'Booking achieved', 'Booking target', 'Core credits', 'Booster credits'].map((h) => (
                          <th key={h} className="px-4 py-2 font-semibold whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {rows.map((r) => (
                        <tr key={r.designer.id} data-testid="bl-team-row" className="hover:bg-stone-50 cursor-pointer" onClick={() => setDesignerId(r.designer.id)}>
                          <td className="px-4 py-2.5 font-medium text-stone-900">{r.designer.name}</td>
                          <td className="px-4 py-2.5">{r.activeLeads}</td>
                          <td className="px-4 py-2.5">{r.ppDone}</td>
                          <td className="px-4 py-2.5">{r.onboardings}</td>
                          <td className="px-4 py-2.5">{fmt(r.bookingAchieved)}</td>
                          <td className="px-4 py-2.5">{r.bookingTarget != null ? fmt(r.bookingTarget) : '—'}</td>
                          <td className="px-4 py-2.5" title={r.creditUnavailableReason ?? undefined}>{r.coreCredits ?? (r.creditUnavailableReason?.includes('pending review') ? 'Unavailable (pending review)' : 'Unavailable')}</td>
                          <td className="px-4 py-2.5" title={r.creditUnavailableReason ?? undefined}>{r.boosterCredits ?? (r.creditUnavailableReason?.includes('pending review') ? 'Unavailable (pending review)' : 'Unavailable')}</td>
                        </tr>
                      ))}
                      <tr className="bg-stone-50 font-semibold" data-testid="bl-team-total">
                        <td className="px-4 py-2.5">Team total</td>
                        <td className="px-4 py-2.5">{sum((r) => r.activeLeads)}</td>
                        <td className="px-4 py-2.5">{sum((r) => r.ppDone)}</td>
                        <td className="px-4 py-2.5">{sum((r) => r.onboardings)}</td>
                        <td className="px-4 py-2.5">{fmt(sum((r) => r.bookingAchieved))}</td>
                        <td className="px-4 py-2.5">{totalTarget != null ? fmt(totalTarget) : '—'}</td>
                        <td className="px-4 py-2.5">{sumCredits('coreCredits')}</td>
                        <td className="px-4 py-2.5">{sumCredits('boosterCredits')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          {teamExtras}
        </>
      )}
    </div>
  );
}
