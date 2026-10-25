import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Phone, RefreshCw, CheckCircle2, Wrench } from 'lucide-react';
import {
  BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { api } from '../lib/api';
import { getStoredUser } from '../lib/auth';
import DesignerDashboard from './DesignerDashboard';
import BLTeamDashboard from './BLTeamDashboard';
import CREDashboard from './CREDashboard';

interface NpsBreakdown {
  salesNps: number | null;
  obNps: number | null;
  designFreezeNps: number | null;
  signOffNps: number | null;
}

interface DashboardData {
  totalLeads: number;
  activeLeads: number;
  activeLeadsValue?: number;
  activeProjectsDip?: { count: number; value: number };
  pipelineValue: number;
  avgNPS: number | null;
  npsBreakdown?: NpsBreakdown;
  collectedThisMonth: number;
  outstanding: number;
  inDelivery: { count: number; contractValueSum: number };
  needsAttention: { projectId: string; projectCode: string; clientName: string; leadId: string; category: string; description: string; daysOverdue: number }[];
  needsAttentionTotal: number;
  collectionsDue: { projectId: string; clientName: string; milestone: string; amount: number; dueDate?: string; status?: string }[];
  phaseLoad: { phase: string; count: number; valueSum: number }[];
  stageFunnel: { stage: string; count: number }[];
  sourceBreakdown: { source: string; count: number }[];
  conversionRates: { mqlToDql: number; dqlToPr: number; prToPp: number; ppToPd: number; pdToOb: number; obToObm: number; obmToDip: number };
  stageConversion?: {
    stage: string;
    count: number;
    reachedCount: number;
    pct: number;
    avgTatDays: number | null;
    tatSampleSize: number;
  }[];
  totalLeadsReceived?: number;
  slaBreaches: { activeCount: number; list: { id: string; rule: string; breachedAt: string; lead: { id: string; leadId: string; name: string; stage: string } }[] };
  teamActivity: { callsToday: number; stagesMovedToday: number; tasksCompletedToday: number };
  leadsToday?: number;
  leadsThisWeek?: number;
  leadsThisMonth?: number;
  obProgress?: { count: number; value: number };
  revenueGenerated?: number;
  medal?: { role: string; cycle: { label: string }; score: number | null; medal: 'GOLD' | 'SILVER' | 'BRONZE' | null; salesPct?: number | null; designDipPct?: number | null; teamSize?: number; dipActual?: number; dipTarget?: number | null };
}

const fmt = (n: number) => {
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n > 0) return `₹${n.toLocaleString('en-IN')}`;
  return '₹0';
};

// EFFECTIVE_LEAD/HANDED_OVER kept only for legacy leads — no longer part of
// the active funnel (see .agents/memory/funnel-restructure.md).
// Short labels used ONLY in the pipeline bar-chart axis (space-constrained).
// Full label is 'PD (Pitch Discussion)' — see LeadList.tsx / LeadDetail.tsx STAGE_LABELS.
const STAGE_LABELS: Record<string, string> = {
  EFFECTIVE_LEAD: 'Eff. Lead', MQL: 'MQL', DQL: 'DQL',
  PROPOSAL_READY: 'Prop. Ready', PROPOSAL_PRESENTED: 'Prop. Done',
  PROPOSAL_DISCUSSION: 'PD', /* chart axis abbreviation — full label is 'PD (Pitch Discussion)' */
  ONBOARDING: 'Onboarding',
  ONBOARDING_MEETING: 'Onboarding Mtg', DESIGN_IN_PROGRESS: 'Design in Progress',
  HANDED_OVER: 'Handed Over',
};
const STAGE_COLORS: Record<string, string> = {
  EFFECTIVE_LEAD: '#6366f1', MQL: '#8b5cf6', DQL: '#d946ef',
  PROPOSAL_READY: '#f59e0b', PROPOSAL_PRESENTED: '#f97316',
  PROPOSAL_DISCUSSION: '#a855f7', ONBOARDING: '#22c55e',
  ONBOARDING_MEETING: '#14b8a6', DESIGN_IN_PROGRESS: '#059669',
  HANDED_OVER: '#06b6d4',
};
const PIE_COLORS = ['#d95f32', '#f97316', '#f59e0b', '#6366f1', '#8b5cf6', '#22c55e', '#06b6d4'];
const PHASE_COLORS: Record<string, string> = {
  DESIGN: '#6366f1', TECHNICAL: '#8b5cf6', PRODUCTION: '#f59e0b',
  EXECUTION: '#f97316', HANDOVER: '#22c55e', COMPLETED: '#0d9488',
};
const RISK_COLORS: Record<string, string> = {
  Delayed: 'bg-red-100 text-red-700', 'At Risk': 'bg-amber-100 text-amber-700',
  Blocked: 'bg-rose-100 text-rose-700',
};
const RULE_LABELS: Record<string, string> = {
  FIRST_CONTACT: 'First contact >24h', LEAD_TO_MQL: 'Lead→MQL >5d (legacy EL)',
  MQL_TO_DQL: 'MQL→DQL >5d', PROPOSAL_TO_PP: 'Proposal→PP >2d',
  FIRST_CONTACT_24H: 'First contact >24h', LEAD_TO_MQL_5D: 'Lead→MQL >5d (legacy EL)',
  MQL_TO_DQL_5D: 'MQL→DQL >5d', PROPOSAL_TO_PP_2D: 'Proposal→PP >2d',
};

