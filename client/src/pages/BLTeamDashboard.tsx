/**
 * BLTeamDashboard — the Business Lead dashboard, laid out and counted as in
 * Annie's mockup (12 Nov 2026). The figures come from one server summary
 * (GET /api/dashboard/bl-board, server lib/blBoard.ts) for the dates picked at
 * the top (default: the current target cycle). Booking target vs achieved per
 * designer stays per target cycle, from each designer's own dashboard.
 *
 * Every box can be hidden, renamed or reordered in Admin → Dashboards
 * ("Business Lead — team panel"); the rules behind Needs Attention and Today's
 * Focus are in Admin → Dashboards → BL dashboard rules. Picking a designer
 * opens that designer's full dashboard.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import DesignerDashboard from './DesignerDashboard';
import DashboardContent from '../components/dashboard/DashboardContent';
import { cycleDescription, stageLabel } from '../lib/crmSettings';
import { Tile, TileGroup, useDashboardLayout } from '../lib/dashboardLayout';
import { useLiveRefresh } from '../lib/liveRefresh';
import { DateInput } from '../components/ui/DateTimeInputs';
import { formatISTDate } from '../lib/dateFormat';
import BlCreditsPanel from '../components/reports/BlCreditsPanel';

interface Designer { id: string; name: string }
interface LeadRef { id: string; leadId: string; name: string }
interface ListItem { key: string; label: string; count: number; leads: LeadRef[] }
interface Tier { count: number; value: number }
interface Board {
  range: { from: string; to: string };
  cycle: { label: string; cycleStart: string; cycleEnd: string };
  designers: Designer[];
  activeLeads: { count: number; value: number; monthAgo: number; changePct: number | null };
  nps: { thisMonth: number | null; lastMonth: number | null; trend: { month: string; score: number | null; responses: number }[] };
  funnel: { total: number; stages: { stage: string; count: number; pctAtOrBeyond: number }[] };
  potential: { high: Tier; medium: Tier; low: Tier; tiers: { highFrom: number; mediumFrom: number } };
  team: { designer: Designer; bookingsDone: number; bookedValue: number; ppPresented: number; activeLeads: number; pipelineValue: number }[];
  bookings: (LeadRef & { value: number; bookedAt: string; cancelled: boolean; designer: string | null })[];
  allocation: { total: number; active: number; inactiveOrOnHold: number; pushbacks: number };
  attention: ListItem[];
  focus: ListItem[];
  flagged: { designer: string; items: LeadRef[] }[];
}
interface Targets { [designerId: string]: { target: number | null; achieved: number } }
interface BlCredits { totalCredits: number; core: { targetMissing: boolean } }

const fmt = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)} Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
};
const pct = (a: number, b: number | null) => (b && b > 0 ? Math.round((a / b) * 100) : null);
const card = 'bg-white rounded-2xl shadow-warm-sm';
const cardStyle = { border: '1px solid #EDE8E3' };
const FUNNEL_COLOURS = ['bg-green-50', 'bg-amber-50', 'bg-orange-50', 'bg-rose-50', 'bg-pink-50', 'bg-purple-50', 'bg-indigo-50', 'bg-sky-50'];

function Card({ testId, title, right, children, className = '' }: { testId: string; title: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`${card} p-4 h-full ${className}`} style={cardStyle} data-testid={testId}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-bold text-stone-800">{title}</p>
        {right}
      </div>
      {children}
    </div>
  );
}

/** A line of small dots for the NPS trend (months with no answers are skipped). */
function Sparkline({ points }: { points: (number | null)[] }) {
  const vals = points.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  if (vals.length < 2) return null;
  const w = 120; const h = 28; const max = 10; const min = 0;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / (max - min)) * h;
  return (
    <svg width={w} height={h} className="mt-1" aria-hidden>
      <polyline fill="none" stroke="#C2410C" strokeWidth="1.5" points={vals.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')} />
      {vals.map((p) => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="2" fill="#C2410C" />)}
    </svg>
  );
}

