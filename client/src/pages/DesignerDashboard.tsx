/**
 * DesignerDashboard — comprehensive role-specific dashboard for DESIGNER / CRE.
 * Renders the full layout from the mockup: KPI row, sales funnel, design progress,
 * performance score, NPS analytics, incentive overview, leaderboard, attention items,
 * notifications, client health, and month-end forecast.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useLiveRefresh } from '../lib/liveRefresh';
import { getStoredUser } from '../lib/auth';
import { DateInput } from '../components/ui/DateTimeInputs';
import DashboardContent from '../components/dashboard/DashboardContent';
import { formatLeadProgressionTat, type LeadProgressionRow } from '../lib/leadProgression';
import {
  TrendingUp, TrendingDown, Minus, Calendar, Star, Bell,
  AlertTriangle, Target, RefreshCw, ChevronRight, FileText, BarChart3, Heart,
} from 'lucide-react';
import { cycleDescription, crmSettings, stageShortLabel } from '../lib/crmSettings';
import { Tile, TileGroup, useDashboardLayout } from '../lib/dashboardLayout';
import { formulas } from '../lib/formulas';

// ── Formatters ────────────────────────────────────────────────────────────────
const fmt = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n > 0) return `₹${n.toLocaleString('en-IN')}`;
  return '₹0';
};

// ── Types ─────────────────────────────────────────────────────────────────────
interface DesignerDash {
  activeProjects: { total: number; onTrack: number; atRisk: number; delayed: number };
  bookingAchieved: number;
  bookingTarget: number | null;
  poAchieved: number;
  poTarget: number | null;
  targetCycle?: { cycleStart: string; cycleEnd: string; label: string };
  incentive: {
    walletBalance: number;
    projectedEarnings: number;
    coreCreditsEarned: number | null;
    calculationAvailable?: boolean;
    unavailableReason?: string | null;
    coreCreditsTotal: number;
    boosterCredits: number | null;
    totalCredits: number | null;
    tier: string;
    nextMilestoneCredits: number;
    nextMilestoneBooking: number;
    furnitureIncentive: number;
    portfolioIncentive: number;
    potentialEarnings: number;
  };
  npsThisMonth: { SALE: number | null; ONBOARDING: number | null; DESIGN_FREEZE: number | null; SIGN_OFF: number | null };
  npsLastMonth: { SALE: number | null; ONBOARDING: number | null; DESIGN_FREEZE: number | null; SIGN_OFF: number | null };
  npsTrend: Array<{ month: string; SALE: number | null; DESIGN_FREEZE: number | null; SIGN_OFF: number | null }>;
  designProgress: Array<{ phase: string; label: string; count: number }>;
  deadlines: { today: number; tomorrow: number; thisWeek: number; nextWeek: number };
  leaderboard: Array<{ userId: string; name: string; bookingValue: number; npsAvg: number | null; rank: number; isCurrentUser: boolean }>;
  clientHealth: {
    leads: Array<{ id: string; clientName: string; leadId: string; leadDbId: string; stage: string; health: string; attentionCount: number }>;
    projects: Array<{ id: string; projectCode: string; clientName: string; leadId: string; leadDbId: string; health: string; attentionCount: number }>;
  };
  forecast: {
    from: string;
    to: string;
    highIntent: { count: number; value: number };
    mediumIntent: { count: number; value: number };
    lowIntent: { count: number; value: number };
  };
  attentionItems: Array<{ projectId: string; projectCode: string; clientName: string; leadId: string; category: string; description: string; daysOverdue: number }>;
  recentNotifications: Array<{ id: string; type: string; message: string; leadId: string | null; isRead: boolean; createdAt: string; lead?: { id: string; leadId: string; name: string } | null }>;
  stageFunnelValues: Record<string, number>;
  overallScore: {
    overall: number | null;
    components: Array<{ name: string; actual: number | null; target: number | null; score: number | null }>;
    averageTatDays: number | null;
    averageNps: number | null;
  };
}

interface DashData {
  totalLeads: number;
  personalStats: {
    activeLeads: number;
    ppDone: number;
    ppTotalValue: number;
    ppAverageValue: number;
    onboardings: number;
    targetVsAchieved: { target: number | null; achieved: number };
  };
  avgNPS: number | null;
  stageFunnel: Array<{ stage: string; count: number }>;
  slaBreaches: { activeCount: number; list: any[] };
  needsAttention?: Array<{ projectId: string; projectCode: string; clientName: string; leadId: string; category: string; description: string; daysOverdue: number }>;
  designerDash?: DesignerDash;
  medal?: { role: string; cycle: { label: string }; score: number | null; medal: 'GOLD' | 'SILVER' | 'BRONZE' | null; salesPct?: number | null; designDipPct?: number | null; dipActual?: number; dipTarget?: number | null };
  dateRange: { from: string; to: string };
}

interface WorkItem {
  id: string; type: 'TASK' | 'MEETING' | 'SLA_BREACH'; dueAt: string;
  title: string; subtitle?: string; leadId: string; leadDisplayId: string; leadName: string;
}

// ── Palette ───────────────────────────────────────────────────────────────────
const BRAND = '#d95f32';
const CARD_BORDER = '1px solid #EDE8E3';
const ACCENT_BG = '#FEF0E8';

// ── Work-item date-bucket helpers ─────────────────────────────────────────────
const WI_BUCKETS = [
  { key: 'overdue'   as const, label: 'Overdue',    color: 'text-red-600' },
  { key: 'today'     as const, label: 'Today',      color: 'text-brand-600' },
  { key: 'tomorrow'  as const, label: 'Tomorrow',   color: 'text-amber-600' },
  { key: 'this_week' as const, label: 'This Week',  color: 'text-stone-600' },
  { key: 'later'     as const, label: 'Later',      color: 'text-stone-400' },
];
const IST_MS = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
function istDay(d: Date): string { return new Date(d.getTime() + IST_MS).toISOString().slice(0, 10); }
function addIstDays(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
function currentWorkWeekEnd(todayKey: string): string {
  const today = new Date(`${todayKey}T00:00:00Z`);
  const daysSinceMonday = (today.getUTCDay() + 6) % 7;
  const mondayKey = addIstDays(todayKey, -daysSinceMonday);
  return addIstDays(mondayKey, 6);
}
function wiBucket(dueAt: string): typeof WI_BUCKETS[number]['key'] {
  const t = new Date(dueAt);
  if (t.getTime() <= 0) return 'overdue'; // SLA sentinel (epoch)
  const now = new Date();
  const item = istDay(t);
  const today = istDay(now);
  if (item < today) return 'overdue';
  if (item === today) return 'today';
  if (item === addIstDays(today, 1)) return 'tomorrow';
  if (item >= today && item <= currentWorkWeekEnd(today)) return 'this_week';
  return 'later';
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────
function Panel({ children, className = '', style, to, drillLabel = 'View details', showDrillLabel = true }: {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  to?: string;
  drillLabel?: string;
  showDrillLabel?: boolean;
}) {
  const panelClassName = `bg-white rounded-2xl shadow-warm-sm ${className} ${to ? 'block cursor-pointer transition-transform hover:-translate-y-0.5 hover:shadow-warm' : ''}`;
  const content = (
    <>
      {children}
      {to && showDrillLabel && (
        <p className="mt-2 flex items-center gap-0.5 text-[11px] font-semibold text-brand-600">
          {drillLabel} <ChevronRight size={12} />
        </p>
      )}
    </>
  );

  return to
    ? <Link to={to} className={panelClassName} style={{ border: CARD_BORDER, ...style }}>{content}</Link>
    : <div className={panelClassName} style={{ border: CARD_BORDER, ...style }}>{content}</div>;
}

function PanelHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: CARD_BORDER }}>
      <h3 className="font-bold text-stone-900 tracking-tight">{title}</h3>
      {action}
    </div>
  );
}

function DeltaBadge({ current, prev }: { current: number | null; prev: number | null }) {
  if (current == null) return <span className="text-stone-300 text-xs">—</span>;
  if (prev == null) return null;
  const delta = +(current - prev).toFixed(1);
  if (delta === 0) return <span className="text-stone-400 text-xs flex items-center gap-0.5"><Minus size={10} />0</span>;
  return delta > 0
    ? <span className="text-green-600 text-xs flex items-center gap-0.5"><TrendingUp size={10} />+{delta}</span>
    : <span className="text-red-500 text-xs flex items-center gap-0.5"><TrendingDown size={10} />{delta}</span>;
}

function MetricRing({ value, progress, color = '#4caf50' }: {
  value: React.ReactNode;
  progress?: number | null;
  color?: string;
}) {
  const ringStyle = progress == null
    ? { border: '10px solid #E5E7EB' }
    : { background: `conic-gradient(${color} ${Math.min(Math.max(progress, 0), 100)}%, #E5E7EB 0)` };
  return (
    <div className="relative h-[76px] w-[76px] rounded-full" style={ringStyle}>
      <div className="absolute inset-[10px] flex flex-col items-center justify-center rounded-full bg-white">
        <p className="text-xl font-extrabold leading-none text-stone-900">{value}</p>
        {progress != null && <p className="mt-0.5 text-[10px] text-stone-500">Actual + Target</p>}
        {progress == null && <p className="mt-0.5 text-[10px] text-stone-500">days</p>}
      </div>
    </div>
  );
}


function fmtBookingValue(value: number) {
  if (value >= 10000000) return `₹${(value / 10000000).toFixed(2).replace(/\.00$/, '')}Cr`;
  if (value >= 100000) return `₹${(value / 100000).toFixed(1).replace(/\.0$/, '')}L`;
  return fmt(value);
}

const NOTIF_ICON: Record<string, string> = {
  NPS_SUBMITTED: '⭐',
  BL_ASSIGNED: '👤',
  DISCOUNT_REQUEST: '💸',
  MEETING_NO_SHOW: '❌',
  SLA_BREACH: '⚠️',
  OVERDUE_TASK: '⏰',
  RNR_ESCALATION: '📞',
};

// ── Main component ────────────────────────────────────────────────────────────
// `designerId` (BL / Branch Head only): show this designer's dashboard instead of
// the signed-in user's. Personal-only panels (own tasks, own client-health list)
// are not shown in that mode because they belong to the signed-in user.
export default function DesignerDashboard({ designerId, designerName }: { designerId?: string; designerName?: string } = {}) {
  const L = useDashboardLayout('designer').label;
  // Viewing a designer's dashboard: number links open that designer's leads, not the viewer's whole team.
  const leadsScope = designerId ? `designerId=${encodeURIComponent(designerId)}&` : '';
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [funnelRows, setFunnelRows] = useState<LeadProgressionRow[] | null>(null);
  const [funnelError, setFunnelError] = useState<string | null>(null);
  const funnelRequest = useRef(0);
  const user = getStoredUser();

  const loadFunnel = useCallback(async () => {
    const request = ++funnelRequest.current;
    try {
      const result = await api.get<{ data: { stages: LeadProgressionRow[]; progressionStages?: LeadProgressionRow[] } }>(
        `/designer-reports/my-lead-funnel${designerId ? `?designerId=${encodeURIComponent(designerId)}` : ''}`,
      );
      if (request !== funnelRequest.current) return;
      setFunnelRows(result.data.progressionStages ?? result.data.stages);
      setFunnelError(null);
    } catch {
      if (request !== funnelRequest.current) return;
      setFunnelRows(null);
      setFunnelError('Lead progression could not be loaded. Please retry.');
    }
  }, [designerId]);

  const load = useCallback(async (from?: string, to?: string, background = false) => {
    // Background polling must not replace the dashboard with skeleton cards.
    // Keep the existing data visible while the fresh response is in flight;
    // explicit date-range changes still use the initial loading state.
    if (!background) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      if (designerId) params.set('designerId', designerId);
      const url = `/dashboard${params.toString() ? `?${params}` : ''}`;
      await Promise.all([
        api.get<DashData>(url).then(setData),
        loadFunnel(),
      ]);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [designerId, loadFunnel]);

  useEffect(() => { setFunnelRows(null); load(); }, [load]);

  // Work-items: separate lightweight fetch for Today's Focus — independent of
  // the date-range the main dashboard is filtered to, so it always shows real
  // upcoming items rather than date-windowed summary counts.
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [workItemsLoading, setWorkItemsLoading] = useState(true);
  const loadWorkItems = useCallback(async () => {
    if (designerId) { setWorkItems([]); setWorkItemsLoading(false); return; }
    setWorkItemsLoading(true);
    try {
      const res = await api.get<{ items: WorkItem[] }>('/dashboard/work-items');
      setWorkItems(res.items ?? []);
    } catch { /* non-critical — panel stays empty on error */ }
    finally { setWorkItemsLoading(false); }
  }, [designerId]);
  useEffect(() => { loadWorkItems(); }, [loadWorkItems]);

  // Keep dashboard numbers live without a manual reload: re-poll periodically
  // and whenever the tab regains focus/visibility, respecting whatever date
  // range is currently applied (via refs so the interval doesn't need to be
  // torn down/rebuilt every time the user edits the date inputs).
  const dateFromRef = useRef(dateFrom);
  const dateToRef = useRef(dateTo);
  useEffect(() => { dateFromRef.current = dateFrom; dateToRef.current = dateTo; }, [dateFrom, dateTo]);

  useLiveRefresh(() => { void load(dateFromRef.current || undefined, dateToRef.current || undefined, true); void loadWorkItems(); });

  const handleApply = () => load(dateFrom || undefined, dateTo || undefined);
  const handleReset = () => { setDateFrom(''); setDateTo(''); load(); };

  const [healthCounts, setHealthCounts] = useState<{ total: number; healthy: number; atRisk: number; critical: number } | null>(null);
  const [contactCounts, setContactCounts] = useState<{ recent: number; warning: number; highRisk: number; unknown: number } | null>(null);
  useEffect(() => {
    if (designerId) { setHealthCounts(null); setContactCounts(null); return; }
    api.get<{ counts: { total: number; healthy: number; atRisk: number; critical: number }; contactCounts?: { recent: number; warning: number; highRisk: number; unknown: number } }>('/client-health')
      .then((r) => { setHealthCounts(r.counts); setContactCounts(r.contactCounts ?? null); })
      .catch(() => { setHealthCounts(null); setContactCounts(null); });
  }, [designerId]);

  const dd = data?.designerDash;
  const medal = data?.medal;

  const incentiveCreditsEarned = dd?.incentive.totalCredits;
  const bookingPct = dd?.bookingTarget
    ? Math.min(Math.round((dd.bookingAchieved / dd.bookingTarget) * 100), 100)
    : 0;
  const pipelinePotentialValue = dd?.forecast
    ? dd.forecast.highIntent.value + dd.forecast.mediumIntent.value + dd.forecast.lowIntent.value
    : 0;
  const pipelinePotentialCount = dd?.forecast
    ? dd.forecast.highIntent.count + dd.forecast.mediumIntent.count + dd.forecast.lowIntent.count
    : 0;
  const conversionPct = dd?.overallScore.components.find(
    (component) => component.name === 'Conversion %',
  )?.actual ?? null;
  const designNps = dd?.npsThisMonth.ONBOARDING ?? dd?.overallScore.averageNps ?? null;
  const previousDesignNps = dd?.npsLastMonth.ONBOARDING ?? null;
  // Do not substitute capped SLA/project-health counts for information completeness.
  const fallbackCounts = {
    total: '—', healthy: '—', atRisk: '—', critical: '—',
  };
  const clientHealthCounts = healthCounts ?? fallbackCounts;

  return (
    <div className="px-4 sm:px-6 py-6 max-w-7xl mx-auto space-y-6" data-testid="designer-dashboard" data-designer-scope={designerId ?? 'self'}>

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">{designerId ? `${designerName ?? 'Designer'}'s Dashboard` : 'My Dashboard'}</h1>
          <p className="text-sm text-stone-400 mt-0.5">{designerId ? `${designerName ?? ''} · Designer (viewed by ${user?.name ?? ''})` : `${user?.name ?? ''} · Designer`}</p>
        </div>
        {/* Date-range filter */}
        <div className="flex items-center flex-wrap gap-2">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-stone-500 font-medium">From</label>
            <DateInput
              value={dateFrom} onChange={setDateFrom}
              className="border border-stone-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-stone-500 font-medium">To</label>
            <DateInput
              value={dateTo} onChange={setDateTo}
              className="border border-stone-200 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>
          <button onClick={handleApply} className="px-3 py-1.5 text-sm font-medium text-white rounded-lg" style={{ background: BRAND }}>
            Apply
          </button>
          {(dateFrom || dateTo) && (
            <button onClick={handleReset} className="px-3 py-1.5 text-sm text-stone-500 hover:text-stone-700 underline">
              Reset
            </button>
          )}
          <button onClick={() => load(dateFrom || undefined, dateTo || undefined)} className="p-1.5 rounded-lg hover:bg-stone-100 text-stone-400" title="Refresh">
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      {/* BL's selected-designer view already has the shared feed in its parent. */}
      {!designerId && <TileGroup dashboard="designer"><Tile id="designer.announcements"><DashboardContent embedded title={L('designer.announcements', 'Announcements and inspiration')} /></Tile></TileGroup>}

      {loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            {[1,2,3,4,5,6].map((i) => <div key={i} className="h-28 rounded-2xl animate-pulse" style={{ background: '#EDE8E3' }} />)}
          </div>
          <div className="h-48 rounded-2xl animate-pulse" style={{ background: '#EDE8E3' }} />
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>}

      {data && !loading && (
        <TileGroup dashboard="designer" className="space-y-6">
          {/* ── Row 1: KPI cards ── */}
          <TileGroup dashboard="designer" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 items-start gap-4">

            <Tile id="designer.activeLeads">
            <Panel className="p-4" to={`/leads?${leadsScope}mine=1&status=ACTIVE&excludeStages=DESIGN_IN_PROGRESS,HANDED_OVER`} drillLabel="View active leads">
              <p className="text-2xl font-extrabold text-stone-900">{data.personalStats.activeLeads}</p>
              <p className="text-sm font-semibold text-stone-700 mt-1">{L('designer.activeLeads', 'Active Leads')}</p>
              <p className="text-xs text-stone-400 mt-1">Current sales pipeline</p>
            </Panel>
            </Tile>

            <Tile id="designer.ppDone">
            <Panel className="p-4" to="/meetings" showDrillLabel={false}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 shadow-sm">
                    <FileText size={21} strokeWidth={2.2} className="text-white" />
                  </span>
                <p className="text-base font-bold text-stone-900">{L('designer.ppDone', 'PP Done')}</p>
                <p className="text-xs text-stone-400">All-time · unique leads with completed PP meetings</p>
                </div>
                <ChevronRight size={19} strokeWidth={2.5} className="text-stone-900" />
              </div>

              <div className="mt-4 flex items-baseline gap-3">
                <p className="text-3xl font-extrabold leading-none text-stone-900">{data.personalStats.ppDone}</p>
                <p className="text-xl font-bold text-stone-600">Proposals Presented</p>
              </div>

              <div className="mt-4 grid grid-cols-2 rounded-xl bg-violet-50/80 px-4 py-3">
                <div className="pr-4">
                  <p className="text-sm text-stone-600">Total PP Value</p>
                  <p className="mt-0.5 text-2xl font-extrabold leading-none text-stone-900">
                    {fmtBookingValue(data.personalStats.ppTotalValue)}
                  </p>
                </div>
                <div className="border-l border-violet-200 pl-4">
                  <p className="text-sm text-stone-600">Avg. Value per PP</p>
                  <p className="mt-0.5 text-2xl font-extrabold leading-none text-stone-900">
                    {fmtBookingValue(data.personalStats.ppAverageValue)}
                  </p>
                </div>
              </div>
            </Panel>
            </Tile>

            <Tile id="designer.bookingDone">
            <Panel className="p-4" to={`/leads?${leadsScope}mine=1&stage=DESIGN_IN_PROGRESS`} showDrillLabel={false} style={{ background: '#FFFFFF', border: '1px solid #E8E4DF' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <BarChart3 size={29} strokeWidth={2.5} className="text-brand-600" />
                  <p className="text-base font-bold text-stone-900">{L('designer.bookingDone', 'Booking Done')}</p>
                </div>
                <ChevronRight size={19} strokeWidth={2.5} className="text-stone-900" />
              </div>
              {dd?.bookingTarget ? (
                <>
                  <div className="mt-4 flex items-end justify-between gap-3">
                    <p className="text-3xl font-extrabold leading-none tracking-tight text-stone-900">
                      {fmtBookingValue(dd.bookingAchieved)}
                      <span className="text-xl font-bold text-stone-500"> / {fmtBookingValue(dd.bookingTarget)}</span>
                    </p>
                    <div className="text-right leading-none">
                      <p className="text-2xl font-extrabold text-green-600">{bookingPct}%</p>
                      <p className="mt-1 text-sm text-green-700">Achieved</p>
                    </div>
                  </div>
                  <div className="mt-4 h-4 w-full overflow-hidden rounded-full bg-stone-200">
                    <div
                      className="h-full rounded-full bg-brand-500 transition-all"
                      style={{ width: `${bookingPct}%` }}
                    />
                  </div>
                  <p className="mt-3 text-base text-stone-500">
                    {fmtBookingValue(Math.max(dd.bookingTarget - dd.bookingAchieved, 0))} to target
                  </p>
                </>
              ) : (
                <p className="mt-5 text-sm text-stone-500">No target set for this cycle</p>
              )}
            </Panel>
            </Tile>

            <Tile id="designer.creditsEarned">
            <Panel
              to="/reports"
              drillLabel="View incentive report"
              className="p-4"
              style={{ background: '#FFFFFF', border: '1px solid #E8E4DF' }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Star size={31} strokeWidth={1.8} fill="currentColor" className="text-brand-600" />
                  <p className="text-base font-bold text-stone-900">{L('designer.creditsEarned', 'Credits Earned')}</p>
                </div>
                <ChevronRight size={19} strokeWidth={2.5} className="text-stone-900" />
              </div>
              <p data-testid="dashboard-earned-credits" className="mt-5 text-4xl font-extrabold leading-none tracking-tight text-stone-900">
                {incentiveCreditsEarned ?? 'Unavailable'}
              </p>
              <p className="mt-2 text-sm text-stone-500">
                {dd?.incentive.calculationAvailable === false
                  ? dd.incentive.unavailableReason
                  : <>
                      <span data-testid="dashboard-core-credits">{dd?.incentive.coreCreditsEarned ?? 'Unavailable'}</span> core
                      {' + '}<span data-testid="dashboard-booster-credits">{dd?.incentive.boosterCredits ?? 'Unavailable'}</span> booster
                      {' · '}{dd?.targetCycle?.label ?? `Current ${cycleDescription()} cycle`}
                    </>}
              </p>
            </Panel>
            </Tile>
          </TileGroup>

          {/* ── Lead Progression ── */}
          <Tile id="designer.leadProgression">{(() => {
            const STEPS = [
              { stage: 'MQL', label: 'MQL', color: '#16a34a' },
              { stage: 'DQL', label: 'DQL', color: '#d97706' },
              { stage: 'PROPOSAL_READY', label: 'PR', color: '#ea580c' },
              { stage: 'PROPOSAL_PRESENTED', label: 'PP', color: '#dc2626' },
              { stage: 'PROPOSAL_DISCUSSION', label: 'PD', color: '#be185d' },
              { stage: 'ONBOARDING', label: 'Onboarding', color: '#9333ea' },
              { stage: 'ONBOARDING_MEETING', label: 'OBM', color: '#2563eb' },
              { stage: 'CONVERSION', label: 'DIP', color: '#0891b2' },
            ]
              // Renamed stages show their new name; switched-off stages drop out (Admin → CRM Settings).
              .filter((step) => !crmSettings().hiddenStages.includes(step.stage))
              .map((step) => (step.stage === 'CONVERSION' ? step : { ...step, label: stageShortLabel(step.stage, step.label) }));
            const rows = new Map(funnelRows?.map((row) => [row.stage, row]));
            return (
              <Panel className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-lg font-bold text-stone-900">{L('designer.leadProgression', 'Lead Progression')}</p>
                    <p className="mt-1 text-xs text-stone-500">All time · leads that reached each stage</p>
                  </div>
                  {funnelRows && (
                    <p className="text-sm text-stone-600">Total leads received: <strong data-testid="progression-received">{rows.get('RECEIVED')?.total ?? '—'}</strong></p>
                  )}
                </div>
                {funnelError ? (
                  <div role="alert" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-stone-700">
                    <p>{funnelError}</p>
                    <button type="button" onClick={loadFunnel} className="mt-2 font-semibold text-brand-600">Retry lead progression</button>
                  </div>
                ) : !funnelRows ? (
                  <p role="status" className="mt-4 text-sm text-stone-500">Loading lead progression…</p>
                ) : (
                  <div data-testid="progression-cumulative">
                    <div className="mt-4 overflow-x-auto rounded-xl p-4" style={{ border: CARD_BORDER }}>
                      <div className="flex min-w-[800px] items-start justify-between gap-2">
                        {STEPS.map((step) => {
                          const row = rows.get(step.stage);
                          return (
                            <div key={step.stage} data-testid={`progression-stage-${step.stage}`} className="flex flex-1 flex-col items-center text-center">
                              <div data-testid="stage-count" className="flex h-14 w-14 items-center justify-center rounded-full text-xl font-extrabold" style={{ color: step.color, background: `${step.color}1A` }}>
                                {row?.total ?? '—'}
                              </div>
                              <span className="mt-2 h-2 w-2 rounded-full" style={{ background: step.color }} />
                              <span className="mt-1 text-xs font-semibold text-stone-600">{step.label}</span>
                              <span data-testid="stage-percentage" className="mt-2 text-xs text-stone-500">{row?.progressionPct == null ? '—' : `${row.progressionPct}% of received`}</span>
                              <span data-testid="stage-tat" className="mt-1 text-xs text-stone-500">Avg TAT: {formatLeadProgressionTat(row?.avgTatDays ?? null)}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <p className="mt-3 text-xs text-stone-500">Counts include all lead statuses. Average TAT uses active leads with recorded dates. DIP conversion requires a completed checklist.</p>
                    <Link to="/reports" className="mt-2 inline-block text-xs font-semibold text-brand-600">Full My Lead Funnel report →</Link>
                  </div>
                )}
                <Link to={designerId ? `/leads?${leadsScope}mine=1` : '/leads'} className="mt-3 inline-block text-sm font-semibold text-brand-600">View leads →</Link>
              </Panel>
            );
          })()}</Tile>

          {/* ── Pipeline Potential (forecast card removed per client request) ── */}
          {dd?.forecast && (
            <Tile id="designer.pipelinePotential">
            <div>
              <Panel className="p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <BarChart3 size={29} strokeWidth={2.4} className="text-indigo-500" />
                    <p className="text-lg font-bold text-stone-900">{L('designer.pipelinePotential', 'Pipeline Potential')}</p>
                    <ChevronRight size={18} strokeWidth={2.5} className="text-stone-900" />
                  </div>
                  <p className="text-xs italic text-stone-400">Expected OB date · current target cycle</p>
                </div>

                <div className="mt-4 rounded-xl border border-stone-100 p-4">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <p className="text-sm text-stone-500">Total Potential Value</p>
                      <p className="mt-1 text-3xl font-extrabold text-stone-900">{fmtBookingValue(pipelinePotentialValue)}</p>
                    </div>
                    <p className="text-lg font-semibold text-stone-700">{pipelinePotentialCount} Lead{pipelinePotentialCount === 1 ? '' : 's'}</p>
                  </div>

                  <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      { key: 'highIntent', label: 'High Intent', intentMin: formulas().intentTiers.highFrom, intentMax: 5, style: 'bg-green-50 text-green-700 border-green-100' },
                      { key: 'mediumIntent', label: 'Medium Intent', intentMin: formulas().intentTiers.mediumFrom, intentMax: formulas().intentTiers.highFrom - 1, style: 'bg-amber-50 text-amber-700 border-amber-100' },
                      { key: 'lowIntent', label: 'Low Intent', intentMin: 1, intentMax: formulas().intentTiers.mediumFrom - 1, style: 'bg-red-50 text-red-700 border-red-100' },
                    ].map((tier) => {
                      const tierData = dd.forecast[tier.key as 'highIntent' | 'mediumIntent' | 'lowIntent'];
                      const query = new URLSearchParams({
                        ...(designerId ? { designerId } : {}),
                        mine: '1',
                        projectedObFrom: dd.forecast.from,
                        projectedObTo: dd.forecast.to,
                        intentMin: String(tier.intentMin),
                        intentMax: String(tier.intentMax),
                        status: 'ACTIVE',
                        excludeStages: 'MQL,DQL,PROPOSAL_READY,DESIGN_IN_PROGRESS,HANDED_OVER',
                      });
                      return (
                        <Link key={tier.key} to={`/leads?${query}`} className={`rounded-xl border p-3 transition-shadow hover:shadow-sm ${tier.style}`}>
                          <p className="text-xs font-bold">{tier.label}</p>
                          <p className="mt-2 text-xl font-extrabold text-stone-900">{fmtBookingValue(tierData.value)}</p>
                          <p className="mt-1 text-xs text-stone-600">{tierData.count} lead{tierData.count === 1 ? '' : 's'}</p>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              </Panel>

            </div>
            </Tile>
          )}

          {/* ── Row 3: Conversion Insights + Today's Focus ── */}
          <TileGroup dashboard="designer" className="grid grid-cols-1 lg:grid-cols-3 gap-6">

            {/* Conversion Insights */}
            <Tile id="designer.conversionInsights">
            <Panel>
              <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: CARD_BORDER }}>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-50">
                    <BarChart3 size={19} strokeWidth={2.4} className="text-brand-600" />
                  </div>
                  <h3 className="font-bold tracking-tight text-stone-900">{L('designer.conversionInsights', 'Conversion Insights')}</h3>
                </div>
                <ChevronRight size={18} strokeWidth={2.5} className="text-stone-900" />
              </div>
              <div className="grid grid-cols-3 divide-x divide-stone-100 px-2 py-5">
                <div className="flex flex-col items-center px-2 text-center">
                  <MetricRing
                    value={conversionPct != null ? `${conversionPct.toFixed(1)}%` : '—'}
                    progress={conversionPct}
                    color="#22c55e"
                  />
                  <p className="mt-3 text-xs font-semibold text-stone-800">Conversion %</p>
                  <p className="mt-1 text-[10px] text-stone-400">Current cycle</p>
                </div>
                <div className="flex flex-col items-center px-2 text-center">
                  <MetricRing value={dd?.overallScore.averageTatDays ?? '—'} progress={null} />
                  <p className="mt-3 text-xs font-semibold text-stone-800">Average TAT</p>
                  <p className="mt-1 text-[10px] text-stone-400">Lead to booking</p>
                </div>
                <div className="flex flex-col items-center px-2 text-center">
                  <MetricRing
                    value={designNps != null ? designNps.toFixed(1) : '—'}
                    progress={designNps != null ? designNps * 10 : null}
                    color="#f59e0b"
                  />
                  <p className="mt-3 text-xs font-semibold text-stone-800">NPS (OB)</p>
                  <div className="mt-1 flex min-h-4 items-center justify-center gap-1">
                    <DeltaBadge current={designNps} prev={previousDesignNps} />
                    <span className="text-[10px] text-stone-400">vs previous</span>
                  </div>
                </div>
              </div>
            </Panel>
            </Tile>

            {/* Today's Focus — date-grouped live work-item feed */}
            <Tile id="designer.todaysFocus">
            <Panel>
              <PanelHeader
                title={L('designer.todaysFocus', "Today's Focus")}
                action={
                  <Link to="/tasks" className="text-xs text-brand-600 font-medium flex items-center gap-1">
                    View All <ChevronRight size={12} />
                  </Link>
                }
              />
              <div className="p-3 max-h-80 overflow-y-auto">
                {designerId ? (
                  <p className="text-sm text-stone-400 text-center py-6">Tasks and meetings are shown only on each designer's own dashboard.</p>
                ) : workItemsLoading ? (
                  <p className="text-xs text-stone-400 text-center py-6">Loading…</p>
                ) : workItems.length === 0 ? (
                  <p className="text-sm text-stone-400 text-center py-6">All clear — nothing urgent 🎉</p>
                ) : (
                  <div className="space-y-3">
                    {WI_BUCKETS.map(({ key, label, color }) => {
                      const bucketItems = workItems.filter((wi) => wiBucket(wi.dueAt) === key);
                      if (!bucketItems.length) return null;
                      return (
                        <div key={key}>
                          <p className={`text-[9px] font-bold uppercase tracking-widest mb-1.5 ${color}`}>
                            {label} · {bucketItems.length}
                          </p>
                          <div className="space-y-1">
                            {bucketItems.map((wi) => {
                              const icon = wi.type === 'MEETING'
                                ? <Calendar size={12} className="shrink-0 text-blue-500" />
                                : wi.type === 'SLA_BREACH'
                                ? <AlertTriangle size={12} className="shrink-0 text-red-500" />
                                : <Target size={12} className="shrink-0 text-brand-500" />;
                              const bg = wi.type === 'SLA_BREACH' ? '#FEF2F2'
                                : wi.type === 'MEETING' ? '#EEF4FF'
                                : ACCENT_BG;
                              return (
                                <Link
                                  key={wi.id}
                                  to={`/leads/${wi.leadId}`}
                                  className="flex items-start gap-2 p-2 rounded-xl hover:opacity-80 transition-opacity"
                                  style={{ background: bg }}
                                >
                                  <span className="mt-0.5">{icon}</span>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-semibold text-stone-800 truncate leading-tight">
                                      {wi.title}
                                    </p>
                                    <p className="text-[10px] text-stone-500 truncate leading-tight">
                                      {wi.leadName}{wi.leadDisplayId ? ` · ${wi.leadDisplayId}` : ''}
                                      {wi.subtitle ? ` · ${wi.subtitle}` : ''}
                                    </p>
                                  </div>
                                </Link>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Panel>
            </Tile>
          </TileGroup>

          {/* ── Row 4: Team Leaderboard ── */}
          <Tile id="designer.teamLeaderboard">
          <div>
            <Panel>
              <PanelHeader title={L('designer.teamLeaderboard', 'Team Leaderboard')} action={<span className="text-xs text-stone-400">{dd?.targetCycle?.label ?? 'Target cycle'} · Booking ₹</span>} />
              <div className="divide-y divide-stone-50">
                {dd?.leaderboard.length === 0 && (
                  <p className="text-sm text-stone-400 text-center py-8">No team data</p>
                )}
                {dd?.leaderboard.map((member) => (
                  <div
                    key={member.userId}
                    className={`flex items-center gap-3 px-5 py-3 ${member.isCurrentUser ? 'bg-orange-50' : 'hover:bg-stone-50'}`}
                  >
                    <span className={`w-7 h-7 rounded-full flex items-center justify-center text-sm font-extrabold shrink-0 ${member.rank === 1 ? 'bg-amber-100 text-amber-700' : 'bg-stone-100 text-stone-500'}`}>
                      {member.rank}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm font-semibold truncate ${member.isCurrentUser ? 'text-brand-700' : 'text-stone-800'}`}>
                        {member.name}{member.isCurrentUser && !designerId && ' (You)'}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-stone-900">{fmt(member.bookingValue)}</p>
                      {member.npsAvg != null && <p className="text-[10px] text-stone-400 flex items-center justify-end gap-0.5"><Star size={9} />{member.npsAvg}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          </Tile>

          {/* ── Row 6: Attention Required + Notifications + Client Health ── */}
          <TileGroup dashboard="designer" className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Attention Required
                Use dd.attentionItems (derived from the designer's own projects)
                for both DESIGNER and CRE. DESIGNER also gets data.needsAttention
                from deliveryWidgets; we prefer the more-specific dd source so CRE
                always sees real data rather than an empty list. */}
            <Tile id="designer.attentionRequired">{(() => {
              const items = dd?.attentionItems ?? data.needsAttention ?? [];
              return (
                <Panel>
                  <PanelHeader title={L('designer.attentionRequired', 'Attention Required')} action={
                    items.length > 0 && (
                      <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-0.5 rounded-full">{items.length}</span>
                    )
                  } />
                  {items.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-8 text-stone-400">
                      <span className="text-2xl mb-1">✓</span>
                      <p className="text-sm font-semibold text-stone-500">All clear</p>
                      <p className="text-xs">No flagged projects</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-stone-50 max-h-64 overflow-y-auto">
                      {items.map((item) => (
                        <div key={item.projectId} className="px-5 py-3 flex items-start gap-3">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-stone-800 truncate">{item.clientName}</p>
                            <p className="text-xs text-stone-500">{item.projectCode} · {item.category}</p>
                            {item.description && <p className="text-xs text-stone-400 mt-0.5 truncate">{item.description}</p>}
                          </div>
                          {item.daysOverdue > 0 && (
                            <span className="text-xs text-red-600 font-semibold shrink-0">{item.daysOverdue}d</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              );
            })()}</Tile>

            {/* Notifications */}
            <Tile id="designer.recentNotifications">
            <Panel>
              <PanelHeader title={L('designer.recentNotifications', 'Recent Notifications')} action={
                <Link to="/notifications" className="text-xs text-brand-600 font-medium flex items-center gap-1"><Bell size={12} /> View All</Link>
              } />
              {!dd?.recentNotifications.length ? (
                <div className="flex flex-col items-center justify-center py-8 text-stone-400">
                  <Bell size={20} strokeWidth={1.5} className="mb-2" />
                  <p className="text-sm">No recent notifications</p>
                </div>
              ) : (
                <div className="divide-y divide-stone-50 max-h-64 overflow-y-auto">
                  {dd.recentNotifications.map((n) => (
                    <div key={n.id} className={`flex items-start gap-3 px-5 py-2.5 ${!n.isRead ? 'bg-orange-50' : 'hover:bg-stone-50'}`}>
                      <span className="text-base shrink-0 mt-0.5">{NOTIF_ICON[n.type] ?? '🔔'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-stone-700 leading-relaxed">{n.message}</p>
                        {n.lead && <p className="text-[10px] text-stone-400 mt-0.5">{n.lead.name} · {n.lead.leadId}</p>}
                        <p className="text-[10px] text-stone-300 mt-0.5">{new Date(n.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}</p>
                      </div>
                      {!n.isRead && <span className="w-1.5 h-1.5 rounded-full shrink-0 mt-1.5" style={{ background: BRAND }} />}
                    </div>
                  ))}
                </div>
              )}
            </Panel>
            </Tile>
          </TileGroup>

          {/* ── Client Health summary ── */}
          {dd?.clientHealth && (
            <Tile id="designer.clientHealth">
            <Panel to="/client-health" drillLabel="View client health" className="p-5">
              <p className="mb-2 text-xs text-stone-500">Information completeness — separate from contact health</p>
              {contactCounts && <p className="mb-3 text-xs text-stone-600" data-testid="dashboard-contact-health">
                Contact: {contactCounts.recent} recent · {contactCounts.warning} warning · {contactCounts.highRisk} high risk · {contactCounts.unknown} unknown
              </p>}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Heart size={27} fill="currentColor" className="text-brand-600" />
                  <h3 className="text-lg font-bold text-stone-900">{L('designer.clientHealth', 'Client Health')}</h3>
                </div>
                <ChevronRight size={20} className="text-stone-700" />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-stone-100 bg-white p-4">
                  <p className="text-3xl font-extrabold text-stone-900">{clientHealthCounts.total}</p>
                  <p className="mt-1 text-sm text-stone-500">Active Clients</p>
                </div>
                {[
                  { label: 'Healthy', value: clientHealthCounts.healthy, dot: 'bg-green-500', bg: 'bg-green-50' },
                  { label: 'At Risk', value: clientHealthCounts.atRisk, dot: 'bg-amber-500', bg: 'bg-amber-50' },
                  { label: 'Critical', value: clientHealthCounts.critical, dot: 'bg-red-500', bg: 'bg-red-50' },
                ].map((item) => (
                  <div key={item.label} className={`rounded-xl p-4 ${item.bg}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-3.5 w-3.5 rounded-full ${item.dot}`} />
                      <p className="text-2xl font-extrabold text-stone-900">{item.value}</p>
                    </div>
                    <p className="mt-1 text-sm font-medium text-stone-700">{item.label}</p>
                  </div>
                ))}
              </div>
            </Panel>
            </Tile>
          )}

          {/* ── Monthly medal ── */}
          <Tile id="designer.monthlyMedal">
          <div className="rounded-2xl p-5 border" style={{ background: medal?.medal === 'GOLD' ? '#FFF8DF' : '#FAF6F2', borderColor: '#EDE8E3' }}>
            <p className="text-xs font-bold uppercase tracking-widest text-stone-400">{L('designer.monthlyMedal', 'Monthly Medal')} · {medal?.cycle.label ?? 'Current cycle'}</p>
            <div className="flex items-end justify-between gap-4 mt-2">
              <div><p className="text-2xl font-extrabold text-stone-900">{medal?.medal ? `${medal.medal[0]}${medal.medal.slice(1).toLowerCase()} Medal` : 'No medal yet'}</p><p className="text-xs text-stone-500 mt-1">Designer score: Sales % ({formulas().designerMedalSalesWeight}%) + Design/DIP % ({100 - formulas().designerMedalSalesWeight}%). Gold from {formulas().medals.gold}%, Silver from {formulas().medals.silver}%, Bronze from {formulas().medals.bronze}%.</p></div>
              <p className="text-3xl font-extrabold text-brand-600">{medal?.score != null ? `${medal.score}%` : '—'}</p>
            </div>
          </div>
          </Tile>

        </TileGroup>
      )}
    </div>
  );
}
