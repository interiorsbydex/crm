/**
 * BLTeamDashboard — Business Lead dashboard in the designer format.
 * "Whole team" shows the team's sales picture (booking vs target, pipeline,
 * funnel, pipeline potential, allocation, flags, today's work) built from the
 * same per-designer numbers each designer sees, then one row per designer and
 * a team total. Picking a designer opens that designer's full dashboard (same
 * layout the designer sees). Existing BL-level tiles (collections, delivery)
 * follow via `teamExtras`. Every block can be hidden, renamed or reordered in
 * Admin → Dashboards ("Business Lead — team panel").
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DesignerDashboard from './DesignerDashboard';
import DashboardContent from '../components/dashboard/DashboardContent';
import { cycleDescription } from '../lib/crmSettings';
import { Tile, TileGroup, useDashboardLayout } from '../lib/dashboardLayout';
import { useLiveRefresh } from '../lib/liveRefresh';
import { formatLeadProgressionTat, type LeadProgressionRow } from '../lib/leadProgression';
import { formulas } from '../lib/formulas';

interface Designer { id: string; name: string }
interface Tier { count: number; value: number }
interface Row {
  designer: Designer;
  activeLeads: number;
  pipelineValue: number;
  ppDone: number;
  onboardings: number;
  bookingAchieved: number;
  bookingTarget: number | null;
  coreCredits: number | null;
  boosterCredits: number | null;
  creditUnavailableReason: string | null;
  obmNps: number | null;
  obmNpsLastMonth: number | null;
  dueToday: number;
  forecast: { highIntent: Tier; mediumIntent: Tier; lowIntent: Tier } | null;
}
interface Allocation { total: number; active: number; onHold: number; inactive: number }
interface FlagRow { name: string; leads: { id: string; leadId: string; name: string }[] }

const fmt = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};
const pct = (a: number, b: number | null) => (b && b > 0 ? Math.round((a / b) * 100) : null);
const card = 'bg-white rounded-2xl shadow-warm-sm';
const cardStyle = { border: '1px solid #EDE8E3' };

export default function BLTeamDashboard({ teamExtras }: { teamExtras?: ReactNode }) {
  const [designers, setDesigners] = useState<Designer[]>([]);
  const [funnel, setFunnel] = useState<LeadProgressionRow[] | null>(null);
  const [designerId, setDesignerId] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [flags, setFlags] = useState<FlagRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadFunnel = useCallback(() => api.get<{ data: { scope: { designers: Designer[] }; stages: LeadProgressionRow[]; progressionStages?: LeadProgressionRow[] } }>('/designer-reports/my-lead-funnel')
    .then((r) => {
      setDesigners((prev) => (JSON.stringify(prev) === JSON.stringify(r.data.scope.designers) ? prev : r.data.scope.designers));
      setFunnel(r.data.progressionStages ?? r.data.stages);
    })
    .catch((e) => setError(e.message)), []);

  useEffect(() => { void loadFunnel(); }, [loadFunnel]);

  const loadTeam = useCallback(async (background = false) => {
    if (designers.length === 0) { setRows([]); setLoading(false); return; }
    if (!background) setLoading(true);
    try {
      const count = async (q: string) => (await api.get<{ total: number }>(`/leads?limit=1${q}`)).total ?? 0;
      const [teamRows, total, active, onHold, inactive, flagged] = await Promise.all([
        Promise.all(designers.map(async (designer): Promise<Row> => {
          const d: any = await api.get(`/dashboard?designerId=${encodeURIComponent(designer.id)}`);
          const dd = d.designerDash ?? {};
          return {
            designer,
            activeLeads: d.personalStats?.activeLeads ?? 0,
            pipelineValue: Number(d.activeLeadsValue ?? 0),
            ppDone: d.personalStats?.ppDone ?? 0,
            onboardings: d.personalStats?.onboardings ?? 0,
            bookingAchieved: dd.bookingAchieved ?? 0,
            bookingTarget: dd.bookingTarget ?? null,
            coreCredits: dd.incentive?.coreCreditsEarned ?? null,
            boosterCredits: dd.incentive?.boosterCredits ?? null,
            creditUnavailableReason: dd.incentive?.unavailableReason ?? null,
            obmNps: dd.npsThisMonth?.ONBOARDING ?? null,
            obmNpsLastMonth: dd.npsLastMonth?.ONBOARDING ?? null,
            dueToday: Array.isArray(dd.deadlines?.today) ? dd.deadlines.today.length : 0,
            forecast: dd.forecast ?? null,
          };
        })),
        count(''), count('&status=ACTIVE'), count('&status=ON_HOLD'), count('&status=INACTIVE'),
        api.get<{ leads: { id: string; leadId: string; name: string; assignedDesigner?: { name: string } | null }[] }>('/leads?flagged=true&limit=200'),
      ]);
      setRows(teamRows);
      setAllocation({ total, active, onHold, inactive });
      const byName = new Map<string, FlagRow>();
      for (const l of flagged.leads ?? []) {
        const name = l.assignedDesigner?.name ?? 'No designer';
        if (!byName.has(name)) byName.set(name, { name, leads: [] });
        byName.get(name)!.leads.push({ id: l.id, leadId: l.leadId, name: l.name });
      }
      setFlags([...byName.values()]);
      setError(null);
      setLastUpdated(new Date());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [designers]);

  useEffect(() => { void loadTeam(); }, [loadTeam]);
  // The team view asks for every designer's numbers, so it refreshes a little less often.
  useLiveRefresh(() => { if (!designerId) { void loadFunnel(); void loadTeam(true); } }, 20);

  const L = useDashboardLayout('blTeam').label;
  const sum = (f: (r: Row) => number) => rows.reduce((a, r) => a + f(r), 0);
  const sumCredits = (key: 'coreCredits' | 'boosterCredits') =>
    rows.some((r) => r[key] == null)
      ? rows.some((r) => r.creditUnavailableReason?.includes('pending review')) ? 'Unavailable (pending review)' : 'Unavailable'
      : sum((r) => r[key] ?? 0);
  const targets = rows.map((r) => r.bookingTarget);
  const totalTarget = targets.some((t) => t != null) ? targets.reduce<number>((a, t) => a + (t ?? 0), 0) : null;
  const achieved = sum((r) => r.bookingAchieved);
  const achievedPct = pct(achieved, totalTarget);
  const avg = (vals: (number | null)[]) => { const v = vals.filter((x): x is number => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const nps = avg(rows.map((r) => r.obmNps));
  const npsLast = avg(rows.map((r) => r.obmNpsLastMonth));
  const tier = (k: 'highIntent' | 'mediumIntent' | 'lowIntent') => ({
    count: sum((r) => r.forecast?.[k]?.count ?? 0),
    value: sum((r) => r.forecast?.[k]?.value ?? 0),
  });
  const tiers = { high: tier('highIntent'), medium: tier('mediumIntent'), low: tier('lowIntent') };
  const f = formulas().intentTiers;

  return (
    <div data-testid="bl-team-dashboard">
      <div className="px-6 pt-6 max-w-7xl mx-auto flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Dashboard</h1>
          <p className="text-sm text-stone-400 mt-0.5">
            {designerId ? 'One designer — same view the designer sees' : 'Whole team — the team picture, then one row per designer'}
          </p>
          {!designerId && (
            <p className="text-[11px] text-stone-400 mt-0.5" data-testid="bl-team-updated">
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} · updates by itself every 20 seconds and right after any change` : 'Loading…'}
              {' '}<button type="button" onClick={() => { void loadFunnel(); void loadTeam(true); }} className="text-brand-600 hover:underline">Refresh now</button>
            </p>
          )}
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

      <TileGroup dashboard="blTeam"><Tile id="blTeam.announcements"><DashboardContent /></Tile></TileGroup>

      {designerId ? (
        <DesignerDashboard key={designerId} designerId={designerId} designerName={designers.find((d) => d.id === designerId)?.name} />
      ) : (
        <>
          {/* Team key numbers */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Tile id="blTeam.booking">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-booking">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.booking', 'Booking Achievement')}</p>
                  <p className="mt-2 text-2xl font-extrabold text-stone-900">{fmt(achieved)}<span className="text-sm font-semibold text-stone-400"> / {totalTarget != null ? fmt(totalTarget) : 'no target set'}</span></p>
                  {achievedPct != null && (
                    <>
                      <div className="mt-2 h-2 rounded-full bg-stone-100 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${Math.min(100, achievedPct)}%` }} /></div>
                      <p className="mt-1 text-xs text-stone-500">{achievedPct}% achieved{totalTarget != null && totalTarget > achieved ? ` · ${fmt(totalTarget - achieved)} to target` : ''}</p>
                    </>
                  )}
                  <p className="mt-1 text-[11px] text-stone-400">Current {cycleDescription()} cycle</p>
                </div>
              </Tile>
              <Tile id="blTeam.pipeline">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-pipeline">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.pipeline', 'Active Leads (Entire Pipeline)')}</p>
                  <p className="mt-2 text-2xl font-extrabold text-stone-900">{sum((r) => r.activeLeads)} <span className="text-stone-300">|</span> {fmt(sum((r) => r.pipelineValue))}</p>
                  <p className="mt-1 text-xs text-stone-500">Active leads · pipeline value</p>
                </div>
              </Tile>
              <Tile id="blTeam.credits">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-credits">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.credits', 'Team Credits')}</p>
                  <p className="mt-2 text-2xl font-extrabold text-stone-900">{sumCredits('coreCredits')}</p>
                  <p className="mt-1 text-xs text-stone-500">Core credits earned by the team · booster {sumCredits('boosterCredits')}</p>
                </div>
              </Tile>
              <Tile id="blTeam.nps">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-nps">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.nps', 'NPS (OBM Clients)')}</p>
                  <p className="mt-2 text-2xl font-extrabold text-stone-900">{nps != null ? nps.toFixed(1) : '—'}</p>
                  <p className="mt-1 text-xs text-stone-500">
                    This month{npsLast != null && nps != null ? ` · ${nps >= npsLast ? '▲' : '▼'} ${Math.abs(nps - npsLast).toFixed(1)} vs last month` : ''}
                  </p>
                </div>
              </Tile>
            </TileGroup>
          </div>

          {/* Funnel and pipeline potential */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Tile id="blTeam.funnel">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-funnel">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.funnel', 'Sales Funnel (team)')}</p>
                  <p className="text-[11px] text-stone-400">Leads received this period, by how far they have got. Same rules as each designer's Lead Progression.</p>
                  {!funnel ? <p className="text-sm text-stone-400 py-6 text-center">Loading…</p> : (
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {funnel.map((s) => (
                        <div key={s.stage} className="rounded-xl bg-stone-50 px-3 py-2" data-testid="bl-team-funnel-stage">
                          <p className="text-[11px] font-semibold text-stone-500">{s.label}</p>
                          <p className="text-lg font-extrabold text-stone-900">{s.total}</p>
                          <p className="text-[11px] text-stone-400">{s.progressionPct != null ? `${Math.round(s.progressionPct)}% got here` : '—'}{s.avgTatDays != null ? ` · ${formatLeadProgressionTat(s.avgTatDays)}` : ''}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Tile>
              <Tile id="blTeam.potential">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-potential">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.potential', 'Pipeline Potential (PP to DIP)')}</p>
                  <p className="text-[11px] text-stone-400">Active leads expected to onboard this cycle, by intent stars.</p>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {([
                      ['High Intent', `${f.highFrom}★+`, tiers.high, 'bg-green-50 text-green-700'],
                      ['Medium Intent', `${f.mediumFrom}★`, tiers.medium, 'bg-amber-50 text-amber-700'],
                      ['Low Intent', `below ${f.mediumFrom}★`, tiers.low, 'bg-red-50 text-red-700'],
                    ] as const).map(([label, stars, t, style]) => (
                      <div key={label} className={`rounded-xl px-3 py-2 ${style}`}>
                        <p className="text-xs font-bold">{label} <span className="font-normal opacity-70">{stars}</span></p>
                        <p className="text-xs">{t.count} leads</p>
                        <p className="text-lg font-extrabold text-stone-900">{fmt(t.value)}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-stone-500">Total: {tiers.high.count + tiers.medium.count + tiers.low.count} leads · {fmt(tiers.high.value + tiers.medium.value + tiers.low.value)}</p>
                </div>
              </Tile>
            </TileGroup>
          </div>

          <TileGroup dashboard="blTeam"><Tile id="blTeam.teamTable">
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <div className={`${card} overflow-hidden`} style={cardStyle}>
              <div className="px-5 py-3" style={{ borderBottom: '1px solid #EDE8E3' }}>
                <h3 className="font-bold text-stone-900">{L('blTeam.teamTable', 'Team Performance')}</h3>
                <p className="text-xs text-stone-400 mt-0.5">
                  Active leads and pipeline value: current. PP done and onboarded: all-time. Booking, targets and designer credits: current {cycleDescription()} cycle.
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
                        {['Designer', 'Booking target', 'Booking achieved', 'Achievement', 'Onboarded', 'PP done', 'Active leads', 'Pipeline value', 'Core credits', 'Booster credits'].map((h) => (
                          <th key={h} className="px-4 py-2 font-semibold whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100">
                      {rows.map((r) => {
                        const p = pct(r.bookingAchieved, r.bookingTarget);
                        return (
                          <tr key={r.designer.id} data-testid="bl-team-row" className="hover:bg-stone-50 cursor-pointer" onClick={() => setDesignerId(r.designer.id)}>
                            <td className="px-4 py-2.5 font-medium text-stone-900">{r.designer.name}</td>
                            <td className="px-4 py-2.5">{r.bookingTarget != null ? fmt(r.bookingTarget) : '—'}</td>
                            <td className="px-4 py-2.5">{fmt(r.bookingAchieved)}</td>
                            <td className="px-4 py-2.5">{p != null ? <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${p >= 85 ? 'bg-green-50 text-green-700' : p >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{p}%</span> : '—'}</td>
                            <td className="px-4 py-2.5">{r.onboardings}</td>
                            <td className="px-4 py-2.5">{r.ppDone}</td>
                            <td className="px-4 py-2.5">{r.activeLeads}</td>
                            <td className="px-4 py-2.5">{fmt(r.pipelineValue)}</td>
                            <td className="px-4 py-2.5" title={r.creditUnavailableReason ?? undefined}>{r.coreCredits ?? (r.creditUnavailableReason?.includes('pending review') ? 'Unavailable (pending review)' : 'Unavailable')}</td>
                            <td className="px-4 py-2.5" title={r.creditUnavailableReason ?? undefined}>{r.boosterCredits ?? (r.creditUnavailableReason?.includes('pending review') ? 'Unavailable (pending review)' : 'Unavailable')}</td>
                          </tr>
                        );
                      })}
                      <tr className="bg-stone-50 font-semibold" data-testid="bl-team-total">
                        <td className="px-4 py-2.5">Team total</td>
                        <td className="px-4 py-2.5">{totalTarget != null ? fmt(totalTarget) : '—'}</td>
                        <td className="px-4 py-2.5">{fmt(achieved)}</td>
                        <td className="px-4 py-2.5">{achievedPct != null ? `${achievedPct}%` : '—'}</td>
                        <td className="px-4 py-2.5">{sum((r) => r.onboardings)}</td>
                        <td className="px-4 py-2.5">{sum((r) => r.ppDone)}</td>
                        <td className="px-4 py-2.5">{sum((r) => r.activeLeads)}</td>
                        <td className="px-4 py-2.5">{fmt(sum((r) => r.pipelineValue))}</td>
                        <td className="px-4 py-2.5">{sumCredits('coreCredits')}</td>
                        <td className="px-4 py-2.5">{sumCredits('boosterCredits')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          </Tile></TileGroup>

          {/* Allocation, flags, today's work */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Tile id="blTeam.allocation">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-allocation">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.allocation', 'Lead Allocation Summary')}</p>
                  {!allocation ? <p className="text-sm text-stone-400 py-4">Loading…</p> : (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {([
                        ['Total allocated', allocation.total, '/leads', 'bg-stone-50'],
                        ['Active', allocation.active, '/leads?status=ACTIVE', 'bg-green-50'],
                        ['On hold', allocation.onHold, '/leads?status=ON_HOLD', 'bg-amber-50'],
                        ['Inactive', allocation.inactive, '/leads?status=INACTIVE', 'bg-red-50'],
                      ] as const).map(([label, n, to, style]) => (
                        <Link key={label} to={to} className={`rounded-xl px-3 py-2 ${style} hover:shadow-sm`}>
                          <p className="text-lg font-extrabold text-stone-900">{n}</p>
                          <p className="text-[11px] text-stone-500">{label}</p>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              </Tile>
              <Tile id="blTeam.flagged">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-flagged">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.flagged', 'Flagged Leads')} {flags && <span className="text-stone-400 font-normal">({flags.reduce((a, r) => a + r.leads.length, 0)})</span>}</p>
                  {!flags ? <p className="text-sm text-stone-400 py-4">Loading…</p> : flags.length === 0 ? <p className="text-sm text-stone-400 py-4">Nothing flagged.</p> : (
                    <ul className="mt-2 space-y-1.5 text-sm">
                      {flags.map((r) => (
                        <li key={r.name}>
                          <span className="font-medium text-stone-800">{r.name}</span>{' '}
                          <span className="text-stone-500">{r.leads.slice(0, 4).map((l, i) => <span key={l.id}>{i > 0 && ', '}<Link to={`/leads/${l.id}`} className="hover:underline">{l.name}</Link></span>)}{r.leads.length > 4 ? ` +${r.leads.length - 4} more` : ''}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Link to="/leads?flagged=true" className="mt-2 inline-block text-xs text-brand-600 hover:underline">View all flagged →</Link>
                </div>
              </Tile>
              <Tile id="blTeam.dueToday">
                <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-due-today">
                  <p className="text-sm font-bold text-stone-800">{L('blTeam.dueToday', "Today's Focus (team)")} <span className="text-stone-400 font-normal">({sum((r) => r.dueToday)})</span></p>
                  <p className="text-[11px] text-stone-400">Tasks and follow-ups due today, per designer.</p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {rows.map((r) => (
                      <li key={r.designer.id} className="flex justify-between">
                        <button type="button" className="text-stone-700 hover:underline" onClick={() => setDesignerId(r.designer.id)}>{r.designer.name}</button>
                        <span className={r.dueToday > 0 ? 'font-semibold text-stone-900' : 'text-stone-300'}>{r.dueToday}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </Tile>
            </TileGroup>
          </div>
          {teamExtras}
        </>
      )}
    </div>
  );
}
