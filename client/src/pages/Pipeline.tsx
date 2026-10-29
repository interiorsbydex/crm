// Pipeline — two tabs: Sales Pipeline + Design Pipeline
import { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Search, SlidersHorizontal, X, ChevronRight, Activity, AlertCircle, ClipboardList, Check } from 'lucide-react';
import { api } from '../lib/api';
import { notifyDataChanged } from '../lib/liveRefresh';
import StatusBadge from '../components/StatusBadge';
import PDOBChecklistPanel from '../components/PDOBChecklistPanel';
import DIPChecklistPanel from '../components/DIPChecklistPanel';
import { usePermissions } from '../lib/permissions';
import { LocationFilter, PossessionFilter } from '../components/LeadFilterFields';
import StageCaptureModal from '../components/StageCaptureModal';
import { DateInput } from '../components/ui/DateTimeInputs';
import { stageLabel, crmSettings, sourceLabel } from '../lib/crmSettings';

// ── Types ─────────────────────────────────────────────────────────────────────
interface Lead {
  id: string;
  leadId: string;
  name: string;
  phone: string;
  email?: string | null;
  stage: string;
  status: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE';
  source?: string;
  estimatedValue?: string | number | null;
  intentRating?: number | null;
  isSLABreached: boolean;
  daysInCurrentStage?: number;
  slaStatus?: 'ok' | 'warning' | 'breach';
  followUpTasks?: { id: string }[];
  createdAt: string;
  location?: string;
  projectType?: string;
  scope?: string;
  assignedDesigner?: { id: string; name: string } | null;
  assignedBL?: { id: string; name: string } | null;
  _count?: { calls: number; meetings: number; followUpTasks: number };
}

interface DesignProject {
  id: string;
  projectCode: string;
  phase: string;
  health: string;
  progressPercent: number;
  contractValue: number | null;
  outstandingAmount: number | null;
  handoverTargetDate: string | null;
  createdAt: string;
  updatedAt: string;
  totalActiveDays: number;
  collectionsCount: number;
  attentionFlags: Array<{ id: string; category: string; description: string }>;
  designTimeline?: DesignPipelineTimeline;
  lead: {
    id: string;
    leadId: string;
    name: string;
    phone: string;
    status: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE';
    expectedMoveIn: string | null;
    estimatedValue: number | null;
  };
}

interface DesignPhaseTimeline {
  key: string;
  label: string;
  startDate: string | null;
  status: 'upcoming' | 'in_progress' | 'done';
  elapsedDays: number | null;
  allocatedDays: number | null;
  slaStatus: 'ok' | 'warning' | 'breach';
}

interface DesignPipelineTimeline {
  kickoffDate: string | null;
  overallElapsedDays: number | null;
  overallRemainingDays: number | null;
  overallSlaDays: number;
  overallStatus: 'ok' | 'warning' | 'breach';
  phases: DesignPhaseTimeline[];
}

interface SalesFilters {
  source: string;
  stage: string;
  status: string;
  designerId: string;
  projectType: string;
  location: string;
  originDateFrom: string;
  originDateTo: string;
  budgetMin: string;
  budgetMax: string;
  possession: string;
  possessionDateFrom: string;
  possessionDateTo: string;
  intent: string;
  projectedObFrom: string;
  projectedObTo: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
// EFFECTIVE_LEAD and HANDED_OVER are legacy/off-funnel stages — excluded from
// the kanban board (mirrors the existing precedent of HANDED_OVER already
// being excluded); new leads start at MQL and DESIGN_IN_PROGRESS is the
// funnel's new terminal stage.
const KANBAN_STAGES_ALL = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
] as const;

const KANBAN_STAGES_DESIGNER = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
] as const;

// On Hold / Inactive is a status independent of stage (Task #88), so leads in
// that list view can sit on ANY stage — including the legacy off-funnel ones
// (EFFECTIVE_LEAD, HANDED_OVER) that never appear as live kanban columns.
// Grouping that view must cover every stage a lead can actually have, not
// just the kanban board's columns, or those leads silently vanish from the list.
const STAGE_GROUPING_ORDER = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
  'HANDED_OVER',
] as const;


const STAGE_ACCENT: Record<string, string> = {
  EFFECTIVE_LEAD: 'bg-stone-400',
  MQL: 'bg-amber-500',
  DQL: 'bg-orange-500',
  PROPOSAL_READY: 'bg-brand-400',
  PROPOSAL_PRESENTED: 'bg-brand-500',
  PROPOSAL_DISCUSSION: 'bg-purple-500',
  ONBOARDING: 'bg-green-500',
  ONBOARDING_MEETING: 'bg-teal-500',
  DESIGN_IN_PROGRESS: 'bg-emerald-600',
  HANDED_OVER: 'bg-stone-500',
};

const PHASE_LABELS: Record<string, string> = {
  DESIGN: 'Design Development',
  TECHNICAL: 'Technical',
  PRODUCTION: 'Production',
  SITE_EXECUTION: 'Site Execution',
  HANDOVER: 'Handover',
  COMPLETED: 'Completed',
};

const PHASE_COLOR: Record<string, { bg: string; text: string; border: string }> = {
  DESIGN:         { bg: 'bg-violet-100',  text: 'text-violet-700', border: 'border-violet-200' },
  TECHNICAL:      { bg: 'bg-blue-100',    text: 'text-blue-700',   border: 'border-blue-200' },
  PRODUCTION:     { bg: 'bg-amber-100',   text: 'text-amber-700',  border: 'border-amber-200' },
  SITE_EXECUTION: { bg: 'bg-orange-100',  text: 'text-orange-700', border: 'border-orange-200' },
  HANDOVER:       { bg: 'bg-green-100',   text: 'text-green-700',  border: 'border-green-200' },
  COMPLETED:      { bg: 'bg-emerald-100', text: 'text-emerald-700',border: 'border-emerald-200' },
};

