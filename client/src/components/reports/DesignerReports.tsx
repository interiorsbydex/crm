import { useCallback, useEffect, useRef, useState } from 'react';
import { DateInput } from '../ui/DateTimeInputs';
import { useReportTabs } from '../../lib/dashboardLayout';
import { reportTabId, REPORT_BLOCK_IDS } from '../../lib/dashboardTiles';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { Table as ServerReportTable, type TableData } from './BlAdminReports';
import { stageLabel, cycleDescription } from '../../lib/crmSettings';
import { formulas } from '../../lib/formulas';

type DrillLead = { id: string; leadId: string; name: string; [k: string]: unknown };
type Designer = { id: string; name: string };

type PerfBlock = {
  cycle: { label: string };
  cancellationReview?: { id: string; leadId: string; name: string; reason: string }[];
  effort: {
    proposalPresentedCount: number;
    pitchCompletionDatesMissing?: number;
    leadToOnboardingTatAvgDays: number | null;
    onboardingWithin7DaysPct: number | null;
    onboardingWithin7DaysNumerator: number;
    averageNps: number | null;
    npsResponsesCounted: number;
  };
  result: {
    onboardingCount: number;
    onboardingsUsedInTat: number;
    onboardingsExcludedNoDipLog: number;
    bookingValue: number;
    bookingCount: number;
    leadsReceived: number;
    conversionPct: number | null;
  };
  target: { monthlyTarget: number | null; cumulativeAchievement: number; remainingTarget: number | null; note: string | null };
  drilldown: {
    onboardings: DrillLead[];
    bookings: DrillLead[];
    leadsReceived: DrillLead[];
    proposalPresented: DrillLead[];
  };
};
type PerfData = {
  blHeld?: {
    note: string;
    currentLeads: DrillLead[];
    statusCounts: { total: number; active: number; onHold: number; inactive: number };
    cycles: { cycleStart: string; leadsReceived: number; bookingValue: number | null; bookingReview: (DrillLead & { reason: string })[] }[];
  };
  scope: { designers: Designer[]; selectedDesignerIds: string[] };
  dashboardSnapshot: { label: string; onboardingCount: number };
  dipChecklistPending?: { id: string; leadId: string; name: string }[];
  mqlFallbackLeadsUsedInTat: number;
  blocks: PerfBlock[];
};

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;
const fmtDate = (v: unknown) => (typeof v === 'string' ? new Date(v).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—');

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900">{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-gray-500">{sub}</p>}
    </div>
  );
}

