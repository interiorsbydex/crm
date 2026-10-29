import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
} from 'recharts';
import toast from 'react-hot-toast';
import { api } from '../lib/api';
import { LIVE_REFRESH_SECONDS, useLiveRefresh } from '../lib/liveRefresh';
import { getStoredUser } from '../lib/auth';
import { DateInput } from '../components/ui/DateTimeInputs';
import DesignerReports from '../components/reports/DesignerReports';
import BlAdminReports from '../components/reports/BlAdminReports';
import CreditsPanel from '../components/reports/CreditsPanel';
import { stageShortLabel, stageLabel, cycleDescription, useCrmSettings } from '../lib/crmSettings';
import { Tile, TileGroup, useDashboardLayout } from '../lib/dashboardLayout';
import { downloadCsv } from '../lib/csv';

// ── Types ─────────────────────────────────────────────────────────────────────
type AnyRow = Record<string, unknown>;
type DesignerIncentive = {
  walletBalance: number;
  projectedEarnings: number;
  coreCreditsEarned: number;
  coreCreditsTotal: number;
  boosterCredits: number;
  totalCredits: number;
  nextMilestoneCredits: number;
  nextMilestoneBooking: number;
  furnitureIncentive: number;
  portfolioIncentive: number;
  potentialEarnings: number;
};
type NpsStage = 'SALE' | 'DESIGN_FREEZE' | 'SIGN_OFF';
type DesignerReportData = {
  incentive: DesignerIncentive;
  npsThisMonth: Record<NpsStage, number | null>;
  npsTrend: Array<Record<NpsStage, number | null> & { month: string }>;
  clientHealth: {
    leads: Array<{ id: string; clientName: string; leadId: string; leadDbId: string; stage: string; health: string; attentionCount: number }>;
    projects: Array<{ id: string; projectCode: string; clientName: string; leadId: string; leadDbId: string; health: string; attentionCount: number }>;
  };
};

// ── Constants ─────────────────────────────────────────────────────────────────
// EFFECTIVE_LEAD/HANDED_OVER kept only for rendering legacy report rows —
// they are no longer part of the active funnel (see PIPELINE_STAGES on the
// server, which reports use to build stage-shaped rows).
// Short labels used ONLY in the reports chart axes (space-constrained).
// Full label is 'PD (Pitch Discussion)' — see LeadList.tsx / LeadDetail.tsx STAGE_LABELS.
const STAGE_LABEL_SHORT: Record<string, string> = {
  NEW_LEAD: 'New', EFFECTIVE_LEAD: 'Effective', MQL: 'MQL',
  DQL: 'DQL', PROPOSAL_READY: 'Prop. Ready',
  PROPOSAL_PRESENTED: 'Prop. Presented',
  PROPOSAL_DISCUSSION: 'PD', /* chart axis abbreviation — full label is 'PD (Pitch Discussion)' */
  ONBOARDING: 'Onboarding', ONBOARDING_MEETING: 'Onboarding Mtg',
  DESIGN_IN_PROGRESS: 'Design in Progress', HANDED_OVER: 'Handed Over',
};
const STAGE_COLOR: Record<string, string> = {
  NEW_LEAD: '#94a3b8', EFFECTIVE_LEAD: '#6366f1', MQL: '#f59e0b',
  DQL: '#3b82f6', PROPOSAL_READY: '#8b5cf6',
  PROPOSAL_PRESENTED: '#d95f32', PROPOSAL_DISCUSSION: '#a855f7',
  ONBOARDING: '#22c55e', ONBOARDING_MEETING: '#14b8a6',
  DESIGN_IN_PROGRESS: '#059669', HANDED_OVER: '#06b6d4',
};
const BRAND = '#d95f32';

function fmtMonth(iso: string) {
  const [y, m] = iso.split('-');
  return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]} ${y}`;
}

function pct(n: number, d: number) {
  if (!d) return '—';
  return (n / d * 100).toFixed(1) + '%';
}

function HealthPill({ health }: { health: string }) {
  const styles: Record<string, string> = {
    ON_TRACK: 'bg-green-100 text-green-700',
    AT_RISK: 'bg-amber-100 text-amber-700',
    DELAYED: 'bg-red-100 text-red-700',
  };
  const labels: Record<string, string> = {
    ON_TRACK: 'Healthy',
    AT_RISK: 'At Risk',
    DELAYED: 'Critical',
  };
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${styles[health] ?? 'bg-gray-100 text-gray-600'}`}>
      {labels[health] ?? health}
    </span>
  );
}

// ── Date presets ───────────────────────────────────────────────────────────────
type Preset = 'month' | 'quarter' | 'lfy' | 'custom';

function getPresetRange(p: Preset): { startDate: string; endDate: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (p === 'month') {
    return { startDate: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), endDate: fmt(now) };
  }
  if (p === 'quarter') {
    const qStart = Math.floor(now.getMonth() / 3) * 3;
    return { startDate: fmt(new Date(now.getFullYear(), qStart, 1)), endDate: fmt(now) };
  }
  if (p === 'lfy') {
    // India FY: Apr 1 → Mar 31
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() - 1 : now.getFullYear() - 2;
    return { startDate: `${fyYear}-04-01`, endDate: `${fyYear + 1}-03-31` };
  }
  return { startDate: '', endDate: '' };
}

// ── Quarterly aggregation ──────────────────────────────────────────────────────
function groupMonthly(rows: { month: string; leads: number; onboardings: number }[], view: 'monthly' | 'quarterly' | 'annual') {
  if (view === 'monthly') return rows.map((r) => ({ ...r, label: fmtMonth(r.month) }));
  if (view === 'annual') {
    const map = new Map<string, { leads: number; onboardings: number }>();
    for (const r of rows) {
      const y = r.month.slice(0, 4);
      const cur = map.get(y) ?? { leads: 0, onboardings: 0 };
      map.set(y, { leads: cur.leads + r.leads, onboardings: cur.onboardings + r.onboardings });
    }
    return [...map.entries()].map(([k, v]) => ({ label: k, ...v }));
  }
  // quarterly
  const map = new Map<string, { leads: number; onboardings: number }>();
  for (const r of rows) {
    const [y, m] = r.month.split('-').map(Number);
    const q = Math.floor((m - 1) / 3) + 1;
    const key = `Q${q} ${y}`;
    const cur = map.get(key) ?? { leads: 0, onboardings: 0 };
    map.set(key, { leads: cur.leads + r.leads, onboardings: cur.onboardings + r.onboardings });
  }
  return [...map.entries()].map(([k, v]) => ({ label: k, ...v }));
}