/** Items with a count; clicking one shows its leads. */
function ItemList({ items, empty }: { items: ListItem[]; empty: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <p className="text-sm text-stone-400 py-3">{empty}</p>;
  return (
    <ul className="mt-2 divide-y divide-stone-100 text-sm">
      {items.map((it) => (
        <li key={it.key} className="py-1.5">
          <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(open === it.key ? null : it.key)} data-testid={`item-${it.key}`}>
            <span className={`inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-xs font-bold ${it.count ? 'bg-red-50 text-red-700' : 'bg-stone-50 text-stone-400'}`}>{it.count}</span>
            <span className="flex-1 text-stone-700">{it.label}</span>
            {it.count > 0 && <span className="text-[11px] text-stone-400">{open === it.key ? 'Hide' : 'Show'}</span>}
          </button>
          {open === it.key && it.count > 0 && (
            <p className="mt-1 pl-9 text-xs text-stone-500">
              {it.leads.map((l, i) => <span key={l.id}>{i > 0 && ', '}<Link to={`/leads/${l.id}`} className="text-brand-600 hover:underline">{l.name}</Link></span>)}
              {it.count > it.leads.length ? ` +${it.count - it.leads.length} more` : ''}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

/** `blId`: a Branch Head looking at one Business Lead's team (omit for the BL's own dashboard). */
export default function BLTeamDashboard({ teamExtras, blId, title }: { teamExtras?: ReactNode; blId?: string; title?: string }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [designerId, setDesignerId] = useState('');
  const [board, setBoard] = useState<Board | null>(null);
  const [targets, setTargets] = useState<Targets>({});
  const [credits, setCredits] = useState<BlCredits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (blId) q.set('blId', blId);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    try {
      const b = await api.get<Board>(`/dashboard/bl-board?${q}`);
      setBoard(b);
      setError(null);
      setLastUpdated(new Date());
      // Booking target vs achieved is per target cycle, from each designer's own dashboard.
      const t = await Promise.all(b.designers.map(async (d) => {
        const r: any = await api.get(`/dashboard?designerId=${encodeURIComponent(d.id)}`);
        return [d.id, { target: r.designerDash?.bookingTarget ?? null, achieved: r.designerDash?.bookingAchieved ?? 0 }] as const;
      }));
      setTargets(Object.fromEntries(t));
    } catch (e: any) {
      setError(e.message);
    }
    api.get<{ result: BlCredits | null }>(`/incentive/bl-credits${blId ? `?blId=${encodeURIComponent(blId)}` : ''}`)
      .then((r) => setCredits(r.result)).catch(() => setCredits(null));
  }, [blId, from, to]);

  useEffect(() => { void load(); }, [load]);
  useLiveRefresh(() => { if (!designerId) void load(); }, 30);

  const L = useDashboardLayout('blTeam').label;
  const rows = board?.team ?? [];
  const sum = (f: (r: Board['team'][number]) => number) => rows.reduce((a, r) => a + f(r), 0);
  const totalTarget = rows.some((r) => targets[r.designer.id]?.target != null)
    ? rows.reduce((a, r) => a + (targets[r.designer.id]?.target ?? 0), 0) : null;
  const achieved = rows.reduce((a, r) => a + (targets[r.designer.id]?.achieved ?? 0), 0);
  const achievedPct = pct(achieved, totalTarget);
  const leadsLink = (q: string) => `/leads?mine=1${blId ? `&blId=${encodeURIComponent(blId)}` : ''}${q}`;
  const rangeText = board ? `${formatISTDate(board.range.from, { year: 'numeric' })} – ${formatISTDate(board.range.to, { year: 'numeric' })}` : '';
  const potentialTotal = board ? board.potential.high.count + board.potential.medium.count + board.potential.low.count : 0;
  const potentialValue = board ? board.potential.high.value + board.potential.medium.value + board.potential.low.value : 0;
  const npsDelta = board?.nps.thisMonth != null && board.nps.lastMonth != null ? Math.round((board.nps.thisMonth - board.nps.lastMonth) * 10) / 10 : null;

  return (
    <div data-testid="bl-team-dashboard">
      <div className="px-6 pt-6 max-w-7xl mx-auto flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">{title ?? 'Business Lead Dashboard'}</h1>
          <p className="text-sm text-stone-400 mt-0.5">
            {designerId ? 'One designer — same view the designer sees' : 'Drive the funnel. Enable the team. Create impact.'}
          </p>
          {!designerId && (
            <p className="text-[11px] text-stone-400 mt-0.5" data-testid="bl-team-updated">
              {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' })}` : 'Loading…'}
              {' '}<button type="button" onClick={() => { void load(); }} className="text-brand-600 hover:underline">Refresh now</button>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {!designerId && (
            <div className="text-xs text-stone-500" data-testid="bl-board-dates">
              Dates {board && !from && !to && <span className="text-stone-400">(current cycle)</span>}
              <div className="mt-1 flex items-center gap-1.5">
                <span className="w-32"><DateInput value={from} onChange={setFrom} placeholderText={board ? formatISTDate(board.range.from, { year: 'numeric' }) : 'From'} className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm" /></span>
                <span>–</span>
                <span className="w-32"><DateInput value={to} onChange={setTo} placeholderText={board ? formatISTDate(board.range.to, { year: 'numeric' }) : 'To'} className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm" /></span>
                {(from || to) && <button type="button" className="text-xs text-brand-600 hover:underline" onClick={() => { setFrom(''); setTo(''); }}>Current cycle</button>}
              </div>
            </div>
          )}
          <label className="text-xs text-stone-500">
            Designer
            <select data-testid="bl-dashboard-designer-select" className="mt-1 block rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-sm text-stone-800"
              value={designerId} onChange={(e) => setDesignerId(e.target.value)}>
              <option value="">Whole team</option>
              {(board?.designers ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div className="px-6 pt-4 max-w-7xl mx-auto">
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>
        </div>
      )}

      {designerId ? (
        <DesignerDashboard key={designerId} designerId={designerId} designerName={board?.designers.find((d) => d.id === designerId)?.name} />
      ) : !board ? (
        <p className="px-6 pt-8 text-sm text-stone-400 max-w-7xl mx-auto">Loading…</p>
      ) : (
        <>
          {/* Row 1 — key numbers */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Tile id="blTeam.booking">
                <Card testId="bl-team-booking" title={L('blTeam.booking', 'Booking Achievement')} right={achievedPct != null && <span className="text-sm font-bold text-green-700">{achievedPct}%</span>}>
                  <p className="mt-2 text-2xl font-extrabold text-stone-900">{fmt(achieved)}<span className="text-sm font-semibold text-stone-400"> / {totalTarget != null ? fmt(totalTarget) : 'no target set'}</span></p>
                  {achievedPct != null && <div className="mt-2 h-2 rounded-full bg-stone-100 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${Math.min(100, achievedPct)}%` }} /></div>}
                  <p className="mt-1 text-xs text-stone-500">{totalTarget != null && totalTarget > achieved ? `${fmt(totalTarget - achieved)} to target · ` : ''}current {cycleDescription()} cycle</p>
                </Card>
              </Tile>
              <Tile id="blTeam.pipeline">
                <Link to={leadsLink('&status=ACTIVE&excludeStages=DESIGN_IN_PROGRESS,HANDED_OVER')} className="block h-full">
                  <Card testId="bl-team-pipeline" title={L('blTeam.pipeline', 'Active Leads (Entire Pipeline)')}>
                    <p className="mt-2 text-2xl font-extrabold text-stone-900">{board.activeLeads.count} <span className="text-stone-300">|</span> {fmt(board.activeLeads.value)}</p>
                    <p className="mt-1 text-xs text-stone-500">
                      Active leads · pipeline value
                      {board.activeLeads.changePct != null && (
                        <span className={`ml-2 font-semibold ${board.activeLeads.changePct >= 0 ? 'text-green-700' : 'text-red-600'}`} data-testid="bl-active-change">
                          {board.activeLeads.changePct >= 0 ? '▲' : '▼'} {Math.abs(board.activeLeads.changePct)}% vs last month
                        </span>
                      )}
                    </p>
                  </Card>
                </Link>
              </Tile>
              <Tile id="blTeam.credits">
                <Card testId="bl-team-credits" title={L('blTeam.credits', 'BL Credits')} right={credits && !credits.core.targetMissing && <span className="text-sm font-bold text-green-700">{Math.round(credits.totalCredits)}%</span>}>
                  {!credits ? <p className="mt-2 text-sm text-stone-400">—</p> : credits.core.targetMissing ? (
                    <p className="mt-2 text-sm text-stone-500">No BL booking target set for this cycle (Admin → Sales Performance Targets).</p>
                  ) : (
                    <>
                      <p className="mt-2 text-2xl font-extrabold text-stone-900">{Math.round(credits.totalCredits)} <span className="text-sm font-semibold text-stone-400">/ 100</span></p>
                      <div className="mt-2 h-2 rounded-full bg-stone-100 overflow-hidden"><div className="h-full bg-brand-500" style={{ width: `${Math.min(100, credits.totalCredits)}%` }} /></div>
                      <p className="mt-1 text-xs text-stone-500">{credits.totalCredits < 100 ? `${Math.ceil(100 - credits.totalCredits)} credits remaining to reach 100` : '100 reached'} · this cycle</p>
                    </>
                  )}
                </Card>
              </Tile>
              <Tile id="blTeam.nps">
                <Card testId="bl-team-nps" title={L('blTeam.nps', 'NPS (OBM Clients)')}>
                  <div className="mt-2 flex items-end gap-3">
                    <p className="text-2xl font-extrabold text-stone-900">{board.nps.thisMonth != null ? board.nps.thisMonth.toFixed(1) : '—'}</p>
                    {npsDelta != null && <p className={`text-xs font-semibold ${npsDelta >= 0 ? 'text-green-700' : 'text-red-600'}`}>{npsDelta >= 0 ? '▲' : '▼'} {Math.abs(npsDelta).toFixed(1)} vs last month</p>}
                  </div>
                  <Sparkline points={board.nps.trend.map((t) => t.score)} />
                  <p className="text-[11px] text-stone-400">This month · from onboarding (OBM) clients only{board.nps.trend.length ? ` · ${board.nps.trend[0].month}–${board.nps.trend[board.nps.trend.length - 1].month}` : ''}</p>
                </Card>
              </Tile>
            </TileGroup>
          </div>

          {/* Row 2 — funnel and potential */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Tile id="blTeam.funnel">
                <Card testId="bl-team-funnel" title={<>{L('blTeam.funnel', 'Sales Funnel (Active Leads)')}</>} right={<span className="text-xs text-stone-500">Total active leads: <b>{board.funnel.total}</b></span>}>
                  <div className="mt-3 grid grid-cols-4 gap-1.5">
                    {board.funnel.stages.map((s, i) => (
                      <Link key={s.stage} to={leadsLink(`&status=ACTIVE&stage=${s.stage}`)} className={`rounded-lg px-2 py-2 text-center ${FUNNEL_COLOURS[i]} hover:shadow-sm`} data-testid="bl-team-funnel-stage">
                        <p className="text-[11px] font-bold text-stone-600 truncate">{stageLabel(s.stage)}</p>
                        <p className="text-lg font-extrabold text-stone-900">{s.count}</p>
                        <p className="text-[10px] text-stone-500">{s.pctAtOrBeyond}% {i === 0 ? 'of active leads' : 'here or beyond'}</p>
                      </Link>
                    ))}
                  </div>
                </Card>
              </Tile>
              <Tile id="blTeam.potential">
                <Card testId="bl-team-potential" title={L('blTeam.potential', 'Pipeline Potential (Based on PP to DIP)')} right={<span className="text-xs text-stone-500">Total: <b>{potentialTotal} leads | {fmt(potentialValue)}</b></span>}>
                  <div className="mt-3 grid grid-cols-3 gap-2">
                    {([
                      ['High Intent', `${board.potential.tiers.highFrom}★+`, board.potential.high, 'bg-green-50 text-green-700'],
                      ['Medium Intent', `${board.potential.tiers.mediumFrom}★`, board.potential.medium, 'bg-amber-50 text-amber-700'],
                      ['Low Intent', `below ${board.potential.tiers.mediumFrom}★`, board.potential.low, 'bg-red-50 text-red-700'],
                    ] as const).map(([label, stars, t, style]) => (
                      <div key={label} className={`rounded-xl px-3 py-2 ${style}`}>
                        <p className="text-xs font-bold">{label} <span className="font-normal opacity-70">{stars}</span></p>
                        <p className="text-xs">{t.count} leads</p>
                        <p className="text-lg font-extrabold text-stone-900">{fmt(t.value)}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-stone-400">Active leads at PP, PD, OB and OBM. Star levels: Admin → Formulas.</p>
                  <Link to="/pipeline" className="mt-1 inline-block text-xs font-semibold text-brand-600 hover:underline">View detailed pipeline →</Link>
                </Card>
              </Tile>
            </TileGroup>
          </div>

          {/* Row 3 — team performance and allocation */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Tile id="blTeam.teamTable">
                <div className={`${card} overflow-hidden lg:col-span-2 h-full`} style={cardStyle} data-testid="bl-team-table">
                  <div className="px-5 py-3 flex justify-between gap-2" style={{ borderBottom: '1px solid #EDE8E3' }}>
                    <h3 className="font-bold text-stone-900">{L('blTeam.teamTable', 'Team Performance (Bookings)')}</h3>
                    <span className="text-xs text-stone-400">{rangeText}</span>
                  </div>
                  {rows.length === 0 ? (
                    <p className="text-sm text-stone-400 text-center py-8" data-testid="bl-team-empty">No designers are assigned to you yet.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[11px] uppercase tracking-wide text-stone-400">
                            {['Designer', 'Booking target', 'Booking achieved', 'Achievement', 'Bookings done', 'PP presented', 'Active leads', 'Pipeline value'].map((h) => (
                              <th key={h} className="px-3 py-2 font-semibold whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-100">
                          {rows.map((r) => {
                            const t = targets[r.designer.id];
                            const p = t ? pct(t.achieved, t.target) : null;
                            return (
                              <tr key={r.designer.id} data-testid="bl-team-row" className="hover:bg-stone-50 cursor-pointer" onClick={() => setDesignerId(r.designer.id)}>
                                <td className="px-3 py-2 font-medium text-stone-900">{r.designer.name}</td>
                                <td className="px-3 py-2">{t?.target != null ? fmt(t.target) : '—'}</td>
                                <td className="px-3 py-2">{t ? fmt(t.achieved) : '—'}</td>
                                <td className="px-3 py-2">{p != null ? <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${p >= 90 ? 'bg-green-50 text-green-700' : p >= 50 ? 'bg-amber-50 text-amber-700' : 'bg-red-50 text-red-700'}`}>{p}%</span> : '—'}</td>
                                <td className="px-3 py-2">{r.bookingsDone}</td>
                                <td className="px-3 py-2">{r.ppPresented}</td>
                                <td className="px-3 py-2">{r.activeLeads}</td>
                                <td className="px-3 py-2">{fmt(r.pipelineValue)}</td>
                              </tr>
                            );
                          })}
                          <tr className="bg-stone-50 font-semibold" data-testid="bl-team-total">
                            <td className="px-3 py-2">Total</td>
                            <td className="px-3 py-2">{totalTarget != null ? fmt(totalTarget) : '—'}</td>
                            <td className="px-3 py-2">{fmt(achieved)}</td>
                            <td className="px-3 py-2">{achievedPct != null ? `${achievedPct}%` : '—'}</td>
                            <td className="px-3 py-2">{sum((r) => r.bookingsDone)}</td>
                            <td className="px-3 py-2">{sum((r) => r.ppPresented)}</td>
                            <td className="px-3 py-2">{sum((r) => r.activeLeads)}</td>
                            <td className="px-3 py-2">{fmt(sum((r) => r.pipelineValue))}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="px-5 py-2 text-[11px] text-stone-400">Target and achieved: current {cycleDescription()} cycle. Bookings done and PP presented: the dates picked above. Click a designer to open their dashboard.</p>
                </div>
              </Tile>
              <Tile id="blTeam.allocation">
                <Card testId="bl-team-allocation" title={L('blTeam.allocation', 'Lead Allocation Summary')} right={<span className="text-[11px] text-stone-400">{rangeText}</span>}>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {([
                      ['Total allocated', board.allocation.total, 'bg-stone-50'],
                      ['Active (in funnel)', board.allocation.active, 'bg-green-50'],
                      ['Inactive / On hold', board.allocation.inactiveOrOnHold, 'bg-stone-100'],
                      ['Pushbacks', board.allocation.pushbacks, 'bg-red-50'],
                    ] as const).map(([label, n, style]) => (
                      <div key={label} className={`rounded-xl px-3 py-2 ${style}`}>
                        <p className="text-lg font-extrabold text-stone-900">{n}</p>
                        <p className="text-[11px] text-stone-500">{label}</p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-stone-400">Leads received in these dates, by where they are now. Pushbacks: MQLs sent back to the CRE.</p>
                </Card>
              </Tile>
            </TileGroup>
          </div>

          {/* Row 4 — needs attention and today's focus */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Tile id="blTeam.attention">
                <Card testId="bl-team-attention" title={<>{L('blTeam.attention', 'Needs Attention')} <span className="ml-1 rounded-full bg-red-50 px-2 text-xs text-red-700">{board.attention.reduce((a, i) => a + i.count, 0)}</span></>}>
                  <ItemList items={board.attention} empty="Nothing needs attention." />
                  <p className="mt-1 text-[11px] text-stone-400">What counts here: Admin → Dashboards → BL dashboard rules.</p>
                </Card>
              </Tile>
              <Tile id="blTeam.dueToday">
                <Card testId="bl-team-focus" title={<>{L('blTeam.dueToday', "Today's Focus")} <span className="ml-1 rounded-full bg-amber-50 px-2 text-xs text-amber-700">{board.focus.reduce((a, i) => a + i.count, 0)}</span></>}>
                  <ItemList items={board.focus} empty="Nothing for today." />
                </Card>
              </Tile>
            </TileGroup>
          </div>

          {/* Row 5 — flagged, bookings done, announcements */}
          <div className="px-6 pt-4 max-w-7xl mx-auto">
            <TileGroup dashboard="blTeam" className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <Tile id="blTeam.flagged">
                <Card testId="bl-team-flagged" title={<>{L('blTeam.flagged', 'Flagged Projects')} <span className="text-stone-400 font-normal">({board.flagged.reduce((a, r) => a + r.items.length, 0)})</span></>}
                  right={<Link to="/leads?flagged=true" className="text-xs text-brand-600 hover:underline">View all →</Link>}>
                  {board.flagged.length === 0 ? <p className="text-sm text-stone-400 py-3">Nothing flagged.</p> : (
                    <table className="mt-2 w-full text-sm">
                      <thead><tr className="text-left text-[11px] uppercase tracking-wide text-stone-400"><th className="py-1">Designer</th><th className="py-1">No.</th><th className="py-1">Names</th></tr></thead>
                      <tbody className="divide-y divide-stone-100">
                        {board.flagged.map((r) => (
                          <tr key={r.designer}>
                            <td className="py-1.5 pr-2 font-medium text-stone-800">{r.designer}</td>
                            <td className="py-1.5 pr-2">{r.items.length}</td>
                            <td className="py-1.5 text-stone-500">{r.items.slice(0, 3).map((l, i) => <span key={l.id}>{i > 0 && ', '}<Link to={`/leads/${l.id}`} className="hover:underline">{l.name}</Link></span>)}{r.items.length > 3 ? ` +${r.items.length - 3}` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </Card>
              </Tile>
              <Tile id="blTeam.bookingsDone">
                <Card testId="bl-team-bookings" title={<>{L('blTeam.bookingsDone', 'Bookings Done')} <span className="text-stone-400 font-normal">({board.bookings.filter((b) => !b.cancelled).length})</span></>} right={<span className="text-[11px] text-stone-400">{rangeText}</span>}>
                  {board.bookings.length === 0 ? <p className="text-sm text-stone-400 py-3">No bookings in these dates.</p> : (
                    <table className="mt-2 w-full text-sm">
                      <thead><tr className="text-left text-[11px] uppercase tracking-wide text-stone-400"><th className="py-1">Client</th><th className="py-1">Value</th><th className="py-1">Booked on</th></tr></thead>
                      <tbody className="divide-y divide-stone-100">
                        {board.bookings.slice(0, 8).map((b) => (
                          <tr key={b.id} className={b.cancelled ? 'text-stone-400 line-through' : ''}>
                            <td className="py-1.5 pr-2"><Link to={`/leads/${b.id}`} className="hover:underline">{b.name}</Link></td>
                            <td className="py-1.5 pr-2">{fmt(b.value)}</td>
                            <td className="py-1.5">{formatISTDate(b.bookedAt, { year: 'numeric' })}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {board.bookings.length > 8 && <p className="mt-1 text-[11px] text-stone-400">+{board.bookings.length - 8} more</p>}
                </Card>
              </Tile>
              <Tile id="blTeam.announcements">
                <div className={`${card} p-4 h-full`} style={cardStyle}><DashboardContent embedded title={L('blTeam.announcements', 'Announcements & Inspiration Board')} /></div>
              </Tile>
            </TileGroup>
          </div>

          {/* The Business Lead's own credits in detail (Branch Head sees the BL they opened) */}
          <TileGroup dashboard="blTeam"><Tile id="blTeam.blCredits">
            <div className="px-6 pt-4 max-w-7xl mx-auto">
              <div className={`${card} p-4`} style={cardStyle} data-testid="bl-team-bl-credits">
                <p className="mb-3 text-sm font-bold text-stone-800">{L('blTeam.blCredits', 'Business Lead Credits (details)')}</p>
                <BlCreditsPanel blId={blId} />
              </div>
            </div>
          </Tile></TileGroup>
          {teamExtras}
        </>
      )}
    </div>
  );
}