function DrillTable({ rows, extra }: { rows: DrillLead[]; extra?: { key: string; label: string; fmt?: (v: unknown) => string }[] }) {
  if (!rows.length) return <p className="py-2 text-xs text-gray-400">No leads.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-100 text-left text-gray-400">
          <th className="py-1.5 pr-3 font-medium">Client</th>
          <th className="py-1.5 pr-3 font-medium">Lead ID</th>
          {extra?.map((e) => <th key={e.key} className="py-1.5 pr-3 font-medium">{e.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} className="border-b border-gray-50">
            <td className="py-1.5 pr-3"><Link className="text-brand-600 hover:underline" to={`/leads/${r.id}`}>{r.name}</Link></td>
            <td className="py-1.5 pr-3 text-gray-500">{r.leadId}</td>
            {extra?.map((e) => <td key={e.key} className="py-1.5 pr-3">{e.fmt ? e.fmt(r[e.key]) : String(r[e.key] ?? '—')}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DrillToggle({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-gray-100">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-gray-700">
        <span>{label} ({count})</span><span>{open ? '−' : '+'}</span>
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function SectionBar({ tone, title, hint }: { tone: 'blue' | 'stone' | 'amber'; title: string; hint: string }) {
  const c = { blue: 'border-blue-400 text-blue-700', stone: 'border-stone-400 text-stone-700', amber: 'border-amber-400 text-amber-700' }[tone];
  return <p className={`border-l-4 pl-2 text-xs font-bold uppercase tracking-wider ${c}`}>{title} <span className="font-normal normal-case tracking-normal text-gray-400">· {hint}</span></p>;
}

function MyPerformance({ data, showBlBookingDefinition = false }: { data: PerfData; showBlBookingDefinition?: boolean }) {
  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
        {data.dashboardSnapshot.label}: <b>{data.dashboardSnapshot.onboardingCount}</b>. The cycle blocks below count only leads whose first Design-in-Progress entry falls in that cycle, and exclude test leads, so the numbers can differ.
        {' '}Leads using the lead-origin-date fallback for MQL date: {data.mqlFallbackLeadsUsedInTat}.
        {(data.dipChecklistPending?.length ?? 0) > 0 && (
          <div className="mt-1" data-testid="dip-pending-note">
            <b>{data.dipChecklistPending?.length}</b> lead(s) are in Design in Progress but their DIP checklist is not completed, so they are <b>not</b> counted as onboarded / booked below. Completed-checklist conversion also excludes them; current-stage Pipeline inventory still shows their actual stage:{' '}
            {(data.dipChecklistPending ?? []).map((l: { id: string; leadId: string }, i: number) => (
              <span key={l.id}>{i > 0 && ', '}<Link className="underline" to={`/leads/${l.id}`}>{l.leadId}</Link></span>
            ))}
          </div>
        )}
      </div>
      {showBlBookingDefinition && (
        <p className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-xs text-blue-900" data-testid="bl-booking-value-definition">
          BL booking value uses the recorded total project value after discount, excluding GST.
          Furniture is a separate reporting breakdown and is not deducted again.
          The report uses the recorded amount directly; it does not apply another discount or recalculate GST.
        </p>
      )}
      {showBlBookingDefinition && data.blHeld && (
        <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-4" data-testid="bl-held-performance">
          <h3 className="text-sm font-semibold text-gray-800">BL-held leads — no assigned Designer</h3>
          <p className="text-xs text-gray-500">{data.blHeld.note}</p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Current BL-held leads" value={String(data.blHeld.statusCounts.total)} />
            <Stat label="Active" value={String(data.blHeld.statusCounts.active)} />
            <Stat label="On Hold" value={String(data.blHeld.statusCounts.onHold)} />
            <Stat label="Inactive" value={String(data.blHeld.statusCounts.inactive)} />
          </div>
          <DrillToggle label="Current BL-held leads" count={data.blHeld.currentLeads.length}>
            <DrillTable rows={data.blHeld.currentLeads} extra={[{ key: 'stage', label: 'Current stage' }, { key: 'status', label: 'Current status' }]} />
          </DrillToggle>
        </section>
      )}
      {data.blocks.map((b, index) => (
        <div key={b.cycle.label} className="space-y-3">
          <p className="text-sm font-semibold text-gray-800">Cycle: {b.cycle.label}</p>
          {showBlBookingDefinition && data.blHeld?.cycles[index] && (
            <div className="space-y-2 rounded-xl border border-gray-200 bg-white p-3" data-testid="bl-held-cycle">
              <p className="text-xs font-semibold text-gray-700">BL-held performance — separate from Designer totals below</p>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Current BL-held leads dated in cycle" value={String(data.blHeld.cycles[index].leadsReceived)}
                  sub="Uses the lead-origin date, not a verified historical BL assignment date." />
                <Stat label="BL-held eligible booking value" value={data.blHeld.cycles[index].bookingValue == null ? 'N/A' : inr(data.blHeld.cycles[index].bookingValue!)}
                  sub={data.blHeld.cycles[index].bookingValue == null ? 'Booking ownership needs verification; not added to achievement.' : 'No BL-held booking records awaiting ownership review in this cycle.'} />
              </div>
              <DrillToggle label="BL-held booking records requiring review" count={data.blHeld.cycles[index].bookingReview.length}>
                <DrillTable rows={data.blHeld.cycles[index].bookingReview} extra={[{ key: 'reason', label: 'Why not counted' }]} />
              </DrillToggle>
            </div>
          )}

          {!!b.cancellationReview?.length && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800" data-testid="performance-cancellation-review">
              Credit totals are unavailable pending review for historical cancellations. No estimated credit deductions are applied.
            </p>
          )}
          <SectionBar tone="blue" title="Effort" hint="What you did" />
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-blue-50/60 p-3 md:grid-cols-4">
            <Stat label="Proposal Presented" value={String(b.effort.proposalPresentedCount)} sub="Unique leads with a completed PP meeting in this cycle; lead must have reached PP" />
            <Stat label="Lead → Onboarding TAT (avg days)" value={b.effort.leadToOnboardingTatAvgDays == null ? 'N/A' : String(b.effort.leadToOnboardingTatAvgDays)} sub={b.effort.leadToOnboardingTatAvgDays == null ? 'No onboardings with a DIP log in this cycle' : `${b.result.onboardingsUsedInTat} onboardings used`} />
            <Stat label={`Onboarding within ${formulas().fastOnboardingDays} days`} value={b.effort.onboardingWithin7DaysPct == null ? 'N/A' : `${b.effort.onboardingWithin7DaysPct}%`} sub={b.effort.onboardingWithin7DaysPct == null ? 'No onboardings with a TAT in this cycle (zero denominator)' : `${b.effort.onboardingWithin7DaysNumerator} of ${b.result.onboardingsUsedInTat}`} />
            <Stat label="Average NPS" value={b.effort.averageNps == null ? 'N/A' : String(b.effort.averageNps)} sub={b.effort.averageNps == null ? 'No scored NPS responses in this cycle' : `${b.effort.npsResponsesCounted} scored responses`} />
          </div>
          {!!b.effort.pitchCompletionDatesMissing && (
            <p data-testid="pitch-completion-warning" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {b.effort.pitchCompletionDatesMissing} completed PP meeting(s) have no recorded completion date.
              They are excluded from dated pitch counts; scheduled and last-edited dates are not substituted.
            </p>
          )}

          <SectionBar tone="stone" title="Result" hint="What happened" />
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-stone-50 p-3 md:grid-cols-4">
            <Stat label="Onboarding count" value={String(b.result.onboardingCount)} sub={`Used in TAT: ${b.result.onboardingsUsedInTat} · Excluded (no DIP log, any period): ${b.result.onboardingsExcludedNoDipLog}`} />
            <Stat label="Booking Value" value={inr(b.result.bookingValue)} sub={`${b.result.bookingCount} bookings`} />
            <Stat label="Conversion" value={b.result.conversionPct == null ? '0%' : `${b.result.conversionPct}%`} sub={`${b.result.bookingCount} onboarded / ${b.result.leadsReceived} leads received this cycle${b.result.leadsReceived === 0 ? ' — no leads received yet, so there is nothing to divide by' : ''}`} />
          </div>

          <SectionBar tone="amber" title="Target" hint="Goal for this cycle" />
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-amber-50/70 p-3 md:grid-cols-4">
            <Stat label="Monthly Target" value={b.target.monthlyTarget == null ? 'N/A' : inr(b.target.monthlyTarget)} sub={b.target.monthlyTarget == null ? 'No target row for this designer for this cycle' : undefined} />
            <Stat label="Cumulative Achievement" value={inr(b.target.cumulativeAchievement)} />
            <Stat label="Remaining Target" value={b.target.remainingTarget == null ? 'N/A' : inr(b.target.remainingTarget)} sub={b.target.remainingTarget == null ? 'No target row for this cycle, so there is no target to subtract from' : undefined} />
          </div>

          <div className="space-y-2">
            <DrillToggle label="Onboardings" count={b.drilldown.onboardings.length}>
              <DrillTable rows={b.drilldown.onboardings} extra={[
                { key: 'mqlDate', label: 'MQL Date', fmt: fmtDate },
                { key: 'onboardingDate', label: 'Onboarding Date', fmt: fmtDate },
                { key: 'days', label: 'Days' },
              ]} />
            </DrillToggle>
            <DrillToggle label="Leads received" count={b.drilldown.leadsReceived.length}>
              <DrillTable rows={b.drilldown.leadsReceived} />
            </DrillToggle>
            <DrillToggle label="Proposal presented" count={b.drilldown.proposalPresented.length}>
              <DrillTable rows={b.drilldown.proposalPresented} />
            </DrillToggle>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Shared helpers for reports 2-6 ────────────────────────────────────────────
type Row = Record<string, any>;
const dash = (v: unknown) => (v == null ? 'N/A' : String(v));

function Note({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] leading-relaxed text-gray-600">{children}</div>;
}

type Col = { key: string; label: string; fmt?: (v: any, row: Row) => string };

/** Generic lead-level drill-down: lists rows with a link to the lead. */
function Drill({ rows, cols }: { rows: Row[]; cols?: Col[] }) {
  if (!rows?.length) return <p className="py-2 text-xs text-gray-400">No records.</p>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="border-b border-gray-100 text-left text-gray-400">
          <th className="py-1.5 pr-3 font-medium">Client</th>
          <th className="py-1.5 pr-3 font-medium">Lead ID</th>
          {cols?.map((c) => <th key={c.key} className="py-1.5 pr-3 font-medium">{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.id}-${i}`} className="border-b border-gray-50">
            <td className="py-1.5 pr-3"><Link className="text-brand-600 hover:underline" to={`/leads/${r.id}`}>{r.name}</Link></td>
            <td className="py-1.5 pr-3 text-gray-500">{r.leadId}</td>
            {cols?.map((c) => <td key={c.key} className="py-1.5 pr-3">{c.fmt ? c.fmt(r[c.key], r) : dash(r[c.key])}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const dateCol = (key: string, label: string): Col => ({ key, label, fmt: (v) => (v ? fmtDate(v) : '—') });

/** Table where a clickable cell opens a drill-down beneath it. */
function DrillTableCards({ title, rows, headers }: {
  title: string;
  rows: Row[];
  headers: { key: string; label: string; fmt?: (v: any, row: Row) => string; drill?: { path: (row: Row) => Row[]; cols?: Col[] } }[];
}) {
  const [open, setOpen] = useState<{ row: number; key: string } | null>(null);
  const active = open ? headers.find((h) => h.key === open.key) : null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-gray-800">{title}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-100 text-left text-gray-400">
              {headers.map((h) => <th key={h.key} className="py-1.5 pr-4 font-medium whitespace-nowrap">{h.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b border-gray-50">
                {headers.map((h) => {
                  const text = h.fmt ? h.fmt(r[h.key], r) : dash(r[h.key]);
                  const list = h.drill ? h.drill.path(r) : null;
                  return (
                    <td key={h.key} className="py-1.5 pr-4 whitespace-nowrap">
                      {list ? (
                        <button className="text-brand-600 underline decoration-dotted" onClick={() => setOpen(open && open.row === ri && open.key === h.key ? null : { row: ri, key: h.key })}>{text}</button>
                      ) : text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && active?.drill && (
        <div className="rounded-lg border border-gray-100 p-3">
          <p className="mb-2 text-xs font-medium text-gray-600">{active.label} — {rows[open.row][headers[0].key]}</p>
          <Drill rows={active.drill.path(rows[open.row])} cols={active.drill.cols} />
        </div>
      )}
    </div>
  );
}

const funnelRows = (data: Row): Row[] => data.stages.map((s: Row) => ({ ...s, stageLabel: s.label ?? stageLabel(s.stage) }));
type Hdr = { key: string; label: string; fmt?: (v: any, row: Row) => string; drill?: { path: (row: Row) => Row[]; cols?: Col[] } };
const funnelDrillCols: Col[] = [
  { key: 'currentStage', label: 'Current stage', fmt: (v) => stageLabel(v) },
  { key: 'status', label: 'Status', fmt: (v) => String(v ?? '').replace('_', ' ') },
  dateCol('reachedAt', 'Reached'),
  { key: 'tatDays', label: 'TAT (days)' },
];
const funnelDrill = (status?: string) => ({ path: (r: Row) => (status ? r.drilldown.filter((l: Row) => l.status === status) : r.drilldown), cols: funnelDrillCols });
const funnelHeaders: Hdr[] = [
  { key: 'stageLabel', label: 'Stage' },
  { key: 'total', label: 'Total', drill: funnelDrill() },
  { key: 'active', label: 'Active', drill: funnelDrill('ACTIVE') },
  { key: 'onHold', label: 'On Hold', drill: funnelDrill('ON_HOLD') },
  { key: 'inactive', label: 'Inactive / Dropped', drill: funnelDrill('INACTIVE') },
  { key: 'avgTatDays', label: 'Avg TAT (days, active)', fmt: (v) => (v == null ? '—' : `${v}`) },
  { key: 'progressionPct', label: 'Progression %', fmt: (v) => (v == null ? '—' : `${v}%`) },
];

function LeadFunnel({ data }: { data: Row }) {
  return (
    <div className="space-y-3">
      <Note>
        <b>How to read this:</b> {data.cohortRule}<br />
        Leads in view: {data.cohortSize} · Leads without stage history: <b>{data.leadsWithoutStageHistory}</b> · Leads using lead-origin-date fallback for MQL date: {data.mqlFallbackLeads}
      </Note>
      <DrillTableCards
        title="My Lead Funnel"
        rows={funnelRows(data)}
        headers={funnelHeaders}
      />
    </div>
  );
}

const meetingRows = (data: Row): Row[] => [...data.rows, { type: 'ALL TYPES', ...data.totals, drilldown: data.rows.flatMap((r: Row) => r.drilldown) }];
const meetingHeaders = (): Hdr[] => {
  const meetCols: Col[] = [dateCol('scheduledAt', 'Scheduled at'), { key: 'status', label: 'Status' }, { key: 'ppNumber', label: 'PP #', fmt: (v) => (v ? String(v) : '—') }];
  const sel = (status?: string) => ({ path: (r: Row) => (status ? r.drilldown.filter((m: Row) => m.status === status) : r.drilldown), cols: meetCols });
  return [
    { key: 'type', label: 'Meeting Type' },
    { key: 'totalScheduled', label: 'Total Scheduled', drill: sel() },
    { key: 'upcoming', label: 'Upcoming', drill: sel('SCHEDULED') },
    { key: 'completed', label: 'Completed', drill: sel('COMPLETED') },
    { key: 'noShow', label: 'No-Show', drill: sel('NO_SHOW') },
    { key: 'rescheduled', label: 'Rescheduled', drill: sel('RESCHEDULED') },
    { key: 'noShowPct', label: 'No-Show %', fmt: (v) => (v == null ? 'N/A (no meetings in period)' : `${v}%`) },
  ];
};

function MeetingPerf({ data }: { data: Row }) {
  const rows = meetingRows(data);
  return (
    <div className="space-y-3">
      <Note>Statuses counted — Total Scheduled: {data.statusesCounted.totalScheduled}; Upcoming: {data.statusesCounted.upcoming}; Completed: {data.statusesCounted.completed}; No-Show: {data.statusesCounted.noShow}; Rescheduled: {data.statusesCounted.rescheduled}. No-Show % = {data.noShowPctFormula}. Filtered by meetings.scheduledAt.</Note>
      {data.rows.length === 0 ? <p className="text-xs text-gray-400">No meetings in this period.</p> : (
        <DrillTableCards
          title="Meetings by type"
          rows={rows}
          headers={meetingHeaders()}
        />
      )}
    </div>
  );
}

function SalesCycle({ data }: { data: Row }) {
  const s = data.summary;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Onboardings in range" value={String(s.onboardingsInRange)} />
        <Stat label="Average days" value={dash(s.averageDays)} sub={s.averageDays == null ? 'No onboardings in this period' : 'MQL date → Onboarding date'} />
        <Stat label="Fastest (days)" value={dash(s.fastestDays)} sub={s.fastestDays == null ? 'No onboardings in this period' : undefined} />
        <Stat label="Slowest (days)" value={dash(s.slowestDays)} sub={s.slowestDays == null ? 'No onboardings in this period' : undefined} />
      </div>
      <Note>
        {data.pidStatus} Onboarding Date = first DESIGN_IN_PROGRESS log. Onboardings (dashboard condition) excluded for no DIP log: {data.onboardingsExcludedNoDipLog}. Leads using lead-origin-date fallback for MQL date: {data.mqlFallbackLeads}.
      </Note>
      {data.rows.length === 0 ? <p className="text-xs text-gray-400">No onboardings in this period.</p> : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-100 text-left text-gray-400">
              <th className="py-1.5 pr-3 font-medium">Client</th><th className="py-1.5 pr-3 font-medium">PID (Lead ID)</th>
              <th className="py-1.5 pr-3 font-medium">MQL Date</th><th className="py-1.5 pr-3 font-medium">Onboarding Date</th><th className="py-1.5 pr-3 font-medium">Days Taken</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r: Row) => (
              <tr key={r.id} className="border-b border-gray-50">
                <td className="py-1.5 pr-3"><Link className="text-brand-600 hover:underline" to={`/leads/${r.id}`}>{r.name}</Link></td>
                <td className="py-1.5 pr-3">{r.pid}</td>
                <td className="py-1.5 pr-3">{fmtDate(r.mqlDate)}{r.mqlFallback ? ' *' : ''}</td>
                <td className="py-1.5 pr-3">{fmtDate(r.onboardingDate)}</td>
                <td className="py-1.5 pr-3">{r.days}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-gray-400">* MQL date taken from lead origin date (no MQL log).</p>
    </div>
  );
}

const pct = (v: unknown) => (v == null ? '—' : `${v}%`);
const trendsHeaders = (): Hdr[] => {
  const dc = (key: string): Col[] => [dateCol('date', 'Date')].concat(key === 'mql' ? [{ key: 'mqlFallback', label: 'From origin date', fmt: (v: boolean) => (v ? 'yes' : 'no') }] : []);
  return [
    { key: 'label', label: `Cycle (${cycleDescription()})` },
    { key: 'mql', label: 'MQL', drill: { path: (r) => r.drilldown.mql, cols: dc('mql') } },
    { key: 'dql', label: 'DQL', drill: { path: (r) => r.drilldown.dql, cols: dc('dql') } },
    { key: 'dqlPct', label: 'DQL %', fmt: pct },
    { key: 'proposalPresented', label: 'Proposal Presented', drill: { path: (r) => r.drilldown.proposalPresented, cols: dc('pp') } },
    { key: 'proposalPresentedPct', label: 'PP %', fmt: pct },
    { key: 'obm', label: 'Onboarding (OB)', drill: { path: (r) => r.drilldown.obm, cols: dc('obm') } },
    { key: 'obmPct', label: 'Onboarding %', fmt: pct },
    { key: 'bookingValue', label: 'Booking Value (INR)', fmt: (v) => inr(Number(v)), drill: { path: (r) => r.drilldown.bookings, cols: [{ key: 'estimatedValue', label: 'Value', fmt: (v) => inr(Number(v)) }] } },
    { key: 'bookingTarget', label: 'Booking Target (INR)', fmt: (v) => (v == null ? 'No target set' : inr(Number(v))) },
    { key: 'bookingValuePct', label: 'Booking Value %', fmt: (v) => (v == null ? 'N/A (no target)' : `${v}%`) },
    { key: 'leadToOnboardingTatAvgDays', label: 'Lead→Onboarding TAT (days)', fmt: (v) => (v == null ? 'N/A (no onboardings in cycle)' : String(v)), drill: { path: (r) => r.drilldown.onboardings, cols: [dateCol('mqlDate', 'MQL Date'), dateCol('onboardingDate', 'Onboarding Date'), { key: 'days', label: 'Days' }] } },
  ];
};

function Trends({ data }: { data: Row }) {
  return (
    <div className="space-y-3">
      <Note>Each row is a target cycle ({cycleDescription()}). MQL = leads whose MQL Received Date (first MQL log, else lead origin date — {data.mqlFallbackLeads} leads used the fallback) is in the cycle. DQL / Proposal Presented / Onboarded count those same MQL leads that have since reached that stage or any later one, and each % = that count ÷ MQLs received in the cycle. Onboarded = OB + OBM stages and beyond. Booking Value uses the dashboard booking definition (Design in Progress with the DIP checklist complete) for the cycle, and Booking Value % = that ÷ the cycle's Booking Target. TAT = onboardings whose first DIP log is in the cycle.</Note>
      <DrillTableCards
        title="Cycle-wise sales trend"
        rows={data.rows}
        headers={trendsHeaders()}
      />
    </div>
  );
}

function Commitment({ data }: { data: Row }) {
  const meetingCols: Col[] = [
    { key: 'meetingId', label: 'Meeting ID' },
    dateCol('scheduledAt', 'Committed date'),
    dateCol('completedAt', 'Recorded completion'),
    { key: 'status', label: 'Status' },
    { key: 'rescheduledReason', label: 'Reschedule reason' },
  ];
  return (
    <div className="space-y-6">
      <Note>
        Meetings planned / committed: every original and revised DQL/PP commitment scheduled in the cycle, including archived reschedules. Meetings actual: each meeting completed in the cycle, using its recorded completion date, even if originally scheduled in another cycle. A completion is counted once. Achievement % = Actual ÷ Planned × 100; N/A when nothing was planned. Expected Booking and Expected OB Value still use the {formulas().intentTiers.highFrom}★-and-above leads whose Expected OB date falls in the cycle, with actuals from those leads onboarded at Design in Progress with the DIP checklist complete.
      </Note>
      {data.blocks.map((b: Row) => (
        <div key={b.cycle.label} className="space-y-2">
          <DrillTableCards
            title={`My Commitment — ${b.cycle.label}`}
            rows={b.rows}
            headers={[
              { key: 'label', label: 'Commitment' },
              { key: 'planned', label: 'Planned / Committed', fmt: (v, r) => (r.isMoney ? inr(Number(v)) : String(v)), drill: { path: (r) => r.drilldown.planned, cols: meetingCols } },
              { key: 'actual', label: 'Actual', fmt: (v, r) => (v == null ? 'Unavailable (completion dates missing)' : r.isMoney ? inr(Number(v)) : String(v)), drill: { path: (r) => r.drilldown.actual, cols: meetingCols } },
              { key: 'achievementPct', label: 'Achievement %', fmt: (v, r) => (v == null ? r.missingCompletionDates ? 'Unavailable (completion dates missing)' : 'N/A (nothing planned)' : `${v}%`) },
            ]}
          />
          {b.rows.filter((r: Row) => r.verificationNote).map((r: Row) => (
            <div key={r.key} className="space-y-1 text-[11px] text-amber-700">
              <p>{r.verificationNote} Click Actual to inspect the known dated completions.</p>
              <DrillToggle label={`${r.label}: missing completion dates`} count={r.missingCompletionDates}>
                <Drill rows={r.drilldown.undated} cols={meetingCols} />
              </DrillToggle>
            </div>
          ))}
          {b.missingValueLeads > 0 && <p className="text-[11px] text-amber-700">{b.missingValueLeads} committed lead(s) have no project value set, so they add 0 to Expected OB Value.</p>}
          <p className="text-[11px] text-gray-400">{b.missingExpectedObDateNote}</p>
        </div>
      ))}
    </div>
  );
}

const taskCallHeaders = (): Hdr[] => {
  const taskCols: Col[] = [{ key: 'status', label: 'Status' }, dateCol('dueDate', 'Due date')];
  const meetCols: Col[] = [{ key: 'meetingType', label: 'Type' }, dateCol('scheduledAt', 'Scheduled at'), { key: 'status', label: 'Status' }];
  const d = (k: string, cols?: Col[]) => ({ path: (r: Row) => r.drilldown[k], cols });
  return [
        { key: 'designer', label: 'Designer' },
        { key: 'leads', label: 'Leads', drill: d('leads') },
        { key: 'projects', label: 'Projects', drill: d('projects', [{ key: 'projectCode', label: 'Project' }]) },
        { key: 'totalScheduled', label: 'Total Scheduled', drill: d('totalScheduled', meetCols) },
        { key: 'upcoming', label: 'Upcoming', drill: d('upcoming', meetCols) },
        { key: 'meetingsCompleted', label: 'Meetings Completed', drill: d('meetingsCompleted', meetCols) },
        { key: 'noShow', label: 'No-Show', drill: d('noShow', meetCols) },
        { key: 'rescheduled', label: 'Rescheduled', drill: d('rescheduled', meetCols) },
        { key: 'callsMade', label: 'Calls Made', drill: d('callsMade', [{ key: 'outcome', label: 'Outcome' }, dateCol('calledAt', 'Called at')]) },
        { key: 'followUpsDue', label: 'Follow-ups Due', drill: d('followUpsDue', taskCols) },
        { key: 'followUpsCompleted', label: 'Follow-ups Completed', drill: d('followUpsCompleted', taskCols) },
        { key: 'activityCompletionPct', label: 'Activity Completion %', fmt: (v) => (v == null ? 'N/A (nothing planned)' : `${v}%`) },
        { key: 'pendingActivities', label: 'Pending', drill: d('pendingActivities', taskCols) },
        { key: 'notDone', label: 'Not Done', drill: d('notDone', taskCols) },
        { key: 'overdueActivities', label: 'Overdue', drill: d('overdueActivities', taskCols) },
        { key: 'noActivityOver3Days', label: `No Activity > ${formulas().noActivityDays} Days`, drill: d('noActivityOver3Days', [dateCol('lastActivityAt', 'Last activity')]) },
  ];
};

const stageActivityHeaders = (): Hdr[] => {
  const tcols: Col[] = [{ key: 'status', label: 'Status' }, dateCol('dueDate', 'Due date')];
  const mcols: Col[] = [{ key: 'meetingType', label: 'Type' }, dateCol('scheduledAt', 'Scheduled at'), { key: 'status', label: 'Status' }];
  const d = (k: string, cols?: Col[]) => ({ path: (r: Row) => r.drilldown[k] ?? [], cols });
  return [
    { key: 'label', label: 'Stage' },
    { key: 'leads', label: 'Leads', drill: d('leads') },
    { key: 'meetingsScheduled', label: 'Meetings Scheduled', drill: d('meetingsScheduled', mcols) },
    { key: 'meetingsCompleted', label: 'Meetings Completed', drill: d('meetingsCompleted', mcols) },
    { key: 'noShow', label: 'No-Show', drill: d('noShow', mcols) },
    { key: 'callsMade', label: 'Calls Made', drill: d('callsMade', [{ key: 'outcome', label: 'Outcome' }, dateCol('calledAt', 'Called at')]) },
    { key: 'followUpsDue', label: 'Follow-ups Due', drill: d('followUpsDue', tcols) },
    { key: 'followUpsCompleted', label: 'Follow-ups Completed', drill: d('followUpsCompleted', tcols) },
    { key: 'plannedActivities', label: 'Planned Activities', drill: d('plannedActivities', mcols) },
    { key: 'completedActivities', label: 'Completed Activities', drill: d('completedActivities', mcols) },
    { key: 'activityCompletionPct', label: 'Activity Completion %', fmt: (v) => (v == null ? '—' : `${v}%`) },
    { key: 'pending', label: 'Pending', drill: d('pending', tcols) },
    { key: 'overdue', label: 'Overdue', drill: d('overdue', tcols) },
    { key: 'noActivity', label: `No Activity > ${formulas().noActivityDays} days`, drill: d('noActivity', [dateCol('lastActivityAt', 'Last activity')]) },
  ];
};

function TaskCall({ data }: { data: Row }) {
  const rows = data.rows;
  return (
    <div className="space-y-3">
      <Note>
        <b>Counted as:</b> Due = {data.definitions.followUpsDue}. Completed = {data.definitions.followUpsCompleted}. Pending = {data.definitions.pending}. Not Done = {data.definitions.notDone}. Overdue = {data.definitions.overdue}. Meetings — Total Scheduled: {data.definitions.meetings.totalScheduled}; Upcoming: {data.definitions.meetings.upcoming}; Completed: {data.definitions.meetings.completed}; No-Show: {data.definitions.meetings.noShow}; Rescheduled: {data.definitions.meetings.rescheduled}. No Activity &gt; {formulas().noActivityDays} Days = {data.definitions.noActivity}. Leads and Projects are separate columns and are not added together.
      </Note>
      {data.byStage && (
        <>
          <DrillTableCards title="Activity by stage" rows={data.byStage} headers={stageActivityHeaders()} />
          <p className="text-[11px] text-gray-400">{data.byStageNote}</p>
        </>
      )}
      <DrillTableCards
        title="Task / call activity (by designer)"
        rows={rows}
        headers={taskCallHeaders()}
      />
      <p className="text-[11px] text-gray-400">Active leads with no activity log at all (not counted above): {rows.map((r: Row) => `${r.designer}: ${r.activeLeadsWithNoActivityLog}`).join(' · ')}</p>
    </div>
  );
}

// ── CSV export (built from the exact data and formatters of the on-screen tables) ──
type Csv = { name: string; head: string[]; rows: string[][] };
const csvCell = (v: unknown) => {
  const t = v == null ? '' : String(v);
  return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const fromHeaders = (name: string, headers: Hdr[], rows: Row[]): Csv => ({
  name, head: headers.map((h) => h.label),
  rows: rows.map((r) => headers.map((h) => (h.fmt ? h.fmt(r[h.key], r) : dash(r[h.key])))),
});
export function csvFor(tab: string, data: Row): Csv {
  switch (tab) {
    case 'my-performance': {
      const d = data as PerfData;
      return {
        name: tab,
        head: ['Cycle', 'Proposal Presented', 'Lead → Onboarding TAT (avg days)', `Onboarding within ${formulas().fastOnboardingDays} days`, 'Average NPS', 'Onboarding count', 'Booking Value', 'Bookings', 'Leads received', 'Conversion', 'Monthly Target', 'Cumulative Achievement', 'Remaining Target',
          ...(d.blHeld ? ['Current BL-held leads (all dates)', 'Current BL-held leads dated in cycle (lead-origin date)', 'BL-held eligible booking value', 'BL-held booking review'] : [])],
        rows: d.blocks.map((b, index) => [
          b.cycle.label, String(b.effort.proposalPresentedCount),
          b.effort.leadToOnboardingTatAvgDays == null ? 'N/A' : String(b.effort.leadToOnboardingTatAvgDays),
          b.effort.onboardingWithin7DaysPct == null ? 'N/A' : `${b.effort.onboardingWithin7DaysPct}%`,
          b.effort.averageNps == null ? 'N/A' : String(b.effort.averageNps),
          String(b.result.onboardingCount), inr(b.result.bookingValue), String(b.result.bookingCount), String(b.result.leadsReceived),
          b.result.conversionPct == null ? 'N/A' : `${b.result.conversionPct}%`,
          b.target.monthlyTarget == null ? 'N/A' : inr(b.target.monthlyTarget), inr(b.target.cumulativeAchievement),
          b.target.remainingTarget == null ? 'N/A' : inr(b.target.remainingTarget),
          ...(d.blHeld ? [
            String(d.blHeld.statusCounts.total),
            String(d.blHeld.cycles[index].leadsReceived),
            d.blHeld.cycles[index].bookingValue == null ? 'N/A' : inr(d.blHeld.cycles[index].bookingValue!),
            d.blHeld.cycles[index].bookingReview.map((lead) => `${lead.leadId}: ${lead.reason}`).join('; '),
          ] : []),
        ]),
      };
    }
    case 'my-lead-funnel': return fromHeaders(tab, funnelHeaders, funnelRows(data));
    case 'meeting-performance': return fromHeaders(tab, meetingHeaders(), data.rows.length === 0 ? [] : meetingRows(data));
    case 'sales-cycle':
      return {
        name: tab, head: ['Client', 'PID (Lead ID)', 'MQL Date', 'Onboarding Date', 'Days Taken'],
        rows: data.rows.map((r: Row) => [r.name, r.pid, `${fmtDate(r.mqlDate)}${r.mqlFallback ? ' *' : ''}`, fmtDate(r.onboardingDate), String(r.days ?? '')]),
      };
    case 'my-commitment':
      return {
        name: tab, head: ['Cycle', 'Commitment', 'Planned / Committed', 'Actual', 'Achievement %', 'Verification note', 'Known dated completions'],
        rows: data.blocks.flatMap((b: Row) => b.rows.map((r: Row) => [
          b.cycle.label, r.label, r.isMoney ? inr(r.planned) : String(r.planned),
          r.actual == null ? 'Unavailable (completion dates missing)' : r.isMoney ? inr(r.actual) : String(r.actual),
          r.achievementPct == null ? r.missingCompletionDates ? 'Unavailable (completion dates missing)' : 'N/A' : `${r.achievementPct}%`,
          r.verificationNote ?? '', r.knownActual == null ? '' : String(r.knownActual),
        ])),
      };
    case 'my-trends-sales': return fromHeaders(tab, trendsHeaders(), data.rows);
    default: return fromHeaders(tab, taskCallHeaders(), data.rows);
  }
}
function downloadCsv(c: Csv) {
  const text = [c.head, ...c.rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = `designer-${c.name}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ── Container ─────────────────────────────────────────────────────────────────
type ServerKey = 'bl-pipeline' | 'bl-conversion' | 'discount-metrics' | 'designer-pipeline' | 'designer-conversion' | 'designer-discount-metrics';
type ReportKey = 'my-performance' | 'my-lead-funnel' | 'meeting-performance' | 'sales-cycle' | 'my-trends-sales' | 'task-call-activity' | 'my-commitment' | ServerKey;
const SERVER_TABS: ServerKey[] = ['bl-pipeline', 'bl-conversion', 'discount-metrics', 'designer-pipeline', 'designer-conversion', 'designer-discount-metrics'];
const isServerTab = (t: ReportKey): t is ServerKey => (SERVER_TABS as string[]).includes(t);
const TABS: { key: ReportKey; label: string }[] = [
  { key: 'my-performance', label: 'My Performance' },
  { key: 'my-lead-funnel', label: 'My Lead Funnel' },
  { key: 'my-commitment', label: 'My Commitment' },
  { key: 'my-trends-sales', label: 'Trends — Sales' },
  { key: 'task-call-activity', label: 'Task / Call Activity' },
];
// BL: one consolidated area. Historical My Lead Funnel is replaced by BL Pipeline.
const BL_TABS: { key: ReportKey; label: string }[] = [
  { key: 'my-performance', label: 'BL Performance' },
  { key: 'bl-pipeline', label: 'BL Pipeline' },
  { key: 'bl-conversion', label: 'BL Conversion' },
  { key: 'discount-metrics', label: 'Discount Metrics' },
  { key: 'my-commitment', label: 'My Commitment' },
  { key: 'my-trends-sales', label: 'Trends — Sales' },
  { key: 'task-call-activity', label: 'Task / Call Activity' },
];
const DESIGNER_TABS: { key: ReportKey; label: string }[] = [
  ...TABS.slice(0, 2),
  { key: 'designer-pipeline', label: 'Designer Pipeline' },
  { key: 'designer-conversion', label: 'Designer Conversion' },
  { key: 'designer-discount-metrics', label: 'Designer Discount Metrics' },
  ...TABS.slice(2),
];
type ServerReport = { notes: string[]; tables: TableData[]; scope: { designers: Designer[] } };

function ServerReport({ tab, data }: { tab: string; data: ServerReport }) {
  return (
    <div className="space-y-5">
      {(data.notes?.length ?? 0) > 0 && (
        <ul className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800" data-testid={`notes-${tab}`}>
          {data.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
      {(data.tables?.length ?? 0) === 0 ? <p className="text-xs text-gray-400">No data for this period.</p>
        : data.tables.map((t, i) => (
          <div key={`${tab}-${i}`}>
            <ServerReportTable tab={tab} t={t} />
            {t.rows.length === 0 && <p className="py-2 text-xs text-gray-400">No leads in this period.</p>}
          </div>
        ))}
    </div>
  );
}

const CYCLE_OPTIONS = [
  { value: '0', label: 'Current cycle' },
  { value: '1', label: 'Previous cycle' },
  { value: '2', label: '2 cycles ago' },
  { value: '3', label: '3 cycles ago' },
  { value: 'custom', label: 'Custom range (one block per cycle)' },
];
const RANGE_OPTIONS = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: 'Last 30 days' },
  { value: '3m', label: 'Last 3 cycles' },
  { value: '6m', label: 'Last 6 cycles' },
  { value: '12m', label: 'Last 12 cycles' },
  { value: 'custom', label: 'Custom range' },
];
const TREND_OPTIONS = [
  { value: '3', label: 'Last 3 cycles' },
  { value: '6', label: 'Last 6 cycles' },
  { value: '12', label: 'Last 12 cycles' },
  { value: 'custom', label: 'Custom range' },
];

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
function monthsAgoISO(n: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return isoDay(d);
}
function presetRange(v: string): { from?: string; to?: string } {
  const today = new Date();
  if (v === '30d') { const d = new Date(); d.setDate(d.getDate() - 30); return { from: isoDay(d), to: isoDay(today) }; }
  if (v === '3m') return { from: monthsAgoISO(3), to: isoDay(today) };
  if (v === '6m') return { from: monthsAgoISO(6), to: isoDay(today) };
  if (v === '12m') return { from: monthsAgoISO(12), to: isoDay(today) };
  return {};
}

export default function DesignerReports({ role }: { role: string }) {
  const [tabSel, setTab] = useState<ReportKey>('my-performance');
  const [period, setPeriod] = useState<Record<ReportKey, string>>({
    'my-performance': '0', 'my-commitment': '0', 'my-lead-funnel': 'all', 'meeting-performance': '3m',
    'sales-cycle': '12m', 'my-trends-sales': '6', 'task-call-activity': '30d',
    'bl-pipeline': 'all', 'bl-conversion': 'all', 'discount-metrics': 'all',
    'designer-pipeline': 'all', 'designer-conversion': 'all', 'designer-discount-metrics': 'all',
  });
  // Admin → Dashboards → Reports page: which tabs show, their order and names.
  const { visible: tabs, blockHidden, heading } = useReportTabs(
    REPORT_BLOCK_IDS.dr, (k) => reportTabId('dr', k),
    role === 'BL' ? BL_TABS : role === 'DESIGNER' ? DESIGNER_TABS : TABS,
    role === 'DESIGNER' ? 'My Reports' : role === 'BL' ? 'BL Reports' : 'Designer Reports',
  );
  // If the tab last opened was hidden, fall back to the first one that is still shown.
  const tab: ReportKey = (tabs.find((t) => t.key === tabSel)?.key ?? tabs[0]?.key ?? tabSel) as ReportKey;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [designerId, setDesignerId] = useState('');
  const [asOf, setAsOf] = useState('');
  const [asOfDraft, setAsOfDraft] = useState('');
  const applyAsOf = (v: string) => { setAsOfDraft(v); if (v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && Number(v.slice(0, 4)) >= 2000)) setAsOf(v); };
  const [designers, setDesigners] = useState<Designer[]>([]);
  const [data, setData] = useState<Row | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sel = period[tab];
  const reqSeq = useRef(0);

  const dateIssue = sel === 'custom'
    ? (!from || !to
      ? 'Select both "From" and "To" dates for a custom range.'
      : (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) || (from && (Number(from.slice(0, 4)) < 2000 || Number(from.slice(0, 4)) > 2100)) || (to && (Number(to.slice(0, 4)) < 2000 || Number(to.slice(0, 4)) > 2100))
      ? 'Enter a complete date (year 2000 or later) to apply the filter.'
      : from && to && to < from ? '"To" date is before "From" date.' : null)
    : null;

  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    if (blockHidden) return;
    if (dateIssue) { setData(null); setError(null); setLoading(false); return; }
    const p = new URLSearchParams();
    if (tab === 'my-performance' || tab === 'my-commitment') {
      if (sel === 'custom') { if (from) p.set('from', from); if (to) p.set('to', to); }
      else { const d = monthsAgoISO(Number(sel)); p.set('from', d); p.set('to', d); }
    } else if (tab === 'my-trends-sales') {
      if (sel === 'custom') { if (from) p.set('from', from); if (to) p.set('to', to); }
      else p.set('months', sel);
    } else if (sel === 'custom') {
      if (from) p.set('from', from);
      if (to) p.set('to', to);
    } else {
      const r = presetRange(sel);
      if (r.from) p.set('from', r.from);
      if (r.to) p.set('to', r.to);
    }
    if (designerId) p.set('designerId', designerId);
    if (tab === 'my-lead-funnel' && asOf) { p.set('asOf', asOf); p.delete('from'); p.delete('to'); }
    setLoading(true); setError(null);
    try {
      const base = isServerTab(tab) ? '/bl-admin-reports' : '/designer-reports';
      const res = await api.get<{ data: Row }>(`${base}/${tab}?${p.toString()}`);
      if (seq !== reqSeq.current) return; // a newer request superseded this one
      setData(res.data);
      setDesigners(res.data.scope?.designers ?? []);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setData(null);
      setError(e instanceof Error ? e.message : 'Failed to load report');
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [tab, sel, from, to, designerId, dateIssue, asOf, blockHidden]);

  useEffect(() => { void load(); }, [load]);

  const options = tab === 'my-performance' || tab === 'my-commitment' ? CYCLE_OPTIONS : tab === 'my-trends-sales' ? TREND_OPTIONS : RANGE_OPTIONS;
  const periodLabel = tab === 'my-performance' || tab === 'my-commitment' ? `Period (${cycleDescription()} cycle)` : tab === 'my-trends-sales' ? 'Cycles' : 'Date range';

  if (blockHidden) return null;

  return (
    <div className="space-y-3" data-testid="designer-reports">
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
        {heading}
      </p>
      <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm space-y-4">
        <div className="flex flex-wrap gap-1.5" role="tablist">
          {tabs.map((t) => (
            <button key={t.key} role="tab" data-testid={`tab-${t.key}`} aria-selected={tab === t.key}
              onClick={() => { setTab(t.key as ReportKey); setData(null); }}
              className={`rounded-full px-3 py-1 text-xs font-medium ${tab === t.key ? 'bg-brand-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-gray-500">
            {periodLabel}
            <select data-testid="period-select" className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm" value={sel} onChange={(e) => setPeriod({ ...period, [tab]: e.target.value })}>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          {sel === 'custom' && (
            <>
              <label className="text-xs text-gray-500">From
                <span className="mt-1 block w-36"><DateInput value={from} onChange={setFrom} className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm" /></span>
              </label>
              <label className="text-xs text-gray-500">To
                <span className="mt-1 block w-36"><DateInput value={to} onChange={setTo} className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm" /></span>
              </label>
            </>
          )}
          {tab === 'my-lead-funnel' && (
            <label className="text-xs text-gray-500">View pipeline as of
              <div className="mt-1 flex items-center gap-1">
                <span data-testid="funnel-asof" className="block w-36"><DateInput value={asOfDraft} min="2000-01-01" max={isoDay(new Date())} onChange={applyAsOf} className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm" /></span>
                {asOfDraft && <button className="text-xs text-brand-600 underline" onClick={() => applyAsOf('')}>Today</button>}
              </div>
            </label>
          )}
          {role !== 'DESIGNER' && designers.length > 0 && (
            <label className="text-xs text-gray-500">Designer
              <select data-testid="designer-select" className="mt-1 block rounded-lg border border-gray-200 px-2 py-1.5 text-sm" value={designerId} onChange={(e) => setDesignerId(e.target.value)}>
                <option value="">All permitted designers</option>
                {designers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
          )}
        </div>
        {dateIssue && <p className="text-xs text-amber-700" data-testid="filter-issue">{dateIssue} No request is sent until the dates are complete.</p>}
        {loading && <p className="text-xs text-gray-400">Loading…</p>}
        {error && <p className="text-xs text-red-600">{error}</p>}
        {data && !loading && (
          <div data-testid={`report-${tab}`}>
            {!isServerTab(tab) && <div className="mb-2 flex justify-end">
              <button data-testid="designer-export-csv" onClick={() => downloadCsv(csvFor(tab, data))} className="rounded-lg border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">Export CSV</button>
            </div>}
            {isServerTab(tab) && <ServerReport tab={tab} data={data as ServerReport} />}
            {tab === 'my-performance' && <MyPerformance data={data as PerfData} showBlBookingDefinition={role === 'BL'} />}
            {tab === 'my-lead-funnel' && <LeadFunnel data={data} />}
            {tab === 'meeting-performance' && <MeetingPerf data={data} />}
            {tab === 'sales-cycle' && <SalesCycle data={data} />}
            {tab === 'my-commitment' && <Commitment data={data} />}
            {tab === 'my-trends-sales' && <Trends data={data} />}
            {tab === 'task-call-activity' && <TaskCall data={data} />}
          </div>
        )}
      </div>
    </div>
  );
}