// ── Shared components ──────────────────────────────────────────────────────────
function SectionCard({ title, subtitle, onExport, children, id }: {
  title: string; subtitle: string; onExport?: () => void;
  children: React.ReactNode; id?: string;
}) {
  return (
    <div id={id} className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
        </div>
        {onExport && (
          <button onClick={onExport}
            className="text-xs font-medium text-gray-500 hover:text-gray-800 border border-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-50 transition-colors shrink-0">
            ↓ Export CSV
          </button>
        )}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function KPICard({ label, value, sub, color = 'gray' }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  const bg = color === 'brand' ? 'bg-brand-50' : color === 'green' ? 'bg-green-50' : color === 'blue' ? 'bg-blue-50' : 'bg-gray-50';
  const txt = color === 'brand' ? 'text-brand-700' : color === 'green' ? 'text-green-700' : color === 'blue' ? 'text-blue-700' : 'text-gray-800';
  return (
    <div className={`${bg} rounded-xl p-4`}>
      <p className="text-xs font-medium text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${txt}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return <p className="text-sm text-gray-400 text-center py-8">{msg}</p>;
}

function MiniTable({ headers, rows }: { headers: { key: string; label: string; naReason?: string }[]; rows: AnyRow[] }) {
  if (!rows.length) return <EmptyState msg="No data available" />;
  return (
    <div className="overflow-x-auto mt-3">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-100">
            {headers.map((h) => (
              <th key={h.key} className="text-left py-2 px-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">{h.label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50">
              {headers.map((h) => (
                <td key={h.key} className="py-2 px-2 text-gray-700">
                  {row[h.key] === null || row[h.key] === undefined
                    ? <>—{h.naReason && <span className="ml-1 text-[10px] text-gray-400" title={h.naReason} data-testid="na-reason">({h.naReason})</span>}</>
                    : String(row[h.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Loader() {
  return (
    <div className="flex items-center justify-center py-12">
      <div className="w-5 h-5 border-2 border-brand-300 border-t-brand-600 rounded-full animate-spin" />
    </div>
  );
}

// ── Collapsible Section 8 card ─────────────────────────────────────────────────
function CollapsibleCard({ title, subtitle, onExport, children }: {
  title: string; subtitle: string; onExport?: () => void; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full px-5 py-4 flex items-center justify-between gap-4 hover:bg-gray-50 transition-colors"
      >
        <div className="text-left">
          <p className="text-sm font-semibold text-gray-900">{title}</p>
          <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {open && onExport && (
            <span
              onClick={(e) => { e.stopPropagation(); onExport(); }}
              className="text-xs font-medium text-gray-500 hover:text-gray-800 border border-gray-200 px-2.5 py-1 rounded-lg hover:bg-gray-50 transition-colors"
            >
              ↓ Export CSV
            </span>
          )}
          <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
        </div>
      </button>
      {open && <div className="px-5 pb-5 border-t border-gray-100">{children}</div>}
    </div>
  );
}

// ── Export helper ──────────────────────────────────────────────────────────────
function useExport() {
  return async (reportType: string, qs: string) => {
    const token = localStorage.getItem('crm_token') ?? '';
    try {
      const resp = await fetch(`/api/reports/${reportType}/export${qs ? '?' + qs : ''}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) { toast.error(`Export not available for ${reportType}`); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${reportType}_report.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Export failed');
    }
  };
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Reports() {
  // Admin → Dashboards → Reports page: hide, reorder and rename sections.
  const { label: reportLabel } = useDashboardLayout('reports');
  const user = getStoredUser();
  const role = user?.role ?? '';
  const showFull = ['BRANCH_HEAD', 'BL'].includes(role);
  const isDesigner = role === 'DESIGNER';
  // Business Leads use the designer-format report (team view + designer filter).
  // Source/stage dispersal, designer/monthly/meeting/sales-cycle views, and
  // Offer/Campaign performance are not shown to them (Offer/Campaign are admin-side).
  const isBL = role === 'BL';

  const [preset, setPreset] = useState<Preset>('month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');

  type Rep = { data: any; loading: boolean };
  const [r, setR] = useState<Record<string, Rep>>({});

  const exportFn = useExport();

  // Filters for Branch Head and Business Lead; every lead-based report and its CSV export follows them.
  const crm = useCrmSettings();
  const [filters, setFilters] = useState({ designerId: '', blId: '', source: '', stage: '', projectType: '', location: '' });
  const [people, setPeople] = useState<{ designers: { id: string; name: string }[]; bls: { id: string; name: string }[] }>({ designers: [], bls: [] });
  const setFilter = (k: keyof typeof filters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const filtersActive = Object.values(filters).some(Boolean);
  useEffect(() => {
    if (!showFull) return;
    // A Business Lead's designer list is only their own team; the Branch Head sees everyone.
    if (isBL) {
      api.get<{ members: { id: string; name: string }[] }>('/leads/meta/team-members')
        .then((d) => setPeople({ designers: d.members, bls: [] })).catch(() => {});
    } else {
      api.get<{ users: { id: string; name: string; role: string }[] }>('/leads/meta/allocated-users')
        .then((d) => setPeople({ designers: d.users.filter((u) => u.role === 'DESIGNER'), bls: d.users.filter((u) => u.role === 'BL') })).catch(() => {});
    }
  }, [showFull, isBL]);

  const buildQS = useCallback(() => {
    const { startDate, endDate } = preset === 'custom'
      ? { startDate: customStart, endDate: customEnd }
      : getPresetRange(preset);
    const p = new URLSearchParams();
    if (startDate) p.set('startDate', startDate);
    if (endDate) p.set('endDate', endDate);
    if (showFull) for (const [k, v] of Object.entries(filters)) if (v.trim()) p.set(k, v.trim());
    return p.toString();
  }, [preset, customStart, customEnd, filters, showFull]);

  const doExport = (type: string) => exportFn(type, buildQS());

  const setRep = (key: string, data: any) =>
    setR((prev) => ({ ...prev, [key]: { data, loading: false } }));
  const setLoading = (key: string) =>
    setR((prev) => ({ ...prev, [key]: { data: prev[key]?.data ?? null, loading: true } }));

  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const fetchAll = useCallback(async (background = false) => {
    const qs = buildQS();
    const qsStr = qs ? '?' + qs : '';
    const endpoints = [
      'lead_summary', 'pipeline', 'project_type', 'source_performance', 'designer_performance',
      'monthly_trend', 'offer_performance', 'campaign_performance', 'inactive_leads',
      'meeting_performance', 'conversion', 'bl_performance', 'sales_cycle',
      'lead_aging', 'timeline_performance',
    ].filter((ep) => !((isDesigner || isBL) && (ep === 'bl_performance' || ep === 'conversion')));
    // A quiet refresh keeps the numbers on screen instead of flashing the loading state.
    if (!background) {
      endpoints.forEach((ep) => setLoading(ep));
      if (isDesigner) setLoading('designer_incentive');
    }
    const requests: Promise<void>[] = endpoints.map(async (ep) => {
        try {
          const res = await api.get<{ data: any }>(`/reports/${ep}${qsStr}`);
          setRep(ep, res.data);
        } catch (e: any) {
          setRep(ep, null);
        }
      });
    if (isDesigner) {
      requests.push((async () => {
        try {
          const reportRange = new URLSearchParams(qs);
          const dashboardRange = new URLSearchParams();
          const startDate = reportRange.get('startDate');
          const endDate = reportRange.get('endDate');
          if (startDate) dashboardRange.set('from', startDate);
          if (endDate) dashboardRange.set('to', endDate);
          const suffix = dashboardRange.toString() ? `?${dashboardRange}` : '';
          const dashboard = await api.get<{ designerDash?: DesignerReportData }>(`/dashboard${suffix}`);
          setRep('designer_incentive', dashboard.designerDash ?? null);
        } catch {
          setRep('designer_incentive', null);
        }
      })());
    }
    await Promise.allSettled(requests);
    setLastUpdated(new Date());
  }, [buildQS, isDesigner, isBL]);

  useEffect(() => {
    if (preset !== 'custom') fetchAll();
  }, [preset, fetchAll]);

  // Keep the reports current as leads move, like the Dashboard: right after any change,
  // every few seconds, and whenever this tab is brought back to the front.
  useLiveRefresh(() => { if (!(preset === 'custom' && !(customStart && customEnd))) void fetchAll(true); });
  // With a custom date range, changing a filter reloads straight away once both dates are set.
  useEffect(() => {
    if (preset === 'custom' && customStart && customEnd) fetchAll();
  }, [filters]); // eslint-disable-line react-hooks/exhaustive-deps

  const [trendView, setTrendView] = useState<'monthly' | 'quarterly' | 'annual'>('monthly');

  // ── Derived KPI values ────────────────────────────────────────────────────
  const leadSummaryRows: AnyRow[] = Array.isArray(r.lead_summary?.data) ? r.lead_summary.data : [];
  const totalLeads = leadSummaryRows.reduce((s, row) => s + ((row.count as number) || 0), 0);

  const pipelineRows: AnyRow[] = Array.isArray(r.pipeline?.data) ? r.pipeline.data : [];
  // "Onboarded" = reached Onboarding or later, the same as the Dashboard funnel. "Booked" = Design in Progress
  // (the funnel's terminal/incentive stage; HANDED_OVER kept for legacy leads, see funnel-restructure memory).
  const countAt = (stages: string[]) => pipelineRows
    .filter((row) => stages.includes(String(row.stage)))
    .reduce((s, row) => s + ((row.count as number) || 0), 0);
  const onboardedCount = countAt(['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']);
  const bookedCount = countAt(['DESIGN_IN_PROGRESS', 'HANDED_OVER']);
  const conversionPct = totalLeads > 0 ? ((onboardedCount / totalLeads) * 100).toFixed(1) + '%' : '0%';
  const activeDesigners = Array.isArray(r.designer_performance?.data)
    ? r.designer_performance.data.length : 0;

  // Pipeline chart data
  const pipelineChartData = pipelineRows.map((row) => ({
    stage: stageShortLabel(String(row.stage as string), STAGE_LABEL_SHORT[row.stage as string]),
    stageKey: row.stage as string,
    count: row.count as number,
  }));

  const projectTypeRows: AnyRow[] = Array.isArray(r.project_type?.data) ? r.project_type.data : [];
  const projectTypeTotal = projectTypeRows.reduce((s, row) => s + ((row.count as number) || 0), 0);

  // Source chart data
  const sourceRows: AnyRow[] = Array.isArray(r.source_performance?.data) ? r.source_performance.data : [];
  const sourceChartData = sourceRows.map((row) => ({
    source: String(row.source),
    count: (row.total as number) || 0,
  }));
  const sourceTotal = sourceChartData.reduce((s, r) => s + r.count, 0);

  // Monthly trend data
  const monthlyRaw: { month: string; leads: number; onboardings: number }[] =
    Array.isArray(r.monthly_trend?.data?.monthly) ? r.monthly_trend.data.monthly : [];
  const trendData = groupMonthly(monthlyRaw, trendView);

  // Offer performance
  const offerRows: AnyRow[] = Array.isArray(r.offer_performance?.data) ? r.offer_performance.data : [];

  // Campaign
  const campaignRows: AnyRow[] = Array.isArray(r.campaign_performance?.data) ? r.campaign_performance.data : [];

  // Inactive
  const inactiveSummary = r.inactive_leads?.data?.summary ?? {};
  const inactiveRows: AnyRow[] = r.inactive_leads?.data?.rows ?? [];

  // Meeting performance
  const meetingRows: AnyRow[] = Array.isArray(r.meeting_performance?.data) ? r.meeting_performance.data : [];

  // BL performance
  const blRows: AnyRow[] = Array.isArray(r.bl_performance?.data) ? r.bl_performance.data : [];

  // Sales cycle
  const salesCycleRows: AnyRow[] = Array.isArray(r.sales_cycle?.data) ? r.sales_cycle.data : [];

  // Lead aging
  const agingRows: AnyRow[] = Array.isArray(r.lead_aging?.data) ? r.lead_aging.data : [];

  // Timeline performance
  const timelineRows: AnyRow[] = Array.isArray(r.timeline_performance?.data) ? r.timeline_performance.data : [];

  // Conversion funnel
  const conversionRows: AnyRow[] = Array.isArray(r.conversion?.data) ? r.conversion.data : [];

  // Designer performance
  const designerRows: AnyRow[] = Array.isArray(r.designer_performance?.data) ? r.designer_performance.data : [];
  const designerReport = r.designer_incentive?.data as DesignerReportData | null | undefined;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Sticky filter bar ─────────────────────────────────────────────── */}
      <div className="shrink-0 bg-white border-b border-gray-100 px-5 py-2.5 flex items-center gap-3 flex-wrap">
        <div>
          <p className="text-base font-semibold text-gray-900">Reports</p>
          <p className="text-[11px] text-gray-400" data-testid="reports-updated">
            {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} · updates by itself every ${LIVE_REFRESH_SECONDS} seconds and right after any change` : 'Loading…'}
            {' '}<button type="button" onClick={() => { void fetchAll(); }} className="text-brand-600 hover:underline">Refresh now</button>
          </p>
        </div>
        <div className="flex items-center gap-1 ml-3">
          {([['month', 'This Month'], ['quarter', 'This Quarter'], ['lfy', 'Last Financial Year']] as [Preset, string][]).map(([p, label]) => (
            <button
              key={p}
              onClick={() => setPreset(p)}
              className={`text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors ${
                preset === p ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            onClick={() => setPreset('custom')}
            className={`text-xs font-medium px-2.5 py-1.5 rounded-lg transition-colors ${
              preset === 'custom' ? 'bg-brand-500 text-white' : 'text-gray-600 hover:bg-gray-100'
            }`}
          >
            Custom Range
          </button>
        </div>
        <p className="basis-full text-[11px] text-gray-500" data-testid="reports-range-note">
          Most reports here count leads by their <strong>origin date</strong> (the day the lead came in) {(() => {
            const r = preset === 'custom' ? { startDate: customStart, endDate: customEnd } : getPresetRange(preset);
            return r.startDate && r.endDate ? `between ${r.startDate} and ${r.endDate}` : 'in the period you choose';
          })()}. A lead that came in earlier will not appear here even if you move it today. Choose a wider period or a Custom Range to include it. Imported leads have no stage history, so stage figures are by the stage each lead is at now. Leads marked as Test Leads are never counted.
        </p>
        {preset === 'custom' && (
          <div className="flex items-center gap-2">
            <DateInput value={customStart}
              onChange={setCustomStart}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs" />
            <span className="text-xs text-gray-400">→</span>
            <DateInput value={customEnd}
              onChange={setCustomEnd}
              className="border border-gray-200 rounded-lg px-2 py-1 text-xs" />
            <button
              onClick={() => { void fetchAll(); }}
              disabled={!customStart || !customEnd}
              className="text-xs font-medium bg-brand-500 text-white px-3 py-1.5 rounded-lg hover:bg-brand-600 disabled:opacity-40 transition-colors"
            >
              Apply
            </button>
          </div>
        )}
        {showFull && (
          <div className="basis-full flex flex-wrap items-center gap-2" data-testid="report-filters">
            <span className="text-xs font-medium text-gray-500">Filter by</span>
            {(() => {
              const sel = 'border border-gray-200 rounded-lg px-2 py-1 text-xs bg-white';
              return (<>
                <select aria-label="Designer" className={sel} value={filters.designerId} onChange={(e) => setFilter('designerId', e.target.value)}>
                  <option value="">All designers</option>
                  {people.designers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
                {!isBL && (
                  <select aria-label="Business Lead" className={sel} value={filters.blId} onChange={(e) => setFilter('blId', e.target.value)}>
                    <option value="">All Business Leads</option>
                    {people.bls.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                )}
                <select aria-label="Source" className={sel} value={filters.source} onChange={(e) => setFilter('source', e.target.value)}>
                  <option value="">All sources</option>
                  {crm.leadSources.filter((x) => x.active).map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </select>
                <select aria-label="Stage" className={sel} value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)}>
                  <option value="">All stages</option>
                  {['MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS']
                    .filter((st) => !crm.hiddenStages.includes(st)).map((st) => <option key={st} value={st}>{stageLabel(st)}</option>)}
                </select>
                <input aria-label="Project type" placeholder="Project type (e.g. Apartment, or (blank))" className={`${sel} w-52`} value={filters.projectType} onChange={(e) => setFilter('projectType', e.target.value)} />
                <select aria-label="Location" className={sel} value={filters.location} onChange={(e) => setFilter('location', e.target.value)}>
                  <option value="">All locations</option>
                  {crm.cities.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
                </select>
                {filtersActive && (
                  <button type="button" className="text-xs font-medium text-brand-600 hover:underline"
                    onClick={() => setFilters({ designerId: '', blId: '', source: '', stage: '', projectType: '', location: '' })}>
                    Clear filters
                  </button>
                )}
              </>);
            })()}
          </div>
        )}
      </div>

      {/* ── Scrollable content ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-5 space-y-6 max-w-6xl mx-auto">

          {(isDesigner || isBL) && <DesignerReports role={role} />}

          {isDesigner && (
            <TileGroup dashboard="reports" className="space-y-6">

              <Tile id="reports.incentiveOverview">
              <SectionCard
                title={reportLabel('reports.incentiveOverview', 'Incentive overview')}
                subtitle={`Core and booster credits for the selected ${cycleDescription()} cycle. Credits only — no ₹ payout shown.`}
              >
                <CreditsPanel showTitle={false} />
              </SectionCard>
              </Tile>

              <Tile id="reports.npsAnalytics">
              <SectionCard
                title={reportLabel('reports.npsAnalytics', 'NPS analytics')}
                subtitle="Sales, Design Freeze, and Sign Off NPS trends for the last six months."
                onExport={designerReport ? () => downloadCsv('nps_analytics', [
                  { Month: 'This month', 'Sales NPS': designerReport.npsThisMonth.SALE ?? '', 'Design Freeze NPS': designerReport.npsThisMonth.DESIGN_FREEZE ?? '', 'Sign Off NPS': designerReport.npsThisMonth.SIGN_OFF ?? '' },
                  ...designerReport.npsTrend.map((m) => ({ Month: m.month, 'Sales NPS': m.SALE ?? '', 'Design Freeze NPS': m.DESIGN_FREEZE ?? '', 'Sign Off NPS': m.SIGN_OFF ?? '' })),
                ]) : undefined}
              >
                {r.designer_incentive?.loading ? <Loader /> : !designerReport ? (
                  <EmptyState msg="NPS data is not available." />
                ) : (
                  <div className="space-y-5">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      {([
                        ['Sales NPS', 'SALE'],
                        ['Design Freeze NPS', 'DESIGN_FREEZE'],
                        ['Sign Off NPS', 'SIGN_OFF'],
                      ] as [string, NpsStage][]).map(([label, key]) => (
                        <KPICard
                          key={key}
                          label={label}
                          value={designerReport.npsThisMonth[key] == null ? '—' : designerReport.npsThisMonth[key]!.toFixed(1)}
                        />
                      ))}
                    </div>
                    {designerReport.npsTrend.some((month) => month.SALE != null || month.DESIGN_FREEZE != null || month.SIGN_OFF != null) ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={designerReport.npsTrend} margin={{ left: 0, right: 12, top: 5, bottom: 0 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                          <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                          <YAxis domain={[0, 10]} tick={{ fontSize: 10 }} />
                          <Tooltip contentStyle={{ fontSize: 11 }} />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Line type="monotone" dataKey="SALE" name="Sales" stroke="#d946ef" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                          <Line type="monotone" dataKey="DESIGN_FREEZE" name="Design Freeze" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                          <Line type="monotone" dataKey="SIGN_OFF" name="Sign Off" stroke="#22c55e" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState msg="No NPS responses in the last six months." />
                    )}
                  </div>
                )}
              </SectionCard>
              </Tile>
            </TileGroup>
          )}

          <TileGroup dashboard="reports" className="space-y-6">
          {/* ═══ SECTION 1 — SALES PIPELINE (full only) ═════════════════════ */}
          {showFull && !isBL && (
            <Tile id="reports.salesPipeline">
            <div className="space-y-4">
              <div>
                <h2 className="text-sm font-semibold text-gray-900">{reportLabel('reports.salesPipeline', 'Sales pipeline')}</h2>
                <p className="text-xs text-gray-400 mt-0.5">Conversion, performance &amp; trends across the pipeline.</p>
              </div>

              {/* KPI row */}
              <div className="grid grid-cols-5 gap-3">
                <KPICard label="Total Leads" value={r.lead_summary?.loading ? '…' : totalLeads} color="brand" />
                <KPICard label="Onboarded" value={r.pipeline?.loading ? '…' : onboardedCount} sub="Reached Onboarding or later" color="green" />
                <KPICard label="Booked / Design in Progress" value={r.pipeline?.loading ? '…' : bookedCount} sub="Design in Progress + Handed Over" color="green" />
                <KPICard label="Conversion" value={r.pipeline?.loading ? '…' : conversionPct} sub="Leads → onboarded" color="blue" />
                <KPICard label="Active Designers" value={r.designer_performance?.loading ? '…' : activeDesigners} />
              </div>

              {/* Two charts side by side */}
              <div className="grid grid-cols-2 gap-4">

                {/* Source Performance */}
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-gray-800">Lead source performance</p>
                    </div>
                    <button onClick={() => doExport('source_performance')}
                      className="text-[10px] text-gray-400 hover:text-gray-700 border border-gray-200 px-2 py-0.5 rounded-lg">
                      ↓ CSV
                    </button>
                  </div>
                  <div className="p-4">
                    {r.source_performance?.loading ? <Loader /> : sourceChartData.length === 0 ? <EmptyState msg="No source data" /> : (
                      <>
                        <ResponsiveContainer width="100%" height={160}>
                          <BarChart data={sourceChartData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                            <XAxis dataKey="source" tick={{ fontSize: 9 }} />
                            <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                            <Tooltip contentStyle={{ fontSize: 11 }} />
                            <Bar dataKey="count" fill={BRAND} radius={[3, 3, 0, 0]} name="Leads" />
                          </BarChart>
                        </ResponsiveContainer>
                        <MiniTable
                          headers={[{ key: 'source', label: 'Source' }, { key: 'total', label: 'Leads' }, { key: '_share', label: 'Share %' }]}
                          rows={sourceRows.map((row) => ({
                            ...row,
                            _share: sourceTotal > 0 ? (((row.total as number) / sourceTotal) * 100).toFixed(1) + '%' : '—',
                          }))}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* Stage Distribution */}
                <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                    <div>
                      <p className="text-xs font-semibold text-gray-800">Stage distribution</p>
                    </div>
                    <button onClick={() => doExport('pipeline')}
                      className="text-[10px] text-gray-400 hover:text-gray-700 border border-gray-200 px-2 py-0.5 rounded-lg">
                      ↓ CSV
                    </button>
                  </div>
                  <div className="p-4">
                    {r.pipeline?.loading ? <Loader /> : pipelineChartData.length === 0 ? <EmptyState msg="No pipeline data" /> : (
                      <>
                        <ResponsiveContainer width="100%" height={160}>
                          <BarChart data={pipelineChartData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                            <XAxis dataKey="stage" tick={{ fontSize: 9 }} />
                            <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                            <Tooltip contentStyle={{ fontSize: 11 }} />
                            <Bar dataKey="count" radius={[3, 3, 0, 0]} name="Leads">
                              {pipelineChartData.map((d, i) => (
                                <Cell key={i} fill={STAGE_COLOR[d.stageKey] ?? '#94a3b8'} />
                              ))}
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                        <MiniTable
                          headers={[{ key: 'stage', label: 'Stage' }, { key: 'count', label: 'Leads' }, { key: '_share', label: 'Share %' }]}
                          rows={pipelineRows.map((row) => {
                            const total = pipelineRows.reduce((s, r) => s + ((r.count as number) || 0), 0);
                            return {
                              stage: stageShortLabel(String(row.stage as string), STAGE_LABEL_SHORT[row.stage as string]),
                              count: row.count,
                              _share: total > 0 ? (((row.count as number) / total) * 100).toFixed(1) + '%' : '—',
                            };
                          })}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Project type (grouped by the first word typed) */}
              <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <p className="text-xs font-semibold text-gray-800">Project type <span className="font-normal text-gray-400">· grouped by the first word, e.g. “Apartment - 3bhk” counts under Apartment</span></p>
                  <button onClick={() => doExport('project_type')}
                    className="text-[10px] text-gray-400 hover:text-gray-700 border border-gray-200 px-2 py-0.5 rounded-lg">
                    ↓ CSV
                  </button>
                </div>
                <div className="p-4">
                  {r.project_type?.loading ? <Loader /> : (
                    <MiniTable
                      headers={[{ key: 'projectType', label: 'Project type' }, { key: 'count', label: 'Leads' }, { key: '_share', label: 'Share %' }]}
                      rows={projectTypeRows.map((row) => ({
                        ...row,
                        _share: projectTypeTotal > 0 ? (((row.count as number) / projectTypeTotal) * 100).toFixed(1) + '%' : '—',
                      }))}
                    />
                  )}
                </div>
              </div>
            </div>
            </Tile>
          )}

          {/* ═══ SECTION 2 — DESIGNER PERFORMANCE (all roles) ═══════════════ */}
          {!isDesigner && !isBL && (
          <Tile id="reports.designerPerformance">
          <SectionCard
            title={reportLabel('reports.designerPerformance', 'Designer performance')}
            subtitle={`Assigned leads, design meetings (${stageShortLabel('DQL', 'DQL')} / PP) and conversion per designer.`}
            onExport={() => doExport('designer_performance')}
          >
            {r.designer_performance?.loading ? <Loader /> : designerRows.length === 0 ? <EmptyState msg="No designer data" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100">
                      {[['designer','Designer'],['leads','Assigned'],['dqlsDone',`${stageShortLabel('DQL', 'DQL')}s`],['ppsDone','PPs'],['onboardings','Onboarded'],['conversionPct','Conv. %']].map(([k, l]) => (
                        <th key={k} className="text-left py-2 px-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">{l}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {[...designerRows].sort((a, b) => (b.leads as number) - (a.leads as number)).map((row, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="py-2.5 px-2">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-brand-100 flex items-center justify-center shrink-0">
                              <span className="text-[9px] font-bold text-brand-700">{String(row.designer)[0]?.toUpperCase()}</span>
                            </div>
                            <span className="text-gray-800 font-medium">{String(row.designer)}</span>
                          </div>
                        </td>
                        <td className="py-2.5 px-2 text-gray-700">{String(row.leads)}</td>
                        <td className="py-2.5 px-2 text-gray-700">{String(row.dqlsDone)}</td>
                        <td className="py-2.5 px-2 text-gray-700">{String(row.ppsDone)}</td>
                        <td className="py-2.5 px-2 text-gray-700">{String(row.onboardings)}</td>
                        <td className="py-2.5 px-2 font-medium text-gray-800">
                          {typeof row.conversionPct === 'number' ? row.conversionPct.toFixed(1) + '%' : pct(row.onboardings as number, row.leads as number)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
          </Tile>
          )}

          {/* ═══ SECTION 3 — MONTHLY TREND (all roles) ═══════════════════════ */}
          {!isDesigner && !isBL && (
          <Tile id="reports.monthlyTrend">
          <SectionCard
            title={reportLabel('reports.monthlyTrend', 'Monthly trend')}
            subtitle="New leads each month, by origin date (the day the lead came in)."
            onExport={() => doExport('monthly_trend')}
          >
            {r.monthly_trend?.loading ? <Loader /> : monthlyRaw.length === 0 ? <EmptyState msg="No monthly data" /> : (
              <>
                <div className="flex items-center gap-1 mb-3">
                  {(['monthly', 'quarterly', 'annual'] as const).map((v) => (
                    <button key={v} onClick={() => setTrendView(v)}
                      className={`text-xs font-medium px-2.5 py-1 rounded-lg capitalize transition-colors ${trendView === v ? 'bg-brand-500 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>
                      {v.charAt(0).toUpperCase() + v.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-5">
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={trendData} margin={{ top: 4, right: 4, left: -20, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                      <XAxis dataKey="label" tick={{ fontSize: 9 }} />
                      <YAxis tick={{ fontSize: 9 }} allowDecimals={false} />
                      <Tooltip contentStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="leads" stroke={BRAND} strokeWidth={2} dot={{ r: 4 }} name="Leads" />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="overflow-x-auto self-start">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-gray-100">
                          <th className="text-left py-2 px-2 text-[10px] font-semibold text-gray-400 uppercase">Month</th>
                          <th className="text-right py-2 px-2 text-[10px] font-semibold text-gray-400 uppercase">Leads received</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {trendData.map((row, i) => (
                          <tr key={i} className="hover:bg-gray-50">
                            <td className="py-2 px-2 text-gray-700">{row.label}</td>
                            <td className="py-2 px-2 text-right font-medium text-gray-800">{row.leads}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}
          </SectionCard>
          </Tile>
          )}

          {/* ═══ SECTION 4 — OFFER PERFORMANCE (full only) ═══════════════════ */}
          {showFull && !isBL && (
            <Tile id="reports.offerPerformance">
            <SectionCard
              title={reportLabel('reports.offerPerformance', 'Offer performance')}
              subtitle="Leads tagged to each promotional offer and how many onboarded."
              onExport={() => doExport('offer_performance')}
            >
              {r.offer_performance?.loading ? <Loader /> : offerRows.length === 0 ? <EmptyState msg="No offers have been applied to leads yet." /> : (
                <div className="space-y-2">
                  {offerRows.map((row, i) => {
                    const maxVal = Math.max(...offerRows.map((r) => (r.total as number) || 0), 1);
                    const w = Math.max(((row.total as number) / maxVal) * 100, 4);
                    return (
                      <div key={i} className="flex items-center gap-3">
                        <div className="w-36 text-xs text-gray-700 text-right shrink-0 truncate" title={String(row.offer)}>{String(row.offer)}</div>
                        <div className="flex-1 bg-gray-100 rounded-full h-6 relative">
                          <div
                            className="h-6 rounded-full flex items-center px-2"
                            style={{ width: `${w}%`, backgroundColor: BRAND, minWidth: '2rem' }}
                          >
                            <span className="text-[10px] text-white font-bold whitespace-nowrap">{String(row.total)}</span>
                          </div>
                        </div>
                        <div className="w-16 text-xs text-gray-400 shrink-0">{typeof row.conversionPct === 'number' ? row.conversionPct.toFixed(1) + '% conv.' : ''}</div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>
            </Tile>
          )}

          {/* ═══ SECTION 5 — CAMPAIGN PERFORMANCE (full only) ════════════════ */}
          {showFull && !isBL && (
            <Tile id="reports.campaignPerformance">
            <SectionCard
              title={reportLabel('reports.campaignPerformance', 'Campaign performance')}
              subtitle="Which Meta and Google campaigns are generating the best leads."
              onExport={() => doExport('campaign_performance')}
            >
              {r.campaign_performance?.loading ? <Loader /> : campaignRows.length === 0 ? <EmptyState msg="No UTM campaign data available yet." /> : (
                <MiniTable
                  headers={[
                    { key: 'campaign', label: 'Campaign' },
                    { key: 'total', label: 'Leads' },
                    { key: 'onboarding', label: 'Onboarded' },
                    { key: 'conversionPct', label: 'Conv. %' },
                  ]}
                  rows={campaignRows.map((row) => ({
                    ...row,
                    conversionPct: typeof row.conversionPct === 'number' ? row.conversionPct.toFixed(1) + '%' : '—',
                  }))}
                />
              )}
            </SectionCard>
            </Tile>
          )}

          {/* ═══ SECTION 6 — MEETING PERFORMANCE (all roles) ════════════════ */}
          {!isDesigner && !isBL && (
          <Tile id="reports.meetingPerformance">
          <SectionCard
            title={reportLabel('reports.meetingPerformance', 'Meeting performance')}
            subtitle="Meetings scheduled vs completed vs no-show per designer."
            onExport={() => doExport('meeting_performance')}
          >
            {r.meeting_performance?.loading ? <Loader /> : meetingRows.length === 0 ? <EmptyState msg="No meeting data" /> : (
              <MiniTable
                headers={[
                  { key: 'designer', label: 'Designer' },
                  { key: 'scheduled', label: 'Scheduled' },
                  { key: 'completed', label: 'Completed' },
                  { key: 'rescheduled', label: 'Rescheduled' },
                  { key: 'noShow', label: 'No-Show' },
                  { key: '_completionRate', label: 'Completion Rate %' },
                ]}
                rows={meetingRows.map((row) => ({
                  ...row,
                  _completionRate: typeof row.completionPct === 'number'
                    ? row.completionPct.toFixed(1) + '%'
                    : pct(row.completed as number, row.scheduled as number),
                }))}
              />
            )}
          </SectionCard>
          </Tile>
          )}

          {/* ═══ SECTION 7 — INACTIVE LEADS (full only) ══════════════════════ */}
          {showFull && (
            <Tile id="reports.inactiveLeads">
            <SectionCard
              title={reportLabel('reports.inactiveLeads', 'Inactive leads')}
              subtitle="Leads that dropped off, at which stage, and why."
              onExport={() => doExport('inactive_leads')}
            >
              {r.inactive_leads?.loading ? <Loader /> : (
                <>
                  {inactiveSummary.totalInactivated !== undefined && (
                    <div className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 mb-3">
                      <span className="font-semibold text-gray-800">{inactiveSummary.totalInactivated ?? 0}</span> leads inactivated
                      {' · '}
                      <span className="font-semibold text-gray-800">{inactiveSummary.responseRate ?? 0}%</span> feedback response rate
                    </div>
                  )}
                  {inactiveRows.length === 0 ? <EmptyState msg="No inactive leads in this period." /> : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-gray-100">
                            {['Lead ID','Name','Stage','Reason','Feedback Received','Feedback Response'].map((h) => (
                              <th key={h} className="text-left py-2 px-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wide whitespace-nowrap">{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-50">
                          {inactiveRows.map((row: any, i: number) => (
                            <tr key={i} className="hover:bg-gray-50">
                              <td className="py-2.5 px-2 font-mono text-gray-500">{String(row.leadId ?? '—')}</td>
                              <td className="py-2.5 px-2 text-gray-800 font-medium">{String(row.name ?? '—')}</td>
                              <td className="py-2.5 px-2 text-gray-600">{stageShortLabel(String(row.stage), STAGE_LABEL_SHORT[row.stage])}</td>
                              <td className="py-2.5 px-2 text-gray-600">{String(row.reason ?? '—')}</td>
                              <td className="py-2.5 px-2">
                                {row.feedbackFormSentAt ? (
                                  <span className="bg-green-100 text-green-700 text-[10px] font-medium px-1.5 py-0.5 rounded-full">Yes</span>
                                ) : (
                                  <span className="bg-gray-100 text-gray-500 text-[10px] font-medium px-1.5 py-0.5 rounded-full">No</span>
                                )}
                              </td>
                              <td className="py-2.5 px-2 text-gray-600">{row.feedbackResponse ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </SectionCard>
            </Tile>
          )}

          {role === 'BRANCH_HEAD' && <DesignerReports role={role} />}
          {role === 'BRANCH_HEAD' && <BlAdminReports role={role} />}
          {showFull && (
            <Tile id="reports.credits">
            <SectionCard title={reportLabel('reports.credits', isBL ? 'BL & Team Credits' : 'Designer credits')} subtitle={isBL ? 'Your BL credit status and your team designers’ earned credits are shown separately.' : `Core and booster credits per designer for a ${cycleDescription()} cycle. Attendance credit is approved here.`}>
              <CreditsPanel showTitle={false} />
            </SectionCard>
            </Tile>
          )}

          </TileGroup>

          {/* ═══ SECTION 8 — COLLAPSIBLE REPORTS ════════════════════════════ */}
          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Additional Reports</p>
            <TileGroup dashboard="reports" className="space-y-3">

            {/* BL Performance (BH only; BL sees it in BL Reports) */}
            {showFull && !isBL && (
              <Tile id="reports.blPerformance">
              <CollapsibleCard
                title={reportLabel('reports.blPerformance', 'BL performance')}
                subtitle="Leads managed, closures, and discount metrics per Branch Lead."
                onExport={() => doExport('bl_performance')}
              >
                {r.bl_performance?.loading ? <Loader /> : (
                  <MiniTable
                    headers={[
                      { key: 'bl', label: 'BL Name' },
                      { key: 'leadsManaged', label: 'Leads Managed' },
                      { key: 'closed', label: 'Closed' },
                      { key: 'discountRequested', label: 'Discount Requests' },
                      { key: 'discountApproved', label: 'Approved' },
                      { key: 'discountRejected', label: 'Rejected' },
                    ]}
                    rows={blRows}
                  />
                )}
              </CollapsibleCard>
              </Tile>
            )}

            {/* Sales Cycle */}
            {!isDesigner && !isBL && (
            <Tile id="reports.salesCycle">
            <CollapsibleCard
              title={reportLabel('reports.salesCycle', 'Sales cycle')}
              subtitle="Average, fastest and slowest days from lead creation to onboarding."
              onExport={() => doExport('sales_cycle')}
            >
              {r.sales_cycle?.loading ? <Loader /> : (
                <MiniTable
                  headers={[
                    { key: 'metric', label: 'Metric' },
                    { key: 'avgDays', label: 'Avg Days' },
                    { key: 'fastestDays', label: 'Fastest' },
                    { key: 'slowestDays', label: 'Slowest' },
                  ]}
                  rows={salesCycleRows}
                />
              )}
            </CollapsibleCard>
            </Tile>
            )}

            {/* Lead Aging */}
            <Tile id="reports.timelinePerformance">
            <CollapsibleCard
              title={reportLabel('reports.timelinePerformance', 'Timeline performance')}
              subtitle="Average days per stage transition."
              onExport={() => doExport('timeline_performance')}
            >
              {r.timeline_performance?.loading ? <Loader /> : (
                <MiniTable
                  headers={[
                    { key: 'metric', label: 'Metric' },
                    { key: 'avg', label: 'Avg Days', naReason: 'no lead has completed this transition' },
                    { key: 'min', label: 'Min', naReason: 'no lead has completed this transition' },
                    { key: 'max', label: 'Max', naReason: 'no lead has completed this transition' },
                  ]}
                  rows={timelineRows}
                />
              )}
            </CollapsibleCard>
            </Tile>

            {/* Timeline Performance */}
            <Tile id="reports.leadAging">
            <CollapsibleCard
              title={reportLabel('reports.leadAging', 'Lead aging')}
              subtitle="Leads currently past their SLA threshold."
              onExport={() => doExport('lead_aging')}
            >
              {r.lead_aging?.loading ? <Loader /> : (
                <MiniTable
                  headers={[
                    { key: 'leadId', label: 'Lead ID' },
                    { key: 'name', label: 'Name' },
                    { key: '_stage', label: 'Stage' },
                    { key: 'daysInStage', label: 'Days in Stage' },
                    { key: 'slaThreshold', label: 'SLA Threshold' },
                    { key: 'overdueDays', label: 'Overdue Days' },
                  ]}
                  rows={agingRows.map((row) => ({
                    ...row,
                    _stage: stageShortLabel(String(row.stage as string), STAGE_LABEL_SHORT[row.stage as string]),
                  }))}
                />
              )}
            </CollapsibleCard>
            </Tile>

            {/* Conversion Funnel Detail */}
            {!isDesigner && !isBL && (
            <Tile id="reports.conversionDetail">
            <CollapsibleCard
              title={reportLabel('reports.conversionDetail', 'Conversion funnel detail')}
              subtitle="Stage-by-stage conversion rates."
              onExport={() => doExport('conversion')}
            >
              {r.conversion?.loading ? <Loader /> : (
                <MiniTable
                  headers={[
                    { key: '_from', label: 'Stage' },
                    { key: '_to', label: 'To' },
                    { key: 'fromCount', label: 'Leads' },
                    { key: 'toCount', label: 'Converted' },
                    { key: '_rate', label: 'Conversion %' },
                  ]}
                  rows={conversionRows.map((row) => ({
                    ...row,
                    _from: stageShortLabel(String(row.from as string), STAGE_LABEL_SHORT[row.from as string]),
                    _to: stageShortLabel(String(row.to as string), STAGE_LABEL_SHORT[row.to as string]),
                    _rate: typeof row.rate === 'number' ? row.rate.toFixed(1) + '%' : '—',
                  }))}
                />
              )}
            </CollapsibleCard>
            </Tile>
            )}
            </TileGroup>
          </div>

          <TileGroup dashboard="reports">
          {isDesigner && (
          <Tile id="reports.clientHealth">
          <SectionCard
            id="client-health"
            title={reportLabel('reports.clientHealth', 'Client health')}
            subtitle="Detailed health status from qualified lead through active project delivery."
            onExport={designerReport?.clientHealth ? () => downloadCsv('client_health', [
              ...designerReport.clientHealth.leads.map((l) => ({ Type: 'Lead', Client: l.clientName, 'Lead ID': l.leadId, 'Stage / project': stageLabel(l.stage), Health: l.health, Alerts: l.attentionCount })),
              ...designerReport.clientHealth.projects.map((p) => ({ Type: 'Project', Client: p.clientName, 'Lead ID': p.leadId, 'Stage / project': p.projectCode, Health: p.health, Alerts: p.attentionCount })),
            ]) : undefined}
          >
            {r.designer_incentive?.loading ? <Loader /> : !designerReport?.clientHealth ? (
              <EmptyState msg="Client health data is not available." />
            ) : (
              <div className="space-y-6">
                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Lead health · MQL to onboarding</h3>
                    <span className="text-xs text-gray-400">{designerReport.clientHealth.leads.length} active</span>
                  </div>
                  {designerReport.clientHealth.leads.length === 0 ? (
                    <EmptyState msg="No active pre-project clients." />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {designerReport.clientHealth.leads.map((lead) => (
                        <Link
                          key={lead.id}
                          to={`/leads/${lead.leadDbId}`}
                          className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 transition-colors hover:bg-gray-50"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-gray-900">{lead.clientName}</p>
                            <p className="mt-0.5 text-xs text-gray-400">Lead · {stageShortLabel(String(lead.stage), STAGE_LABEL_SHORT[lead.stage])}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {lead.attentionCount > 0 && <span className="text-xs font-semibold text-red-500">{lead.attentionCount} alert{lead.attentionCount === 1 ? '' : 's'}</span>}
                            <HealthPill health={lead.health} />
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </section>

                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Project health · Design in progress onwards</h3>
                    <span className="text-xs text-gray-400">{designerReport.clientHealth.projects.length} active</span>
                  </div>
                  {designerReport.clientHealth.projects.length === 0 ? (
                    <EmptyState msg="No active design projects." />
                  ) : (
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {designerReport.clientHealth.projects.map((project) => (
                        <Link
                          key={project.id}
                          to={`/leads/${project.leadDbId}`}
                          className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 p-3 transition-colors hover:bg-gray-50"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-gray-900">{project.clientName}</p>
                            <p className="mt-0.5 text-xs text-gray-400">{project.projectCode}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {project.attentionCount > 0 && <span className="text-xs font-semibold text-red-500">{project.attentionCount} alert{project.attentionCount === 1 ? '' : 's'}</span>}
                            <HealthPill health={project.health} />
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </SectionCard>
          </Tile>
          )}
          </TileGroup>

        </div>
      </div>
    </div>
  );
}