function SkeletonCard() {
  return <div className="h-28 rounded-2xl animate-pulse" style={{ background: '#EDE8E3' }} />;
}

function KPICard({ label, value, sub, accent = false, to, links }: {
  label: string; value: string | number; sub?: string; accent?: boolean; to?: string;
  // Use `links` instead of `to` when a single tile aggregates more than one
  // underlying population (e.g. "Needs Attention" = flagged projects + SLA
  // leads) — a single link can only point at one of them, silently hiding
  // the other, so each contributing count gets its own drill-through link.
  links?: { label: string; to: string }[];
}) {
  const className = `rounded-2xl p-5 shadow-warm-sm ${accent ? 'border border-brand-200' : ''} ${to ? 'block cursor-pointer transition-transform hover:-translate-y-0.5 hover:shadow-warm' : ''}`;
  const style = accent
    ? { background: '#FEF0E8', border: '1px solid #f6ccb8' }
    : { background: '#fff', border: '1px solid #EDE8E3' };

  if (links?.length) {
    return (
      <div className={`rounded-2xl p-5 shadow-warm-sm ${accent ? 'border border-brand-200' : ''}`} style={style}>
        <p className={`text-2xl font-extrabold tracking-tight ${accent ? 'text-brand-700' : 'text-stone-900'}`}>{value}</p>
        <p className={`text-sm font-semibold mt-1 ${accent ? 'text-brand-600' : 'text-stone-700'}`}>{label}</p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1">
          {links.map((l) => (
            <Link key={l.to} to={l.to} className="text-xs text-brand-600 hover:text-brand-700 underline underline-offset-2 leading-snug">
              {l.label}
            </Link>
          ))}
        </div>
      </div>
    );
  }

  const content = (
    <>
      <p className={`text-2xl font-extrabold tracking-tight ${accent ? 'text-brand-700' : 'text-stone-900'}`}>{value}</p>
      <p className={`text-sm font-semibold mt-1 ${accent ? 'text-brand-600' : 'text-stone-700'}`}>{label}</p>
      {sub && <p className="text-xs text-stone-400 mt-0.5 leading-snug">{sub}</p>}
    </>
  );
  return to
    ? <Link to={to} className={className} style={style}>{content}</Link>
    : <div className={className} style={style}>{content}</div>;
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-3">
      <p className="text-xs font-bold text-stone-400 uppercase tracking-widest">{title}</p>
      <div className="flex-1 h-px" style={{ background: '#EDE8E3' }} />
    </div>
  );
}

function MedalCard({ medal }: { medal?: DashboardData['medal'] }) {
  return <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
    <p className="text-xs font-bold uppercase tracking-widest text-stone-400">Monthly Medal · {medal?.cycle.label ?? 'Current cycle'}</p>
    <div className="flex items-end justify-between gap-4 mt-2"><div><p className="text-xl font-extrabold text-stone-900">{medal?.medal ? `${medal.medal[0]}${medal.medal.slice(1).toLowerCase()} Medal` : 'No medal yet'}</p><p className="text-xs text-stone-500 mt-1">{medal?.role === 'DESIGN_MANAGER' ? 'Team Design/DIP %' : 'Sales %'}</p></div><p className="text-3xl font-extrabold text-brand-600">{medal?.score != null ? `${medal.score}%` : '—'}</p></div>
  </div>;
}