const HEALTH_CONFIG: Record<string, { dot: string; label: string }> = {
  ON_TRACK: { dot: 'bg-green-500',  label: 'On Track' },
  AT_RISK:  { dot: 'bg-amber-500',  label: 'At Risk' },
  DELAYED:  { dot: 'bg-red-500',    label: 'Delayed' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getCurrentUserRole(): string {
  try {
    const raw = localStorage.getItem('crm_user');
    if (!raw) return '';
    return JSON.parse(raw)?.role ?? '';
  } catch { return ''; }
}

const fmt = (val: string | number | null | undefined) => {
  const n = parseFloat(String(val ?? 0));
  if (!n) return null;
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${n.toLocaleString('en-IN')}`;
};

function relTime(date: string) {
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'Asia/Kolkata' });
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
/** Clickable star input for exact-match intent filter (e.g. "2 stars" shows only 2-star leads). */
function StarFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const selected = parseInt(value) || 0;
  return (
    <div className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(selected === i ? '' : String(i))}
          className="text-lg leading-none transition-colors"
        >
          <span className={selected === i ? 'text-amber-400' : 'text-gray-200'}>★</span>
        </button>
      ))}
      {selected > 0 && (
        <span className="text-xs text-stone-500 ml-0.5">{selected} star{selected > 1 ? 's' : ''}</span>
      )}
    </div>
  );
}

// Stages whose gate-critical checklist (PD→OB, OBM→DIP) can be completed
// straight from the Pipeline board instead of requiring the full lead page.
const CHECKLIST_ENTRY_STAGES: Record<string, { title: string }> = {
  // PROPOSAL_PRESENTED included so the same mandatory PD→OB checklist can be
  // started/completed straight from the board while a lead is still in PP,
  // ahead of a PP→OB skip (the checklist itself is never bypassed by the skip).
  PROPOSAL_PRESENTED: { title: 'PD → OB checklist (skip PD)' },
  PROPOSAL_DISCUSSION: { title: 'PD → OB checklist' },
  ONBOARDING_MEETING: { title: 'OBM → DIP checklist' },
};

// ── LeadCard ──────────────────────────────────────────────────────────────────
function LeadCard({
  lead,
  onDragStart,
  onDragEnd,
  onOpenChecklist,
}: {
  lead: Lead;
  onDragStart: (e: React.DragEvent, lead: Lead) => void;
  onDragEnd: () => void;
  onOpenChecklist: (lead: Lead) => void;
}) {
  // Which details a card shows: Admin → CRM Settings → Display.
  const show = (f: string) => crmSettings().pipelineCardFields.includes(f);
  const val = show('value') ? fmt(lead.estimatedValue) : '';
  const scope = show('scope') ? [lead.projectType, lead.scope].filter(Boolean).join(' · ') : '';
  const checklistEntry = CHECKLIST_ENTRY_STAGES[lead.stage];

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, lead)}
      onDragEnd={onDragEnd}
      className="bg-white rounded-2xl p-3.5 cursor-grab active:cursor-grabbing transition-all hover:shadow-warm"
      style={{ border: '1px solid #EDE8E3', boxShadow: '0 1px 3px 0 rgba(100,60,20,0.08)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <Link
          to={`/leads/${lead.id}`}
          className="text-sm font-semibold text-stone-900 hover:text-brand-600 leading-tight truncate"
          onClick={(e) => e.stopPropagation()}
        >
          {lead.name}
        </Link>
        <span className="text-[10px] font-mono text-stone-400 px-1.5 py-0.5 rounded shrink-0" style={{ background: '#F5F0EB' }}>
          {lead.leadId}
        </span>
      </div>

      {checklistEntry && (
        <button
          onClick={(e) => { e.stopPropagation(); onOpenChecklist(lead); }}
          onMouseDown={(e) => e.stopPropagation()}
          draggable={false}
          className="flex items-center gap-1 text-[10px] font-semibold text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-2 py-0.5 mb-1.5 hover:bg-purple-100 transition-colors"
        >
          <ClipboardList size={10} strokeWidth={2.5} /> {checklistEntry.title}
        </button>
      )}

      {/* Task #88 — status badge, since status no longer maps to stage */}
      {lead.status !== 'ACTIVE' && (
        <StatusBadge status={lead.status} className="inline-block mb-1.5" />
      )}

      {scope && <p className="text-xs text-stone-500 mb-1.5 truncate">{scope}</p>}

      {/* Task #90 — per-stage budget value replaces the old intent-rating
          stars here; the client's estimated value is tagged with the stage
          it's currently sitting at (no historical per-stage value log exists
          yet — see follow-up task for tracking value changes over time). */}
      <div className="flex items-center gap-2 mb-2">
        {val && <span className="text-sm font-bold text-stone-800">{val}</span>}
        <span className="text-[10px] font-semibold text-stone-400 px-1.5 py-0.5 rounded-full shrink-0" style={{ background: '#F5F0EB' }}>
          {stageLabel(lead.stage)}
        </span>
        {show('location') && lead.location && <span className="text-xs text-stone-400 truncate flex-1">{lead.location}</span>}
      </div>
      <div className="flex items-center gap-2 mb-1 empty:hidden">
        {show('intent') && !!lead.intentRating && <span className="text-[11px] text-amber-500">{'★'.repeat(lead.intentRating)}</span>}
        {show('phone') && lead.phone && <span className="text-[11px] text-stone-500">{lead.phone}</span>}
      </div>

      <div className="flex flex-wrap gap-1 mb-2.5">
        {lead.isSLABreached && (
          <span className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full">SLA breach</span>
        )}
        {lead.slaStatus === 'breach' && (
          <span
            className="text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full"
            title={`${lead.daysInCurrentStage}d in ${lead.stage}`}
          >
            Stage overdue
          </span>
        )}
        {lead.slaStatus === 'warning' && (
          <span
            className="text-[10px] font-bold bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full"
            title={`${lead.daysInCurrentStage}d in ${lead.stage}`}
          >
            Stage due soon
          </span>
        )}
        {lead.followUpTasks && lead.followUpTasks.length > 0 && (
          <span className="text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">Follow-up overdue</span>
        )}
      </div>

      <div className="flex items-center gap-1.5 pt-1.5" style={{ borderTop: '1px solid #F5F0EB' }}>
        {!show('owner') ? <span className="flex-1" /> : lead.assignedDesigner ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <div className="w-5 h-5 rounded-full bg-brand-100 flex items-center justify-center shrink-0">
              <span className="text-[9px] font-bold text-brand-700">{lead.assignedDesigner.name[0]?.toUpperCase()}</span>
            </div>
            <span className="text-[10px] text-stone-500 truncate">{lead.assignedDesigner.name}</span>
          </div>
        ) : lead.assignedBL ? (
          <div className="flex items-center gap-1 flex-1 min-w-0">
            <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
              <span className="text-[9px] font-bold text-amber-700">{lead.assignedBL.name[0]?.toUpperCase()}</span>
            </div>
            <span className="text-[10px] text-stone-500 truncate">{lead.assignedBL.name}</span>
          </div>
        ) : (
          <span className="text-[10px] text-stone-300 flex-1">Unassigned</span>
        )}
        {show('source') && lead.source && (
          <span className="text-[10px] text-stone-400 shrink-0 hidden sm:block">{sourceLabel(lead.source)}</span>
        )}
        {show('age') && <span className="text-[10px] text-stone-400 shrink-0">{relTime(lead.createdAt)} ago</span>}
      </div>
    </div>
  );
}

// ── Checklist modal (PD→OB / OBM→DIP) — lets Pipeline complete these gate
// checklists without leaving the board, reusing the same panels the lead
// detail page uses so there's only one implementation of each checklist. ──
function ChecklistModal({ lead, onClose, onDone }: { lead: Lead; onClose: () => void; onDone: () => void }) {
  const entry = CHECKLIST_ENTRY_STAGES[lead.stage];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 sticky top-0 bg-white z-10" style={{ borderBottom: '1px solid #EDE8E3' }}>
          <div>
            <h3 className="text-sm font-bold text-stone-900">{entry?.title ?? 'Checklist'}</h3>
            <p className="text-xs text-stone-500">{lead.name} · {lead.leadId}</p>
          </div>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 p-1">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          {(lead.stage === 'PROPOSAL_PRESENTED' || lead.stage === 'PROPOSAL_DISCUSSION') && (
            <PDOBChecklistPanel leadId={lead.id} stage={lead.stage} clientEmail={lead.email ?? null} onComplete={onDone} />
          )}
          {lead.stage === 'ONBOARDING_MEETING' && (
            <DIPChecklistPanel leadId={lead.id} stage={lead.stage} onComplete={onDone} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Gate-blocked modal — shown instead of a plain error toast when a drag is
// blocked, so the missing items are actionable without leaving the board. ──
function GateBlockedModal({
  lead,
  targetStageLabel,
  details,
  onClose,
  onOpenChecklist,
  onOverride,
}: {
  lead: Lead;
  targetStageLabel: string;
  details: { label: string; satisfied: boolean; type: string }[];
  onClose: () => void;
  onOpenChecklist: (lead: Lead) => void;
  /** Present when this role may push the lead forward anyway (Admin → Permissions). */
  onOverride?: (reason: string) => void;
}) {
  const [overrideReason, setOverrideReason] = useState('');
  const hasPdObChecklist = details.some((d) => !d.satisfied && d.type === 'pdObChecklist');
  const hasDip = details.some((d) => !d.satisfied && d.type === 'dip');
  const canOpenInlineChecklist = (hasPdObChecklist && (lead.stage === 'PROPOSAL_PRESENTED' || lead.stage === 'PROPOSAL_DISCUSSION'))
    || (hasDip && lead.stage === 'ONBOARDING_MEETING');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid #EDE8E3' }}>
          <h3 className="text-sm font-bold text-stone-900">Can't move to {targetStageLabel}</h3>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 p-1">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-xs text-stone-500 mb-3">
            {lead.name} is missing the following before it can move forward:
          </p>
          <div className="space-y-1.5 mb-4">
            {details.map((d, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 shrink-0 ${d.satisfied ? 'text-green-500' : 'text-red-500'}`}>
                  {d.satisfied ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
                </span>
                <span className={d.satisfied ? 'text-stone-400 line-through' : 'text-stone-700 font-medium'}>{d.label}</span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            {canOpenInlineChecklist && (
              <button
                onClick={() => onOpenChecklist(lead)}
                className="flex-1 flex items-center justify-center gap-1.5 bg-brand-500 text-white py-2 rounded-lg text-xs font-semibold hover:bg-brand-600 transition-colors"
              >
                <ClipboardList size={12} strokeWidth={2.5} /> Open checklist
              </button>
            )}
            <Link
              to={`/leads/${lead.id}`}
              className="flex-1 flex items-center justify-center gap-1.5 bg-stone-100 text-stone-700 py-2 rounded-lg text-xs font-semibold hover:bg-stone-200 transition-colors"
            >
              Open lead
            </Link>
          </div>
          {onOverride && (
            <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="stage-override">
              <p className="font-semibold">Push forward anyway?</p>
              <p className="mt-0.5">The lead moves now even though the items above are missing. Your reason and the missing items are recorded on the lead's activity.</p>
              <textarea value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} rows={2} maxLength={1000}
                placeholder="Why must this lead move now? (at least 10 characters)" aria-label="Reason for pushing forward"
                className="mt-2 w-full rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-xs text-stone-800" />
              <button type="button" disabled={overrideReason.trim().length < 10} onClick={() => onOverride(overrideReason.trim())}
                className="mt-2 w-full rounded-lg bg-amber-600 py-2 font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
                Push forward with this reason
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Design Pipeline view ──────────────────────────────────────────────────────
function DesignPipelineView() {
  const [projects, setProjects] = useState<DesignProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [phaseFilter, setPhaseFilter] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{ projects: DesignProject[] }>('/projects/pipeline');
      setProjects(data.projects ?? []);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const phases = Array.from(new Set(projects.map((p) => p.phase)));
  const filtered = phaseFilter ? projects.filter((p) => p.phase === phaseFilter) : projects;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="space-y-3 w-full max-w-lg p-8">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-gray-100 rounded-2xl animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center py-20 text-stone-400">
        <Activity size={32} strokeWidth={1.5} className="mb-3 text-stone-300" />
        <p className="text-sm font-semibold text-stone-500">No active projects</p>
        <p className="text-xs mt-1">Projects appear here once a lead reaches Onboarding.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Phase filter pills */}
      <div className="bg-white px-5 py-3 flex items-center gap-2 flex-wrap" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <button
          onClick={() => setPhaseFilter('')}
          className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-all ${
            !phaseFilter ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-600 hover:bg-stone-200'
          }`}
        >
          All phases
          <span className={`ml-1.5 ${!phaseFilter ? 'text-stone-300' : 'text-stone-400'}`}>{projects.length}</span>
        </button>
        {phases.map((ph) => {
          const pc = PHASE_COLOR[ph] ?? PHASE_COLOR.DESIGN;
          const count = projects.filter((p) => p.phase === ph).length;
          return (
            <button
              key={ph}
              onClick={() => setPhaseFilter(phaseFilter === ph ? '' : ph)}
              className={`text-xs px-3 py-1.5 rounded-full font-semibold transition-all border ${
                phaseFilter === ph
                  ? `${pc.bg} ${pc.text} ${pc.border} shadow-sm`
                  : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
              }`}
            >
              {PHASE_LABELS[ph] ?? ph}
              <span className="ml-1.5 opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="p-4 max-w-4xl mx-auto space-y-3">
        {filtered.map((proj) => {
          const pc = PHASE_COLOR[proj.phase] ?? PHASE_COLOR.DESIGN;
          const hc = HEALTH_CONFIG[proj.health] ?? HEALTH_CONFIG.ON_TRACK;
          const hasFlags = proj.attentionFlags.length > 0;

          return (
            <Link
              key={proj.id}
              to={`/leads/${proj.lead.id}`}
              className="block bg-white rounded-2xl p-4 hover:shadow-warm transition-all group"
              style={{ border: hasFlags ? '1.5px solid #fca5a5' : '1px solid #EDE8E3' }}
            >
              <div className="flex items-start gap-4">
                {/* Left: phase progress indicator */}
                <div className="shrink-0 flex flex-col items-center gap-1 pt-0.5">
                  <div className={`w-2.5 h-2.5 rounded-full ${hc.dot}`} title={hc.label} />
                  <div className="w-0.5 flex-1 min-h-[40px] rounded-full bg-stone-100" />
                </div>

                {/* Main content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-stone-900 group-hover:text-brand-600 transition-colors">
                          {proj.lead.name}
                        </span>
                        {proj.lead.status !== 'ACTIVE' && <StatusBadge status={proj.lead.status} />}
                        <span className="text-[10px] font-mono text-stone-400">{proj.lead.leadId}</span>
                        <span className="text-[10px] text-stone-400">·</span>
                        <span className="text-[10px] font-mono text-stone-500">{proj.projectCode}</span>
                      </div>
                    </div>

                    {/* Phase badge */}
                    <span className={`text-xs px-2.5 py-1 rounded-full font-semibold border shrink-0 ${pc.bg} ${pc.text} ${pc.border}`}>
                      {PHASE_LABELS[proj.phase] ?? proj.phase}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="flex items-center gap-3 mb-2.5">
                    <div className="flex-1 bg-stone-100 rounded-full h-1.5 overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, proj.progressPercent)}%`,
                          background: proj.health === 'DELAYED' ? '#ef4444' : proj.health === 'AT_RISK' ? '#f59e0b' : '#22c55e',
                        }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-stone-600 shrink-0">{proj.progressPercent}%</span>
                  </div>

                  {/* Stats row */}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-500">
                    {/* Task #90 — per-stage budget replaces the raw "days active"
                        stat; tags the contract value with the current design
                        phase (no historical per-phase budget log exists yet). */}
                    {proj.contractValue != null && (
                      <span className="flex items-center gap-1">
                        <span className="font-medium text-stone-700">{fmt(proj.contractValue)}</span>
                        <span className="text-stone-400">· {PHASE_LABELS[proj.phase] ?? proj.phase} budget</span>
                      </span>
                    )}

                    {proj.lead.expectedMoveIn && (
                      <span>
                        Possession: <span className="font-medium text-stone-700">{fmtDate(proj.lead.expectedMoveIn)}</span>
                      </span>
                    )}

                    {proj.handoverTargetDate && (
                      <span>
                        Handover by: <span className="font-medium text-stone-700">{fmtDate(proj.handoverTargetDate)}</span>
                      </span>
                    )}

                    {proj.contractValue != null && (
                      <span>
                        Contract: <span className="font-medium text-stone-700">{fmt(proj.contractValue)}</span>
                      </span>
                    )}

                    <span className={`flex items-center gap-1 ${
                      proj.health === 'DELAYED' ? 'text-red-600' : proj.health === 'AT_RISK' ? 'text-amber-600' : 'text-green-600'
                    } font-medium`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${hc.dot}`} />
                      {hc.label}
                    </span>
                  </div>

                  {/* Attention flags */}
                  {hasFlags && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {proj.attentionFlags.slice(0, 3).map((f) => (
                        <span key={f.id} className="flex items-center gap-1 text-[10px] bg-red-50 text-red-700 px-2 py-0.5 rounded-full border border-red-100">
                          <AlertCircle size={9} />
                          {f.category}{f.description ? `: ${f.description.slice(0, 40)}${f.description.length > 40 ? '…' : ''}` : ''}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Design Pipeline 8-stage timeline (task #56) */}
                  {proj.designTimeline && (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid #F5F0EB' }}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-semibold text-stone-500 uppercase tracking-wide">Design timeline</span>
                        {proj.designTimeline.overallElapsedDays != null ? (
                          <span
                            className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                              proj.designTimeline.overallStatus === 'breach'
                                ? 'bg-red-100 text-red-700'
                                : proj.designTimeline.overallStatus === 'warning'
                                ? 'bg-orange-100 text-orange-700'
                                : 'bg-green-100 text-green-700'
                            }`}
                          >
                            {proj.designTimeline.overallElapsedDays}d / {proj.designTimeline.overallSlaDays}d
                            {proj.designTimeline.overallRemainingDays != null && proj.designTimeline.overallRemainingDays < 0
                              ? ` (${Math.abs(proj.designTimeline.overallRemainingDays)}d over)`
                              : ''}
                          </span>
                        ) : (
                          <span className="text-[10px] text-stone-400">Not started</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        {proj.designTimeline.phases.map((ph) => (
                          <span
                            key={ph.key}
                            title={
                              ph.status === 'upcoming'
                                ? `${ph.label}: upcoming`
                                : `${ph.label}: ${ph.elapsedDays}d elapsed${ph.allocatedDays != null ? ` / ${ph.allocatedDays}d allocated` : ''}`
                            }
                            className={`text-[9px] font-semibold px-1.5 py-0.5 rounded border ${
                              ph.status === 'upcoming'
                                ? 'bg-stone-50 text-stone-300 border-stone-100'
                                : ph.slaStatus === 'breach'
                                ? 'bg-red-50 text-red-700 border-red-200'
                                : ph.slaStatus === 'warning'
                                ? 'bg-orange-50 text-orange-700 border-orange-200'
                                : 'bg-brand-50 text-brand-700 border-brand-200'
                            }`}
                          >
                            {ph.label}{ph.status !== 'upcoming' ? ` · ${ph.elapsedDays}d` : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                <ChevronRight size={14} className="text-stone-300 group-hover:text-brand-500 transition-colors shrink-0 mt-1" />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ── Sales Pipeline view ───────────────────────────────────────────────────────
const EMPTY_SALES_FILTERS: SalesFilters = {
  source: '', stage: '', status: '', designerId: '', projectType: '', location: '',
  originDateFrom: '', originDateTo: '',
  budgetMin: '', budgetMax: '',
  possession: '', possessionDateFrom: '', possessionDateTo: '',
  intent: '',
  projectedObFrom: '', projectedObTo: '',
};

const STATUS_FILTER_OPTIONS = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'INACTIVE', label: 'Inactive' },
];

// Task #88: ON_HOLD/INACTIVE are status values, not stages — the Status tabs
// above already cover them, so they're dropped from the Stage filter.
const STAGE_FILTER_OPTIONS_ALL = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
  'HANDED_OVER',
];
const STAGE_FILTER_OPTIONS_DESIGNER = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
  'HANDED_OVER',
];

function SalesPipelineView({ userRole }: { userRole: string }) {
  const { can } = usePermissions();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [teamMembers, setTeamMembers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [salesFilters, setSalesFilters] = useState<SalesFilters>(EMPTY_SALES_FILTERS);
  const [stageMenuOpen, setStageMenuOpen] = useState(false);
  const [statusMenuOpen, setStatusMenuOpen] = useState(false);

  // Drag state
  const [draggedLead, setDraggedLead] = useState<Lead | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);
  const dragCounters = useRef<Record<string, number>>({});

  // Blocked-drag modal + inline checklist modal (Task #111)
  const [gateBlocked, setGateBlocked] = useState<{
    lead: Lead;
    targetStage: string;
    details: { label: string; satisfied: boolean; type: string }[];
  } | null>(null);
  const [checklistLead, setChecklistLead] = useState<Lead | null>(null);

  // Task #114 — a drag-drop stage move is held back until intent rating +
  // project value are confirmed, same as the lead-detail stage dropdown.
  const [stageCapture, setStageCapture] = useState<{ lead: Lead; targetStage: string } | null>(null);
  const [stageCaptureError, setStageCaptureError] = useState<string | null>(null);
  const [stageCaptureSaving, setStageCaptureSaving] = useState(false);

  const isDesigner = userRole === 'DESIGNER' || userRole === 'CRE';
  const KANBAN_STAGES = isDesigner ? KANBAN_STAGES_DESIGNER : KANBAN_STAGES_ALL;
  const stageOptions = isDesigner ? STAGE_FILTER_OPTIONS_DESIGNER : STAGE_FILTER_OPTIONS_ALL;
  const selectedStages = salesFilters.stage ? salesFilters.stage.split(',').filter(Boolean) : [];
  const selectedStatuses = salesFilters.status ? salesFilters.status.split(',').filter(Boolean) : [];

  // Badge counts only the "more" filters; Stage/Status/Source are always visible upfront.
  const moreFilterCount = [
    ...(userRole === 'BL' ? [salesFilters.designerId] : []),
    salesFilters.projectType, salesFilters.location,
    salesFilters.originDateFrom, salesFilters.originDateTo,
    salesFilters.budgetMin, salesFilters.budgetMax,
    salesFilters.possession, salesFilters.possessionDateFrom, salesFilters.possessionDateTo,
    salesFilters.intent,
  ].filter(Boolean).length;
  const activeFilterCount = Object.values(salesFilters).filter(Boolean).length;

  // Keep BL cohort lookup isolated from assignment dropdowns; this list
  // intentionally includes both active Designers and CREs in the cohort.
  useEffect(() => {
    if (userRole !== 'BL') return;
    api.get<{ members: { id: string; name: string }[] }>('/leads/meta/team-members')
      .then((data) => setTeamMembers(data.members ?? []))
      .catch((error: any) => toast.error(error.message || 'Could not load team members'));
  }, [userRole]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (isDesigner) params.set('pipelineMode', '1');
      // Filters shared with the leads list
      if (salesFilters.source)  params.set('source',  salesFilters.source);
      if (salesFilters.stage)   params.set('stage',   salesFilters.stage);
      if (salesFilters.status)  params.set('status',  salesFilters.status);
      if (salesFilters.designerId) params.set('designerId', salesFilters.designerId);
      if (salesFilters.projectType) params.set('projectType', salesFilters.projectType);
      if (salesFilters.location)    params.set('location',    salesFilters.location);
      // Advanced filters
      if (salesFilters.originDateFrom) params.set('originDateFrom', salesFilters.originDateFrom);
      if (salesFilters.originDateTo)   params.set('originDateTo',   salesFilters.originDateTo);
      if (salesFilters.budgetMin)      params.set('budgetMin',      salesFilters.budgetMin);
      if (salesFilters.budgetMax)      params.set('budgetMax',      salesFilters.budgetMax);
      if (salesFilters.possession) params.set('possession', salesFilters.possession);
      if (salesFilters.possessionDateFrom) params.set('possessionDateFrom', salesFilters.possessionDateFrom);
      if (salesFilters.possessionDateTo)   params.set('possessionDateTo',   salesFilters.possessionDateTo);
      if (salesFilters.intent)      params.set('intent',      salesFilters.intent);
      if (salesFilters.projectedObFrom) params.set('projectedObFrom', salesFilters.projectedObFrom);
      if (salesFilters.projectedObTo)   params.set('projectedObTo',   salesFilters.projectedObTo);

      const data = await api.get<{ leads: Lead[]; total: number }>(`/leads?${params}`);
      setLeads(data.leads ?? []);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [isDesigner, salesFilters]);

  useEffect(() => { load(); }, [load]);

  // Leads can be created or assigned by other users (CRE, webhooks), so keep
  // the list fresh without a manual reload: re-fetch silently when the tab
  // regains focus and every 30s while it is visible.
  useEffect(() => {
    const silentRefresh = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const timer = window.setInterval(silentRefresh, 30_000);
    document.addEventListener('visibilitychange', silentRefresh);
    window.addEventListener('focus', silentRefresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', silentRefresh);
      window.removeEventListener('focus', silentRefresh);
    };
  }, [load]);

  useEffect(() => {
    const refreshPipeline = () => { void load(); };
    window.addEventListener('lead-created', refreshPipeline);
    return () => window.removeEventListener('lead-created', refreshPipeline);
  }, [load]);

  // Task #88: Active/On Hold/Inactive are the lead's real `status`, independent of stage.
  const counts = {
    all: leads.length,
    active: leads.filter((l) => l.status === 'ACTIVE').length,
    onhold: leads.filter((l) => l.status === 'ON_HOLD').length,
    inactive: leads.filter((l) => l.status === 'INACTIVE').length,
  };

  // Status is filtered server-side via salesFilters.status; only search is client-side.
  const filtered = leads.filter((l) => {
    const q = search.toLowerCase();
    return !q || l.name.toLowerCase().includes(q) || l.leadId.toLowerCase().includes(q)
      || (l.phone ?? '').includes(q) || (l.email ?? '').toLowerCase().includes(q);
  });

  const byStage = (stage: string) => filtered.filter((l) => l.stage === stage);

  const totalValue = leads.reduce((s, l) => s + parseFloat(String(l.estimatedValue ?? 0)), 0);
  const activeValue = leads.filter((l) => l.status === 'ACTIVE')
    .reduce((s, l) => s + parseFloat(String(l.estimatedValue ?? 0)), 0);

  const fmtPipeline = (n: number) => {
    if (n >= 10000000) return `₹${(n / 10000000).toFixed(2)}Cr`;
    if (n >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
    return `₹${n.toLocaleString('en-IN')}`;
  };

  const colValue = (stage: string) =>
    byStage(stage).reduce((s, l) => s + parseFloat(String(l.estimatedValue ?? 0)), 0);

  // ── Drag handlers ────────────────────────────────────────────────────────────
  const handleDragStart = (e: React.DragEvent, lead: Lead) => {
    setDraggedLead(lead);
    e.dataTransfer.effectAllowed = 'move';
  };
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const handleDragEnter = (e: React.DragEvent, stage: string) => {
    e.preventDefault();
    dragCounters.current[stage] = (dragCounters.current[stage] ?? 0) + 1;
    setDragOverStage(stage);
  };
  const handleDragLeave = (_e: React.DragEvent, stage: string) => {
    dragCounters.current[stage] = (dragCounters.current[stage] ?? 1) - 1;
    if (dragCounters.current[stage] <= 0) {
      dragCounters.current[stage] = 0;
      if (dragOverStage === stage) setDragOverStage(null);
    }
  };
  const handleDragEnd = () => { setDraggedLead(null); setDragOverStage(null); dragCounters.current = {}; };

  const commitDrop = async (lead: Lead, targetStage: string, extraFields: Record<string, string>) => {
    const originalStage = lead.stage;
    setLeads((prev) => prev.map((l) => l.id === lead.id ? { ...l, stage: targetStage } : l));
    try {
      const token = localStorage.getItem('crm_token');
      const res = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stage: targetStage, ...extraFields }),
      });
      if (res.ok) {
        notifyDataChanged();
        toast.success(`${lead.name} → ${stageLabel(targetStage)}`);
        const okBody = await res.json().catch(() => ({}));
        if (okBody.gateWarnings?.length) {
          toast(`Moved with missing items: ${okBody.gateWarnings.join('; ')}`, { duration: 9000, icon: '⚠️' });
        }
      } else {
        const body = await res.json().catch(() => ({}));
        setLeads((prev) => prev.map((l) => l.id === lead.id ? { ...l, stage: originalStage } : l));
        if (extraFields.overrideReason) {
          // An override was refused (e.g. payment proof can't be overridden): say why.
          toast.error(body.error ?? `Stage update failed (${res.status})`, { duration: 9000 });
        } else if (body.details?.length) {
          // Actionable modal instead of a plain toast — lists exactly what's
          // missing and, where possible, a way to fix it without leaving the board.
          setGateBlocked({ lead: { ...lead, stage: originalStage }, targetStage, details: body.details });
        } else {
          toast.error(body.error ?? `Stage update failed (${res.status})`, { duration: 6000 });
        }
      }
    } catch {
      setLeads((prev) => prev.map((l) => l.id === lead.id ? { ...l, stage: originalStage } : l));
      toast.error('Stage update failed — network error', { duration: 6000 });
    }
  };

  // Task #88: ON_HOLD/INACTIVE are no longer stages, so the kanban board only
  // ever has real-stage columns — dropping onto one is a plain stage move.
  // Task #114: the drop no longer commits immediately — it opens the
  // intent-rating + project-value capture step first.
  const handleDrop = (e: React.DragEvent, targetStage: string) => {
    e.preventDefault();
    dragCounters.current[targetStage] = 0;
    setDragOverStage(null);
    if (!draggedLead || draggedLead.stage === targetStage) { setDraggedLead(null); return; }
    const lead = draggedLead;
    setDraggedLead(null);
    setStageCaptureError(null);
    setStageCapture({ lead, targetStage });
  };

  const confirmStageCapture = async (rating: number, value: number | null, reason: string) => {
    if (!stageCapture) return;
    const { lead, targetStage } = stageCapture;
    setStageCaptureSaving(true);
    setStageCaptureError(null);
    try {
      if (rating > 0 && rating !== (lead.intentRating ?? 0)) {
        try {
          const token = localStorage.getItem('crm_token');
          const res = await fetch(`/api/leads/${lead.id}/intent-rating`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ rating, reason: reason || undefined }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            setStageCaptureError(body.error ?? 'Could not update intent rating — a reason may be required if this overrides the system-computed rating.');
            return;
          }
        } catch {
          setStageCaptureError('Could not update intent rating — network error');
          return;
        }
      }
      await commitDrop(lead, targetStage, value !== null ? { estimatedValue: String(value) } : {});
      setStageCapture(null);
    } finally {
      setStageCaptureSaving(false);
    }
  };

  // Checklist item #1: On Hold / Inactive must render the exact same
  // stage-column kanban layout Active already uses, not a separate stacked
  // list. The primary columns stay identical to Active's KANBAN_STAGES;
  // legacy off-funnel stages (EFFECTIVE_LEAD, HANDED_OVER) get an extra
  // column appended only when a lead in this tab actually sits there, so
  // On Hold/Inactive leads on those stages don't silently disappear.
  const showKanban = true;
  // Show legacy stage columns when status is All / On Hold / Inactive, so leads on those stages
  // (EFFECTIVE_LEAD, HANDED_OVER) don't silently vanish from the board.
  const statusShowsLegacy = selectedStatuses.length === 0
    || selectedStatuses.includes('ON_HOLD')
    || selectedStatuses.includes('INACTIVE');
  const legacyStagesInView = statusShowsLegacy
    ? STAGE_GROUPING_ORDER.filter(
        (s) => !(KANBAN_STAGES as readonly string[]).includes(s) && byStage(s).length > 0,
      )
    : [];
  // Stages switched off in Admin → CRM Settings get no column, unless a lead is still in one.
  const hiddenStages = crmSettings().hiddenStages;
  const kanbanColumns = [
    ...KANBAN_STAGES.filter((st) => !hiddenStages.includes(st) || byStage(st).length > 0),
    ...legacyStagesInView,
  ];

  const setSF = (k: keyof SalesFilters, v: string) =>
    setSalesFilters((prev) => ({ ...prev, [k]: v }));
  const toggleStage = (stage: string) => {
    const nextStages = selectedStages.includes(stage)
      ? selectedStages.filter((selected) => selected !== stage)
      : [...selectedStages, stage];
    setSF('stage', nextStages.join(','));
  };
  const toggleStatus = (status: string) => {
    const nextStatuses = selectedStatuses.includes(status)
      ? selectedStatuses.filter((selected) => selected !== status)
      : [...selectedStatuses, status];
    setSF('status', nextStatuses.join(','));
  };
  const clearFilters = () => setSalesFilters(EMPTY_SALES_FILTERS);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Toolbar — Search/Stage/Status/Source always visible; More Filters expands the rest */}
      <div className="bg-white px-5 py-3 flex flex-wrap items-center gap-2 shrink-0" style={{ borderBottom: '1px solid #EDE8E3' }}>
        {/* Search */}
        <div className="flex items-center rounded-xl overflow-hidden flex-1 min-w-[160px] max-w-xs" style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
          <Search size={14} className="ml-2.5 text-gray-400 shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, ID, phone, email…"
            className="bg-transparent px-2 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none flex-1"
          />
        </div>
        {/* Stage — multiple stages can be viewed together. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setStageMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={stageMenuOpen}
            className="rounded-xl px-3 py-1.5 text-sm text-left focus:outline-none focus:ring-2 focus:ring-brand-300 min-w-[150px] flex items-center justify-between gap-3"
            style={{ border: '1px solid #EDE8E3', background: selectedStages.length ? '#FDF4EF' : '#FDFAF7' }}
          >
            <span className="truncate">
              {selectedStages.length === 0
                ? 'All stages'
                : selectedStages.length <= 2
                  ? selectedStages.map((stage) => stageLabel(stage)).join(', ')
                  : `${selectedStages.length} stages selected`}
            </span>
            <span className="text-stone-400" aria-hidden="true">⌄</span>
          </button>
          {stageMenuOpen && (
            <div role="menu" className="absolute z-30 mt-1 w-64 rounded-xl bg-white p-2 shadow-lg" style={{ border: '1px solid #EDE8E3' }}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={selectedStages.length === 0}
                onClick={() => { setSF('stage', ''); setStageMenuOpen(false); }}
                className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                All stages
              </button>
              <div className="my-1 border-t border-stone-100" />
              {stageOptions.map((stage) => {
                const checked = selectedStages.includes(stage);
                return (
                  <label key={stage} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-stone-700 hover:bg-stone-50">
                    <input type="checkbox" checked={checked} onChange={() => toggleStage(stage)} className="accent-brand-500" />
                    {stageLabel(stage)}
                  </label>
                );
              })}
            </div>
          )}
        </div>
        {/* Status — multiple statuses can be viewed together. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setStatusMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={statusMenuOpen}
            className="rounded-xl px-3 py-1.5 text-sm text-left focus:outline-none focus:ring-2 focus:ring-brand-300 min-w-[150px] flex items-center justify-between gap-3"
            style={{ border: '1px solid #EDE8E3', background: selectedStatuses.length ? '#FDF4EF' : '#FDFAF7' }}
          >
            <span className="truncate">
              {selectedStatuses.length === 0
                ? 'All statuses'
                : selectedStatuses.length <= 2
                  ? selectedStatuses.map((status) => STATUS_FILTER_OPTIONS.find((option) => option.value === status)?.label ?? status).join(', ')
                  : `${selectedStatuses.length} statuses selected`}
            </span>
            <span className="text-stone-400" aria-hidden="true">⌄</span>
          </button>
          {statusMenuOpen && (
            <div role="menu" className="absolute z-30 mt-1 w-56 rounded-xl bg-white p-2 shadow-lg" style={{ border: '1px solid #EDE8E3' }}>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={selectedStatuses.length === 0}
                onClick={() => { setSF('status', ''); setStatusMenuOpen(false); }}
                className="w-full rounded-lg px-2.5 py-2 text-left text-sm text-stone-700 hover:bg-stone-50"
              >
                All statuses
              </button>
              <div className="my-1 border-t border-stone-100" />
              {STATUS_FILTER_OPTIONS.map((option) => (
                <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-stone-700 hover:bg-stone-50">
                  <input type="checkbox" checked={selectedStatuses.includes(option.value)} onChange={() => toggleStatus(option.value)} className="accent-brand-500" />
                  {option.label}
                </label>
              ))}
            </div>
          )}
        </div>
        {/* Source */}
        <select value={salesFilters.source} onChange={(e) => setSF('source', e.target.value)}
          className="rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
          style={{ border: '1px solid #EDE8E3', background: salesFilters.source ? '#FDF4EF' : '#FDFAF7' }}>
          <option value="">All sources</option>
          {crmSettings().leadSources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        {/* Expected OB date range — always visible in toolbar */}
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-stone-400 font-medium">OB:</span>
          <DateInput value={salesFilters.projectedObFrom} onChange={(v) => setSF('projectedObFrom', v)}
            className="rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-300 w-[112px]" />
          <span className="text-stone-300 text-xs">→</span>
          <DateInput value={salesFilters.projectedObTo} onChange={(v) => setSF('projectedObTo', v)}
            className="rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-300 w-[112px]" />
        </div>
        {/* More Filters */}
        <button
          onClick={() => setShowMoreFilters((v) => !v)}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-xl font-semibold transition-all ${
            showMoreFilters || moreFilterCount > 0
              ? 'bg-brand-50 text-brand-700 border border-brand-200'
              : 'text-stone-600 border border-stone-200 hover:bg-stone-50'
          }`}
        >
          <SlidersHorizontal size={12} />
          More Filters
          {moreFilterCount > 0 && (
            <span className="bg-brand-500 text-white text-[9px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
              {moreFilterCount}
            </span>
          )}
        </button>
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={clearFilters}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl text-stone-600 border border-stone-200 hover:bg-stone-50 hover:text-stone-800 font-medium"
            title="Clear all pipeline filters"
          >
            <X size={12} /> Clear filters
          </button>
        )}
        {/* Pipeline summary */}
        <div className="ml-auto text-xs text-gray-500 shrink-0 hidden md:flex items-center gap-3">
          <span>
            Total <span className="font-medium text-gray-800">{counts.all} leads</span>
            {' · '}
            <span className="font-medium text-gray-800">{fmtPipeline(totalValue)}</span>
          </span>
          <span className="text-gray-300">|</span>
          <span>
            Active <span className="font-medium text-green-700">{counts.active}</span>
            {' · '}
            <span className="font-medium text-green-700">{fmtPipeline(activeValue)}</span>
          </span>
        </div>
      </div>

      {/* More Filters panel — cohort member, Project type, Location, date ranges, budget, intent, OB dates */}
      {showMoreFilters && (
        <div className="bg-white px-5 py-4 shrink-0" style={{ borderBottom: '1px solid #EDE8E3' }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">

            {userRole === 'BL' && (
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Team Member</label>
                <select
                  value={salesFilters.designerId}
                  onChange={(e) => setSF('designerId', e.target.value)}
                  className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                  style={{ border: '1px solid #EDE8E3', background: salesFilters.designerId ? '#FDF4EF' : '#FDFAF7' }}
                >
                  <option value="">All team members</option>
                  {teamMembers.map((member) => (
                    <option key={member.id} value={member.id}>{member.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Project type */}
            <div>
              <label className="block text-xs font-semibold text-stone-500 mb-1.5">Project type</label>
              <input
                type="text"
                value={salesFilters.projectType}
                onChange={(e) => setSF('projectType', e.target.value)}
                placeholder="2BHK / Villa / Office"
                className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
              />
            </div>

            <LocationFilter value={salesFilters.location} onChange={(v) => setSF('location', v)} />

            {/* Lead origin date range */}
            <div>
              <label className="block text-xs font-semibold text-stone-500 mb-1.5">Lead origin date (from)</label>
              <DateInput
                value={salesFilters.originDateFrom}
                onChange={(v) => setSF('originDateFrom', v)}
                className="w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-500 mb-1.5">Lead origin date (to)</label>
              <DateInput
                value={salesFilters.originDateTo}
                onChange={(v) => setSF('originDateTo', v)}
                className="w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300"
              />
            </div>

            {/* Budget range */}
            <div>
              <label className="block text-xs font-semibold text-stone-500 mb-1.5">Client budget (min ₹)</label>
              <input
                type="number"
                value={salesFilters.budgetMin}
                onChange={(e) => setSF('budgetMin', e.target.value)}
                placeholder="e.g. 500000"
                className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-stone-500 mb-1.5">Client budget (max ₹)</label>
              <input
                type="number"
                value={salesFilters.budgetMax}
                onChange={(e) => setSF('budgetMax', e.target.value)}
                placeholder="e.g. 5000000"
                className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
              />
            </div>

            <PossessionFilter possession={salesFilters.possession} from={salesFilters.possessionDateFrom} to={salesFilters.possessionDateTo}
              onChange={(k, v) => setSF(k, v)} />

            {/* Intent rating (exact match) */}
            <div>
              <label className="block text-xs font-semibold text-stone-500 mb-1.5">Intent rating</label>
              <StarFilter value={salesFilters.intent} onChange={(v) => setSF('intent', v)} />
            </div>

          </div>

          {activeFilterCount > 0 && (
            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-stone-400">{activeFilterCount} filter{activeFilterCount > 1 ? 's' : ''} active</p>
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 font-medium"
              >
                <X size={11} /> Clear all filters
              </button>
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="space-y-3 w-full max-w-sm p-8">
            {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-gray-200 rounded-xl animate-pulse" />)}
          </div>
        </div>
      )}

      {/* Kanban board */}
      {!loading && showKanban && (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-3 h-full p-4 min-w-max">
            {kanbanColumns.map((stage) => {
              const cards = byStage(stage);
              const colVal = colValue(stage);
              const isDragTarget = dragOverStage === stage;
              const isDraggingFromHere = draggedLead?.stage === stage;
              return (
                <div
                  key={stage}
                  className="flex flex-col w-64 shrink-0 h-full"
                  onDragOver={handleDragOver}
                  onDragEnter={(e) => handleDragEnter(e, stage)}
                  onDragLeave={(e) => handleDragLeave(e, stage)}
                  onDrop={(e) => handleDrop(e, stage)}
                >
                  <div className={`rounded-xl mb-2 px-3 py-2.5 transition-colors ${
                    isDragTarget ? 'bg-brand-50 border-2 border-brand-300' : 'bg-gray-100 border-2 border-transparent'
                  }`}>
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${STAGE_ACCENT[stage]}`} />
                      <p className="text-xs font-semibold text-gray-800 flex-1 truncate">{stageLabel(stage)}</p>
                      <span className="text-xs font-bold text-gray-600 bg-white rounded-full w-5 h-5 flex items-center justify-center">
                        {cards.length}
                      </span>
                    </div>
                    {colVal > 0 && <p className="text-[10px] text-gray-500 ml-4">{fmt(colVal)}</p>}
                  </div>
                  <div className={`flex-1 overflow-y-auto space-y-2 pr-0.5 rounded-xl transition-colors min-h-[60px] ${
                    isDragTarget && !isDraggingFromHere ? 'bg-brand-50/50' : ''
                  }`}>
                    {cards.length === 0 && !isDragTarget && (
                      <div className="flex items-center justify-center py-8 border-2 border-dashed border-gray-200 rounded-xl text-xs text-gray-400">
                        No leads
                      </div>
                    )}
                    {cards.map((lead) => (
                      <LeadCard
                        key={lead.id}
                        lead={lead}
                        onDragStart={handleDragStart}
                        onDragEnd={handleDragEnd}
                        onOpenChecklist={setChecklistLead}
                      />
                    ))}
                    {isDragTarget && !isDraggingFromHere && (
                      <div className="border-2 border-dashed border-brand-300 rounded-xl h-20 flex items-center justify-center text-xs text-brand-500 font-medium">
                        Drop here
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}


      {/* Stage-change capture step (task #114) — confirm intent rating + project
          value before a drag-drop stage move is committed. */}
      {stageCapture && (
        <StageCaptureModal
          leadId={stageCapture.lead.id}
          leadName={stageCapture.lead.name}
          targetStageLabel={stageLabel(stageCapture.targetStage)}
          initialRating={stageCapture.lead.intentRating}
          initialValue={stageCapture.lead.estimatedValue}
          saving={stageCaptureSaving}
          error={stageCaptureError}
          onCancel={() => { setStageCapture(null); setStageCaptureError(null); }}
          onConfirm={confirmStageCapture}
        />
      )}

      {/* Blocked-drag modal — actionable resolution instead of a plain error toast */}
      {gateBlocked && (
        <GateBlockedModal
          lead={gateBlocked.lead}
          targetStageLabel={stageLabel(gateBlocked.targetStage)}
          details={gateBlocked.details}
          onClose={() => setGateBlocked(null)}
          onOpenChecklist={(lead) => { setGateBlocked(null); setChecklistLead(lead); }}
          onOverride={can('STAGE_OVERRIDE') ? (reason) => {
            const { lead, targetStage } = gateBlocked;
            setGateBlocked(null);
            commitDrop(lead, targetStage, { overrideReason: reason });
          } : undefined}
        />
      )}

      {/* Inline PD→OB / OBM→DIP checklist modal */}
      {checklistLead && (
        <ChecklistModal
          lead={checklistLead}
          onClose={() => setChecklistLead(null)}
          onDone={() => { setChecklistLead(null); load(); }}
        />
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────
export default function Pipeline() {
  const userRole = getCurrentUserRole();
  // Design Pipeline is a Designer-only view (CRE portal has no design pipeline).
  const isDesigner = userRole === 'DESIGNER';
  // Task #90 — nav can deep-link here via /pipeline?tab=design (the "Design
  // Pipeline" sidebar item), so read the initial tab from the URL instead of
  // always defaulting to sales.
  const [searchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') === 'design' && isDesigner ? 'design' : 'sales';
  const [tab, setTab] = useState<'sales' | 'design'>(initialTab);

  return (
    <div className="flex flex-col h-full">
      {/* Page header + top-level tab switcher */}
      <div className="bg-white px-5 py-3 flex items-center gap-4 shrink-0" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <div>
          <h1 className="text-lg font-extrabold text-stone-900 tracking-tight leading-tight">Pipeline</h1>
        </div>
        <div className="flex items-center gap-1 rounded-xl p-1 ml-2" style={{ background: '#F5F0EB' }}>
          <button
            onClick={() => setTab('sales')}
            className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
              tab === 'sales' ? 'bg-white text-stone-900 shadow-warm-sm' : 'text-stone-500 hover:text-stone-700'
            }`}
          >
            Sales Pipeline
          </button>
          {isDesigner && (
            <button
              onClick={() => setTab('design')}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all ${
                tab === 'design' ? 'bg-white text-stone-900 shadow-warm-sm' : 'text-stone-500 hover:text-stone-700'
              }`}
            >
              Design Pipeline
            </button>
          )}
        </div>
      </div>

      {tab === 'sales'  && <SalesPipelineView userRole={userRole} />}
      {tab === 'design' && isDesigner && <DesignPipelineView />}
    </div>
  );
}