function hoursOverdue(breachedAt: string) {
  return Math.floor((Date.now() - new Date(breachedAt).getTime()) / 3600000);
}

// ── Branch Head / Admin layout ────────────────────────────────────────────────

function BHDashboard({ data }: { data: DashboardData }) {
  const funnelData = data.stageFunnel.map((s) => ({
    stage: STAGE_LABELS[s.stage] ?? s.stage,
    count: s.count,
    fill: STAGE_COLORS[s.stage] ?? '#d95f32',
  }));

  const totalSource = data.sourceBreakdown.reduce((a, s) => a + s.count, 0);

  const attentionCount = data.needsAttentionTotal;
  const slaCount = data.slaBreaches.activeCount;

  return (
    <div className="space-y-6">
      {/* Row 1 – KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KPICard
          label="Sales Pipeline"
          value={fmt(data.pipelineValue)}
          sub={`${data.activeLeads} active leads, est. value`}
          accent
          to="/leads?status=ACTIVE&excludeStages=DESIGN_IN_PROGRESS,HANDED_OVER"
        />
        <KPICard
          label="Active Leads"
          value={data.activeLeads}
          sub={`${fmt(data.activeLeadsValue ?? 0)} estimated value`}
          to="/leads?status=ACTIVE&excludeStages=DESIGN_IN_PROGRESS,HANDED_OVER"
        />
        <KPICard
          label="Active Projects"
          value={data.activeProjectsDip?.count ?? 0}
          sub={`${fmt(data.activeProjectsDip?.value ?? 0)} estimated value · in Design`}
          to="/projects?leadStage=DESIGN_IN_PROGRESS"
        />
        <KPICard
          label="In Delivery"
          value={data.inDelivery.count}
          sub={`${fmt(data.inDelivery.contractValueSum)} contract value in flight`}
          to="/projects?dashboardScope=true&excludePhases=HANDOVER,COMPLETED"
        />
        <KPICard
          label="Collected This Month"
          value={fmt(data.collectedThisMonth)}
          sub="Payments this calendar month"
          to="/collections?status=COLLECTED"
        />
        <KPICard
          label="Outstanding"
          value={fmt(data.outstanding)}
          sub="Yet to collect on delivery projects"
          to="/projects?dashboardScope=true&excludePhases=HANDOVER,COMPLETED&hasOutstanding=true"
        />
        <KPICard
          label="Needs Attention"
          value={attentionCount + slaCount}
          sub={`${attentionCount} project${attentionCount !== 1 ? 's' : ''} · ${slaCount} SLA lead${slaCount !== 1 ? 's' : ''}`}
          links={[
            ...(attentionCount > 0 ? [{ label: `${attentionCount} flagged project${attentionCount !== 1 ? 's' : ''}`, to: '/projects?dashboardScope=true&hasAttention=true' }] : []),
            ...(slaCount > 0 ? [{ label: `${slaCount} SLA-breached lead${slaCount !== 1 ? 's' : ''}`, to: '/leads?hasUnresolvedSlaBreach=true' }] : []),
          ]}
        />
        <KPICard
          label="NPS Score"
          value={data.avgNPS != null ? data.avgNPS.toFixed(1) : '—'}
          sub="Avg across touchpoints this month"
          to="/nps"
        />
      </div>

      {/* Row 1b – OB Progress + Revenue Generated (live data) + PO Progress + Incentive (pending) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* OB Progress: leads that completed OBM and are now in Design */}
        <div className="rounded-2xl p-5 shadow-warm-sm" style={{ background: 'white', border: '1px solid #EDE8E3' }}>
          <p className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1">OB Progress</p>
          <p className="text-2xl font-bold text-stone-900">{data.obProgress?.count ?? 0}</p>
          <p className="text-[11px] text-stone-500 mt-0.5">{fmt(data.obProgress?.value ?? 0)} · leads in Design</p>
        </div>
        {/* PO Progress – Coming Soon */}
        <div className="rounded-2xl p-5 shadow-warm-sm flex flex-col items-center justify-center text-center min-h-[112px]" style={{ background: '#FAF6F2', border: '1px dashed #EDE8E3' }}>
          <Wrench size={20} strokeWidth={1.5} className="text-stone-300 mb-1.5" />
          <p className="text-sm font-semibold text-stone-400">PO Progress</p>
          <p className="text-[10px] text-stone-400 mt-0.5">Coming Soon</p>
        </div>
        {/* Revenue Generated: total collected across all projects */}
        <div className="rounded-2xl p-5 shadow-warm-sm" style={{ background: 'white', border: '1px solid #EDE8E3' }}>
          <p className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide mb-1">Revenue Generated</p>
          <p className="text-2xl font-bold text-stone-900">{fmt(data.revenueGenerated ?? 0)}</p>
          <p className="text-[11px] text-stone-500 mt-0.5">Total collected</p>
        </div>
        {/* Estimated Incentive – Coming Soon */}
        <div className="rounded-2xl p-5 shadow-warm-sm flex flex-col items-center justify-center text-center min-h-[112px]" style={{ background: '#FAF6F2', border: '1px dashed #EDE8E3' }}>
          <Wrench size={20} strokeWidth={1.5} className="text-stone-300 mb-1.5" />
          <p className="text-sm font-semibold text-stone-400">Estimated Incentive</p>
          <p className="text-[10px] text-stone-400 mt-0.5">Coming Soon</p>
        </div>
      </div>

      {/* NPS breakdown by stage */}
      {data.npsBreakdown && (
        <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <h3 className="font-bold text-stone-900 mb-4 tracking-tight">Client Satisfaction by Stage</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: 'Sales', value: data.npsBreakdown.salesNps },
              { label: 'Onboarding', value: data.npsBreakdown.obNps },
              { label: 'Design Freeze', value: data.npsBreakdown.designFreezeNps },
              { label: 'Sign Off', value: data.npsBreakdown.signOffNps },
            ].map(({ label, value }) => {
              const color = value == null ? 'text-stone-300' : value >= 9 ? 'text-green-600' : value >= 7 ? 'text-amber-500' : 'text-red-500';
              return (
                <div key={label} className="text-center p-3 rounded-xl" style={{ background: '#FAF6F2' }}>
                  <p className={`text-2xl font-extrabold ${color}`}>{value != null ? value.toFixed(1) : '—'}</p>
                  <p className="text-xs text-stone-500 mt-1 font-medium">{label}</p>
                  <p className="text-[10px] text-stone-400">NPS · 0–10</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Row 2 – Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Pipeline funnel – horizontal bars */}
        <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <h3 className="font-bold text-stone-900 mb-4 tracking-tight">Pipeline Funnel</h3>
          {funnelData.every((d) => d.count === 0) ? (
            <div className="flex items-center justify-center h-44 text-gray-400 text-sm">No active leads</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={funnelData} layout="vertical" margin={{ left: 10, right: 20 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="stage" tick={{ fontSize: 11 }} width={72} />
                <Tooltip formatter={(v) => [v, 'Leads']} />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={18}>
                  {funnelData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Source mix – donut */}
        <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <h3 className="font-bold text-stone-900 mb-4 tracking-tight">Lead Sources</h3>
          {data.sourceBreakdown.length === 0 ? (
            <div className="flex items-center justify-center h-44 text-gray-400 text-sm">No source data</div>
          ) : (
            <div className="flex items-start gap-4">
              <div className="flex-1">
                <ResponsiveContainer width="100%" height={170}>
                  <PieChart>
                    <Pie
                      data={data.sourceBreakdown}
                      dataKey="count"
                      nameKey="source"
                      cx="50%" cy="50%"
                      innerRadius={45} outerRadius={75}
                    >
                      {data.sourceBreakdown.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(v, name) => [v, name]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-1.5 min-w-[120px] pt-2">
                {data.sourceBreakdown.map((s, i) => (
                  <div key={s.source} className="flex items-center gap-2 text-xs">
                    <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <span className="text-gray-600 truncate flex-1">{s.source.replace(/_/g, ' ')}</span>
                    <span className="text-gray-400 shrink-0">{totalSource > 0 ? Math.round(s.count / totalSource * 100) : 0}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Row 3 – Conversion + SLA breaches */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Stage conversion */}
        <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-bold text-stone-900 tracking-tight">Stage Conversion</h3>
            {(data.totalLeadsReceived ?? 0) > 0 && (
              <span className="text-[11px] text-stone-400">base: {data.totalLeadsReceived} received</span>
            )}
          </div>
          <p className="text-[10px] text-stone-400 mb-3">
            % = reached this stage or later ÷ total received · TAT = average stage entry − MQL received
          </p>
          <div className="space-y-3">
            {(data.stageConversion ?? []).map((r) => (
              <div key={r.stage} className="flex items-center gap-3">
                <span className="text-xs text-stone-500 w-28 shrink-0">{STAGE_LABELS[r.stage] ?? r.stage}</span>
                <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: '#EDE8E3' }}>
                  <div
                    className="h-full bg-brand-500 rounded-full transition-all"
                    style={{ width: `${Math.min(r.pct, 100)}%` }}
                  />
                </div>
                <span className="text-xs text-stone-400 w-14 text-right shrink-0" title={`${r.count} currently at this stage`}>
                  {r.reachedCount} reached
                </span>
                <span className="text-[11px] text-stone-400 w-14 text-right shrink-0">
                  {r.avgTatDays == null ? '— TAT' : `${r.avgTatDays.toFixed(1)}d`}
                </span>
                <span className="text-sm font-semibold text-brand-700 w-10 text-right shrink-0">{r.pct}%</span>
              </div>
            ))}
          </div>
        </div>

        {/* SLA breaches */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid #EDE8E3' }}>
            <h3 className="font-bold text-stone-900 flex items-center gap-2">
              SLA Breaches
              {data.slaBreaches.activeCount > 0 && (
                <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-0.5 rounded-full">
                  {data.slaBreaches.activeCount}
                </span>
              )}
            </h3>
          </div>
          {data.slaBreaches.activeCount === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-stone-400">
              <span className="text-2xl mb-1">✓</span>
              <p className="text-sm font-semibold text-stone-500">All clear</p>
              <p className="text-xs">No active SLA breaches</p>
            </div>
          ) : (
            <div className="max-h-52 overflow-y-auto">
              {data.slaBreaches.list.map((b) => (
                <div key={b.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-[#FAF6F2]" style={{ borderBottom: '1px solid #F5F0EB' }}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-900 truncate">
                      {b.lead.name}
                      <span className="text-stone-400 font-normal ml-1 text-xs">({b.lead.leadId})</span>
                    </p>
                    <p className="text-xs text-red-600">{RULE_LABELS[b.rule] ?? b.rule} · {hoursOverdue(b.breachedAt)}h overdue</p>
                  </div>
                  <Link
                    to={`/leads/${b.lead.id}`}
                    className="text-xs px-2.5 py-1 rounded-lg text-stone-600 shrink-0 ml-2 hover:bg-stone-100 transition-colors"
                    style={{ border: '1px solid #EDE8E3' }}
                  >
                    View →
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Row 4 – Activity feed */}
      <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
        <h3 className="font-bold text-stone-900 mb-4 tracking-tight">Today's Activity</h3>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Calls Logged', value: data.teamActivity.callsToday, Icon: Phone, bg: '#FEF0E8', color: 'text-brand-700' },
            { label: 'Stage Moves', value: data.teamActivity.stagesMovedToday, Icon: RefreshCw, bg: '#FDF6ED', color: 'text-amber-700' },
            { label: 'Tasks Completed', value: data.teamActivity.tasksCompletedToday, Icon: CheckCircle2, bg: '#F0FAF4', color: 'text-green-700' },
          ].map((item) => (
            <div key={item.label} className="rounded-2xl p-4" style={{ background: item.bg }}>
              <div className="mb-2"><item.Icon size={18} strokeWidth={1.8} /></div>
              <p className={`text-3xl font-extrabold tracking-tight ${item.color}`}>{item.value}</p>
              <p className={`text-xs font-semibold mt-0.5 ${item.color} opacity-80`}>{item.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── BL / Designer / CRE layout ─────────────────────────────────────────────

function BLDashboard({ data }: { data: DashboardData }) {
  const phaseData = data.phaseLoad.map((p) => ({
    phase: p.phase.charAt(0) + p.phase.slice(1).toLowerCase(),
    count: p.count,
    value: p.valueSum,
  }));

  const slaCount = data.slaBreaches?.activeCount ?? 0;
  const attentionCount = data.needsAttentionTotal;

  return (
    <div className="space-y-6">
      <MedalCard medal={data.medal} />
      {/* Row 1 – KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <KPICard
          label="Sales Pipeline"
          value={fmt(data.pipelineValue)}
          sub={`${data.activeLeads ?? 0} active leads in scope`}
          accent
          to="/leads?status=ACTIVE&excludeStages=DESIGN_IN_PROGRESS,HANDED_OVER"
        />
        <KPICard
          label="In Delivery"
          value={data.inDelivery.count}
          sub={`${fmt(data.inDelivery.contractValueSum)} in flight`}
          to="/projects?dashboardScope=true&excludePhases=HANDOVER,COMPLETED"
        />
        <KPICard
          label="Collected This Month"
          value={fmt(data.collectedThisMonth)}
          sub="Payments this calendar month"
          to="/collections?status=COLLECTED"
        />
        <KPICard
          label="Outstanding"
          value={fmt(data.outstanding)}
          sub="Yet to collect"
          to="/projects?dashboardScope=true&excludePhases=HANDOVER,COMPLETED&hasOutstanding=true"
        />
        <KPICard
          label="Needs Attention"
          value={attentionCount + slaCount}
          sub={`${attentionCount} project · ${slaCount} SLA`}
          links={[
            ...(attentionCount > 0 ? [{ label: `${attentionCount} flagged project${attentionCount !== 1 ? 's' : ''}`, to: '/projects?dashboardScope=true&hasAttention=true' }] : []),
            ...(slaCount > 0 ? [{ label: `${slaCount} SLA-breached lead${slaCount !== 1 ? 's' : ''}`, to: '/leads?hasUnresolvedSlaBreach=true' }] : []),
          ]}
        />
        <KPICard
          label="NPS"
          value={data.avgNPS != null ? data.avgNPS.toFixed(1) : '—'}
          sub="Avg score this month"
          to="/nps"
        />
      </div>

      {/* NPS breakdown by stage */}
      {data.npsBreakdown && (
        <div className="bg-white rounded-2xl p-4 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <h3 className="font-bold text-stone-900 mb-3 text-sm tracking-tight">Client Satisfaction by Stage</h3>
          <div className="grid grid-cols-4 gap-3">
            {[
              { label: 'Sales', value: data.npsBreakdown.salesNps },
              { label: 'Onboarding', value: data.npsBreakdown.obNps },
              { label: 'Design Freeze', value: data.npsBreakdown.designFreezeNps },
              { label: 'Sign Off', value: data.npsBreakdown.signOffNps },
            ].map(({ label, value }) => {
              const color = value == null ? 'text-stone-300' : value >= 9 ? 'text-green-600' : value >= 7 ? 'text-amber-500' : 'text-red-500';
              return (
                <div key={label} className="text-center p-2 rounded-xl" style={{ background: '#FAF6F2' }}>
                  <p className={`text-xl font-extrabold ${color}`}>{value != null ? value.toFixed(1) : '—'}</p>
                  <p className="text-[10px] text-stone-500 mt-0.5 font-medium">{label}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <SectionHeader title="Delivery" />

      {/* Row 2 – Phase load + Needs attention */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Phase load */}
        <div className="bg-white rounded-2xl p-5 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <h3 className="font-bold text-stone-900 mb-4 tracking-tight">Phase Load</h3>
          {phaseData.length === 0 ? (
            <div className="flex items-center justify-center h-44 text-gray-400 text-sm">No active projects</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={phaseData} margin={{ bottom: 4 }}>
                <XAxis dataKey="phase" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload;
                    return (
                      <div className="bg-white border border-gray-200 rounded-lg shadow px-3 py-2 text-xs">
                        <p className="font-semibold text-gray-900">{d.phase}</p>
                        <p className="text-gray-600">{d.count} project{d.count !== 1 ? 's' : ''}</p>
                        {d.value > 0 && <p className="text-gray-600">{fmt(d.value)} contract</p>}
                      </div>
                    );
                  }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={40}>
                  {phaseData.map((d, i) => (
                    <Cell key={i} fill={PHASE_COLORS[d.phase.toUpperCase()] ?? '#d95f32'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Needs attention */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: '1px solid #EDE8E3' }}>
            <h3 className="font-bold text-stone-900">Needs Attention</h3>
            {attentionCount > 0 && (
              <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-0.5 rounded-full">{attentionCount}</span>
            )}
          </div>
          {data.needsAttention.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <span className="text-2xl mb-1">✓</span>
              <p className="text-sm font-medium text-gray-500">All clear</p>
              <p className="text-xs">No flagged projects</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-52 overflow-y-auto">
              {data.needsAttention.map((item) => (
                <div key={item.projectId} className="px-4 py-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{item.clientName}</p>
                      <p className="text-xs text-gray-500">{item.projectCode} · Lead {item.leadId}</p>
                    </div>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${RISK_COLORS[item.category] ?? 'bg-gray-100 text-gray-600'}`}>
                      {item.category}
                    </span>
                  </div>
                  {item.description && (
                    <p className="text-xs text-gray-500 mt-1 truncate">{item.description}</p>
                  )}
                  {item.daysOverdue > 0 && (
                    <p className="text-xs text-red-500 mt-0.5">{item.daysOverdue}d past handover</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Row 3 – Collections due + Coming soon */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Collections due */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="px-5 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
            <h3 className="font-bold text-stone-900">Collections Due</h3>
          </div>
          {data.collectionsDue.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <span className="text-2xl mb-1">✓</span>
              <p className="text-sm font-medium text-gray-500">All clear</p>
              <p className="text-xs">No collections pending</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50 max-h-52 overflow-y-auto">
              {data.collectionsDue.map((item) => (
                <div key={item.projectId} className="px-4 py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{item.clientName}</p>
                    <p className="text-xs text-gray-500">{item.milestone}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-gray-900">{fmt(item.amount)}</p>
                    {item.status && (
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        item.status === 'Due' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'
                      }`}>
                        {item.status}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Site & service pulse — coming soon */}
        <div className="bg-white rounded-2xl p-5 shadow-warm-sm flex flex-col items-center justify-center text-center min-h-[180px]" style={{ border: '1px solid #EDE8E3' }}>
          <Wrench size={28} strokeWidth={1.5} className="text-stone-300 mb-2" />
          <h3 className="font-semibold text-stone-700 mb-1">Site & Service Pulse</h3>
          <p className="text-xs text-stone-400 max-w-[180px] leading-relaxed">
            Service & Warranty module is coming in a future release.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

// ── BH / BL dashboard shell (handles its own data-fetch) ─────────────────────
function BHBLDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const user = getStoredUser();
  const isBH = user?.role === 'BRANCH_HEAD' || user?.role === 'ADMIN';

  const load = useCallback((background = false) => {
    if (!background) setLoading(true);
    return api.get<DashboardData>('/dashboard')
      .then((d) => { setData(d); setError(null); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Keep dashboard numbers live without a manual reload: re-poll periodically
  // and whenever the tab regains focus/visibility, so a stage move or new
  // lead made elsewhere shows up here shortly after, not just on remount.
  useEffect(() => {
    const poll = () => load(true);
    const interval = setInterval(poll, 30000);
    const onFocus = () => poll();
    const onVisibility = () => { if (document.visibilityState === 'visible') poll(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Dashboard</h1>
          <p className="text-sm text-stone-400 mt-0.5">
            {isBH ? 'Branch overview — all teams' : `Your scope · ${user?.name ?? ''}`}
          </p>
        </div>
        <Link
          to="/reports"
          className="text-sm px-4 py-2 rounded-xl text-stone-600 hover:text-stone-900 transition-colors font-medium"
          style={{ border: '1px solid #EDE8E3', background: '#fff' }}
        >
          Full Reports →
        </Link>
      </div>

      {loading && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
            {[1,2,3,4,5,6].map((i) => <SkeletonCard key={i} />)}
          </div>
          <div className="grid grid-cols-2 gap-6">
            <div className="h-64 rounded-2xl animate-pulse" style={{ background: '#EDE8E3' }} />
            <div className="h-64 rounded-2xl animate-pulse" style={{ background: '#EDE8E3' }} />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-red-600 text-sm">{error}</div>
      )}

      {data && (isBH ? <BHDashboard data={data} /> : <BLDashboard data={data} />)}
    </div>
  );
}

// ── Main export — routes by role ───────────────────────────────────────────────
export default function Dashboard() {
  const user = getStoredUser();
  if (user?.role === 'CRE') return <CREDashboard />;
  const isDesigner = user?.role === 'DESIGNER';
  if (user?.role === 'BL') return <BLTeamDashboard teamExtras={<BHBLDashboard />} />;
  return isDesigner ? <DesignerDashboard /> : <BHBLDashboard />;
}
