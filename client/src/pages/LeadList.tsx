import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Users, AlertTriangle, Search, SlidersHorizontal, X } from 'lucide-react';
import { api } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';
import StatusBadge, { STATUS_LABELS, STATUS_COLORS } from '../components/StatusBadge';
import { DateInput } from '../components/ui/DateTimeInputs';
import { stageLabel, crmSettings, sourceLabel } from '../lib/crmSettings';

/** Clickable star input for exact-match intent filter (e.g. "2 stars" shows only 2-star leads).
 * Mirrors the StarFilter in Pipeline.tsx so the two filter panels look identical. */
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

interface Lead {
  id: string; leadId: string; name: string; phone: string; email?: string;
  source?: string; stage: string; status: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE'; isSLABreached: boolean;
  estimatedValue?: string | null; intentRating?: number | null; isDuplicate?: boolean;
  daysLeadToDQL?: number | null; daysDQLToPP?: number | null; daysPPToOnboarding?: number | null;
  overallPipelineAgeDays?: number;
  designerAssignmentAgeDays?: number | null;
  onHoldRevivalDate?: string | null;
  firstOpenedAt?: string | null;
  isUnread?: boolean;
  avgNps?: number | null;
  createdAt: string; updatedAt: string;
  assignedDesigner?: { id: string; name: string } | null;
  assignedBL?: { id: string; name: string } | null;
  _count: { calls: number; meetings: number; followUpTasks: number };
  // CRE module Stage 1 fields
  assignedCREId?: string | null;
  leadAgeAtMQL?: number | null;
}

interface AllocationOption {
  id: string;
  name: string;
  role: 'DESIGNER' | 'BL';
}

function NpsBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-stone-300 text-xs">—</span>;
  const color = score >= 9 ? 'bg-green-100 text-green-700' : score >= 7 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700';
  return <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${color}`}>{score}</span>;
}

const STAGE_COLORS: Record<string, string> = {
  EFFECTIVE_LEAD: 'bg-stone-100 text-stone-700',
  MQL: 'bg-amber-100 text-amber-800',
  DQL: 'bg-orange-100 text-orange-800',
  PROPOSAL_READY: 'bg-brand-50 text-brand-700',
  PROPOSAL_PRESENTED: 'bg-brand-100 text-brand-700',
  PROPOSAL_DISCUSSION: 'bg-purple-100 text-purple-700',
  ONBOARDING: 'bg-green-100 text-green-700',
  ONBOARDING_MEETING: 'bg-teal-100 text-teal-700',
  DESIGN_IN_PROGRESS: 'bg-emerald-100 text-emerald-700',
  HANDED_OVER: 'bg-emerald-100 text-emerald-700',
  // Legacy stage values, kept only for historical rows — no longer assignable.
  INACTIVE: 'bg-stone-100 text-stone-500',
  ON_HOLD: 'bg-stone-100 text-stone-600',
};

// Stage names come from stageLabel() (Admin → CRM Settings) — the abbreviations that
// used to live here (PP/PD/EL) disagreed with the Sales Pipeline's full-name
// labels for the exact same enum values, which was confusing when comparing
// the two views of the same leads.

// Task #88: ON_HOLD/INACTIVE are status values, not stages — dropped from
// the stage filter options (the separate Status filter covers them).
const STAGE_OPTIONS_ALL = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
  'HANDED_OVER',
];
const STAGE_OPTIONS_DESIGNER = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
  'HANDED_OVER',
];

// Standard completed-TAT targets for the three sales milestones displayed in
// the designer lead table. Overall Pipeline Age stays neutral because it is a
// live age (not necessarily a completed milestone).
const TAT_STANDARD_DAYS = {
  leadToDql: 5,
  dqlToPp: 2,
  ppToOnboarding: 7,
} as const;

function tatColor(days: number | null | undefined, standardDays: number): string {
  if (days == null) return 'text-stone-400';
  if (days < standardDays) return 'text-emerald-600';
  if (days > standardDays) return 'text-red-600';
  return 'text-stone-500';
}

function tatTitle(days: number | null | undefined, standardDays: number): string | undefined {
  if (days == null) return undefined;
  if (days < standardDays) return `Completed ${standardDays - days} day(s) ahead of the ${standardDays}-day standard TAT`;
  if (days > standardDays) return `Completed ${days - standardDays} day(s) after the ${standardDays}-day standard TAT`;
  return `Completed within the ${standardDays}-day standard TAT`;
}

function getCurrentUserRole(): string {
  try {
    const raw = localStorage.getItem('crm_user');
    if (!raw) return '';
    return JSON.parse(raw)?.role ?? '';
  } catch { return ''; }
}

function intentLabel(r?: number | null) {
  if (!r) return '—';
  if (r <= 2) return 'Low';
  if (r === 3) return 'Medium';
  return 'High';
}

function intentColor(r?: number | null) {
  if (!r) return 'text-gray-400';
  if (r <= 2) return 'text-gray-500';
  if (r === 3) return 'text-amber-600';
  return 'text-green-600 font-medium';
}

function Stars({ rating }: { rating?: number | null }) {
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={`text-sm ${i < (rating ?? 0) ? 'text-amber-400' : 'text-gray-200'}`}>★</span>
      ))}
    </span>
  );
}

function fmtVal(v?: string | number | null) {
  if (!v) return '—';
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return '—';
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

function relTime(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function avatar(name?: string | null) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-5 h-5 rounded-full bg-brand-100 text-brand-700 text-xs font-semibold flex items-center justify-center shrink-0">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="text-gray-700 text-xs truncate max-w-[80px]">{name}</span>
    </span>
  );
}

export default function LeadList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [teamMembers, setTeamMembers] = useState<{ id: string; name: string }[]>([]);
  const [allocationOptions, setAllocationOptions] = useState<AllocationOption[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  // Column sorting is done by the server so it holds across pages (and in the export).
  const [sort, setSort] = useState<{ by: string; dir: 'asc' | 'desc' } | null>(null);
  const [exporting, setExporting] = useState(false);
  // Seed filters from the URL so links elsewhere in the app (e.g. dashboard
  // KPI tiles) can deep-link into a pre-filtered list, e.g. /leads?status=ACTIVE.
  const [filters, setFilters] = useState({
    search: '',
    stage: searchParams.get('stage') ?? '',
    source: searchParams.get('source') ?? '',
    status: searchParams.get('status') ?? '',
    designerId: searchParams.get('designerId') ?? '',
    allocatedToId: searchParams.get('allocatedToId') ?? '',
    projectType: '',
    location: '',
    originDateFrom: '',
    originDateTo: '',
    budgetMin: '',
    budgetMax: '',
    possessionDateFrom: '',
    possessionDateTo: '',
    intent: searchParams.get('intent') ?? '',
    intentMin: searchParams.get('intentMin') ?? '',
    intentMax: searchParams.get('intentMax') ?? '',
    projectedObFrom: searchParams.get('projectedObFrom') ?? '',
    projectedObTo: searchParams.get('projectedObTo') ?? '',
    slaBreached: searchParams.get('slaBreached') ?? '',
    excludeStages: searchParams.get('excludeStages') ?? '',
    hasUnresolvedSlaBreach: searchParams.get('hasUnresolvedSlaBreach') ?? '',
    // From a dashboard number: only the leads that number counted (yours /
    // your team's), even when Lead Routing & Access lets you see more.
    mine: searchParams.get('mine') ?? '',
  });
  const [statusSummary, setStatusSummary] = useState<Record<string, { count: number; value: number }> | null>(null);

  const userRole = getCurrentUserRole();
  const STAGE_OPTIONS = userRole === 'DESIGNER' ? STAGE_OPTIONS_DESIGNER : STAGE_OPTIONS_ALL;

  useEffect(() => {
    api.get<{ users: AllocationOption[] }>('/leads/meta/allocated-users')
      .then((data) => setAllocationOptions(data.users ?? []))
      .catch((error: any) => toast.error(error.message || 'Could not load allocation options'));
  }, []);

  // BL cohort members come from a role-scoped endpoint; BLs cannot access the
  // broader admin user directory.
  useEffect(() => {
    if (userRole !== 'BL') return;
    api.get<{ members: { id: string; name: string }[] }>('/leads/meta/team-members')
      .then((data) => setTeamMembers(data.members ?? []))
      .catch((error: any) => toast.error(error.message || 'Could not load team members'));
  }, [userRole]);

  // Task #88 — overall Active / On Hold / Inactive counts + value, independent of the current filters.
  useEffect(() => {
    api.get<{ overall: Record<string, { count: number; value: number }> }>('/leads/meta/status-summary')
      .then((d) => setStatusSummary(d.overall ?? null))
      .catch(() => {});
  }, [leads]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '50' });
      if (filters.search) params.set('search', filters.search);
      if (filters.stage) params.set('stage', filters.stage);
      if (filters.source) params.set('source', filters.source);
      if (filters.status) params.set('status', filters.status);
      if (filters.designerId) params.set('designerId', filters.designerId);
      if (filters.allocatedToId) params.set('allocatedToId', filters.allocatedToId);
      if (filters.projectType) params.set('projectType', filters.projectType);
      if (filters.location) params.set('location', filters.location);
      if (filters.originDateFrom) params.set('originDateFrom', filters.originDateFrom);
      if (filters.originDateTo) params.set('originDateTo', filters.originDateTo);
      if (filters.budgetMin) params.set('budgetMin', filters.budgetMin);
      if (filters.budgetMax) params.set('budgetMax', filters.budgetMax);
      if (filters.possessionDateFrom) params.set('possessionDateFrom', filters.possessionDateFrom);
      if (filters.possessionDateTo) params.set('possessionDateTo', filters.possessionDateTo);
      if (filters.intent) params.set('intent', filters.intent);
      if (filters.intentMin) params.set('intentMin', filters.intentMin);
      if (filters.intentMax) params.set('intentMax', filters.intentMax);
      if (filters.projectedObFrom) params.set('projectedObFrom', filters.projectedObFrom);
      if (filters.projectedObTo) params.set('projectedObTo', filters.projectedObTo);
      if (filters.slaBreached) params.set('isSLABreached', filters.slaBreached);
      if (filters.excludeStages) params.set('excludeStages', filters.excludeStages);
      if (filters.hasUnresolvedSlaBreach) params.set('hasUnresolvedSlaBreach', filters.hasUnresolvedSlaBreach);
      if (filters.mine) params.set('mine', filters.mine);
      if (sort) { params.set('sort', sort.by); params.set('dir', sort.dir); }
      const data = await api.get<{ leads: Lead[]; total: number; pages: number }>(`/leads?${params}`);
      setLeads(data.leads);
      setTotal(data.total);
      setPages(data.pages);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  }, [page, filters, sort]);

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

  // The canonical create form lives in Layout, so refresh this list when that
  // form succeeds instead of waiting for a navigation or full-page reload.
  useEffect(() => {
    const handleLeadCreated = () => {
      if (page === 1) {
        void load();
      } else {
        setPage(1);
      }
    };
    window.addEventListener('lead-created', handleLeadCreated);
    return () => window.removeEventListener('lead-created', handleLeadCreated);
  }, [load, page]);

  /** The canonical "New Lead" form lives in the global Layout modal (opened from
   * the sidebar) so there is exactly one create flow, one set of validation
   * rules, and one field order. This page's "+ New Lead" button just opens it. */
  const openNewLeadModal = () => window.dispatchEvent(new CustomEvent('open-new-lead-modal'));

  const handleExport = async (fmt: 'csv' | 'xlsx') => {
    setExporting(true);
    try {
      const exportParams = new URLSearchParams();
      if (filters.search) exportParams.set('search', filters.search);
      if (filters.stage) exportParams.set('stage', filters.stage);
      if (filters.source) exportParams.set('source', filters.source);
       if (filters.status) exportParams.set('status', filters.status);
       if (filters.designerId) exportParams.set('designerId', filters.designerId);
        if (filters.allocatedToId) exportParams.set('allocatedToId', filters.allocatedToId);
       if (filters.projectType) exportParams.set('projectType', filters.projectType);
       if (filters.location) exportParams.set('location', filters.location);
       if (filters.originDateFrom) exportParams.set('originDateFrom', filters.originDateFrom);
       if (filters.originDateTo) exportParams.set('originDateTo', filters.originDateTo);
       if (filters.budgetMin) exportParams.set('budgetMin', filters.budgetMin);
       if (filters.budgetMax) exportParams.set('budgetMax', filters.budgetMax);
       if (filters.possessionDateFrom) exportParams.set('possessionDateFrom', filters.possessionDateFrom);
       if (filters.possessionDateTo) exportParams.set('possessionDateTo', filters.possessionDateTo);
       if (filters.intent) exportParams.set('intent', filters.intent);
       if (filters.projectedObFrom) exportParams.set('projectedObFrom', filters.projectedObFrom);
       if (filters.projectedObTo) exportParams.set('projectedObTo', filters.projectedObTo);
      if (sort) { exportParams.set('sort', sort.by); exportParams.set('dir', sort.dir); }
      if (fmt === 'xlsx') exportParams.set('format', 'xlsx');
      const resp = await fetch(`/api/leads/export?${exportParams}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('crm_token')}` },
      });
      if (!resp.ok) { toast.error('Export failed'); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leads_export_${new Date().toISOString().slice(0, 10)}.${fmt}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`${fmt.toUpperCase()} downloaded`);
    } catch {
      toast.error('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const setFilter = (k: keyof typeof filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  const clearFilters = () => {
    setFilters({
      search: '', stage: '', source: '', status: '', designerId: '', allocatedToId: '', projectType: '', location: '',
      originDateFrom: '', originDateTo: '', budgetMin: '', budgetMax: '',
      possessionDateFrom: '', possessionDateTo: '', intent: '',
      intentMin: '', intentMax: '', projectedObFrom: '', projectedObTo: '', slaBreached: '', excludeStages: '',
      hasUnresolvedSlaBreach: '', mine: '',
    });
    setPage(1);
  };
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  // Badge counts only the "more" filters — Stage/Status/Source are always visible upfront.
  const moreFilterCount = [
    ...(userRole === 'BL' ? [filters.designerId] : []),
    filters.projectType, filters.location, filters.originDateFrom, filters.originDateTo,
    filters.budgetMin, filters.budgetMax, filters.possessionDateFrom, filters.possessionDateTo,
    filters.intent, filters.intentMin, filters.intentMax,
  ].filter(Boolean).length;
  const anyFilterActive = Object.values(filters).some(Boolean);

  return (
    <div className="min-h-screen">
      {/* Top bar */}
      <div className="bg-white px-6 py-4" style={{ borderBottom: '1px solid #EDE8E3' }}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-extrabold text-stone-900 tracking-tight">Leads</h1>
            {filters.mine ? (
              <p className="text-xs text-stone-500 mt-0.5" data-testid="mine-note">
                Only the leads your dashboard counted ·{' '}
                <button onClick={() => { setFilters((f) => ({ ...f, mine: '' })); setPage(1); }} className="text-brand-600 hover:underline">Show all leads you can see</button>
              </p>
            ) : <p className="text-xs text-stone-400 mt-0.5">All leads in your scope</p>}
          </div>
          <div className="flex items-center gap-2">
            {/* Task #90 — export controls are admin/BL only; the designer/CRE
                portal no longer surfaces them (they're read-only on scope
                anyway). Excel export is Branch Head admin-only. */}
            {userRole !== 'DESIGNER' && userRole !== 'CRE' && (
              <button
                onClick={() => handleExport('csv')}
                disabled={exporting}
                className="text-stone-600 px-3 py-2 rounded-xl text-sm hover:bg-stone-50 disabled:opacity-50 transition-colors font-medium"
                style={{ border: '1px solid #EDE8E3' }}
              >
                {exporting ? 'Exporting…' : '↓ Export CSV'}
              </button>
            )}
            {userRole === 'BRANCH_HEAD' && (
              <button
                onClick={() => handleExport('xlsx')}
                disabled={exporting}
                className="text-stone-600 px-3 py-2 rounded-xl text-sm hover:bg-stone-50 disabled:opacity-50 transition-colors font-medium"
                style={{ border: '1px solid #EDE8E3' }}
              >
                {exporting ? 'Exporting…' : '↓ Export Excel'}
              </button>
            )}
            <button
              onClick={openNewLeadModal}
              className="bg-brand-500 text-white px-4 py-2 rounded-xl text-sm font-semibold hover:bg-brand-600 transition-colors"
            >
              + New Lead
            </button>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 space-y-4">
        {/* Task #88 — status split summary */}
        {statusSummary && (
          <div className="grid grid-cols-3 gap-3">
            {(['ACTIVE', 'ON_HOLD', 'INACTIVE'] as const).map((s) => (
              <div key={s} className="bg-white rounded-2xl px-4 py-3 shadow-warm-sm flex items-center justify-between" style={{ border: '1px solid #EDE8E3' }}>
                <div>
                  <p className="text-xs font-semibold text-stone-500">{STATUS_LABELS[s]}</p>
                  <p className="text-lg font-extrabold text-stone-900">{statusSummary[s]?.count ?? 0}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${STATUS_COLORS[s]}`}>
                  {fmtVal(statusSummary[s]?.value ?? 0)}
                </span>
              </div>
            ))}
          </div>
        )}
        {/* Filter toolbar — Search/Stage/Status/Source always visible; More Filters expands the rest */}
        <div className="bg-white rounded-2xl px-4 py-3 flex flex-wrap items-center gap-2 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          {/* Search */}
          <div className="flex items-center rounded-xl overflow-hidden flex-1 min-w-[180px]" style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
            <Search size={14} className="ml-2.5 text-gray-400 shrink-0" />
            <input
              value={filters.search}
              onChange={(e) => setFilter('search', e.target.value)}
              placeholder="Search name, ID, phone, location…"
              className="bg-transparent px-2 py-1.5 text-sm text-gray-800 placeholder-gray-400 focus:outline-none flex-1"
            />
          </div>
          {/* Stage */}
          <select value={filters.stage} onChange={(e) => setFilter('stage', e.target.value)}
            className="rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
            style={{ border: '1px solid #EDE8E3', background: filters.stage ? '#FDF4EF' : '#FDFAF7' }}>
            <option value="">All stages</option>
            {STAGE_OPTIONS.map((s) => <option key={s} value={s}>{stageLabel(s)}</option>)}
          </select>
          {/* Status */}
          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            className="rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
            style={{ border: '1px solid #EDE8E3', background: filters.status ? '#FDF4EF' : '#FDFAF7' }}>
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="ON_HOLD">On Hold</option>
            <option value="INACTIVE">Inactive</option>
          </select>
          {/* Source */}
          <select value={filters.source} onChange={(e) => setFilter('source', e.target.value)}
            className="rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
            style={{ border: '1px solid #EDE8E3', background: filters.source ? '#FDF4EF' : '#FDFAF7' }}>
            <option value="">All sources</option>
            {crmSettings().leadSources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {/* Lead allocation — matches either the assigned Designer or BL */}
          <select
            aria-label="Lead allocated to"
            value={filters.allocatedToId}
            onChange={(e) => setFilter('allocatedToId', e.target.value)}
            className="rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 max-w-[190px]"
            style={{ border: '1px solid #EDE8E3', background: filters.allocatedToId ? '#FDF4EF' : '#FDFAF7' }}
          >
            <option value="">Lead allocated to</option>
            <optgroup label="Designers">
              {allocationOptions.filter((option) => option.role === 'DESIGNER').map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </optgroup>
            <optgroup label="BLs">
              {allocationOptions.filter((option) => option.role === 'BL').map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </optgroup>
          </select>
          {/* Expected OB date range — always visible in toolbar */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-stone-400 font-medium">OB:</span>
            <DateInput value={filters.projectedObFrom} onChange={(v) => setFilter('projectedObFrom', v)}
              className={`rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-300 w-[112px] ${filters.projectedObFrom ? 'bg-[#FDF4EF]' : 'bg-[#FDFAF7]'}`} />
            <span className="text-stone-300 text-xs">→</span>
            <DateInput value={filters.projectedObTo} onChange={(v) => setFilter('projectedObTo', v)}
              className={`rounded-xl px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-300 w-[112px] ${filters.projectedObTo ? 'bg-[#FDF4EF]' : 'bg-[#FDFAF7]'}`} />
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
        </div>

        {/* More Filters panel — cohort member, Project type, Location, date ranges, budget, intent, OB dates */}
        {showMoreFilters && (
          <div className="bg-white rounded-2xl px-5 py-4 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">

              {userRole === 'BL' && (
                <div>
                  <label className="block text-xs font-semibold text-stone-500 mb-1.5">Team Member</label>
                  <select
                    value={filters.designerId}
                    onChange={(e) => setFilter('designerId', e.target.value)}
                    className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                    style={{ border: '1px solid #EDE8E3', background: filters.designerId ? '#FDF4EF' : '#FDFAF7' }}
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
                <input value={filters.projectType} onChange={(e) => setFilter('projectType', e.target.value)}
                  placeholder="2BHK / Villa / Office"
                  className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>

              {/* Location */}
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Location</label>
                <input value={filters.location} onChange={(e) => setFilter('location', e.target.value)}
                  placeholder="Whitefield, Bangalore"
                  className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>

              {/* Lead origin date range */}
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Lead origin date (from)</label>
                <DateInput value={filters.originDateFrom} onChange={(v) => setFilter('originDateFrom', v)}
                  className="w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Lead origin date (to)</label>
                <DateInput value={filters.originDateTo} onChange={(v) => setFilter('originDateTo', v)}
                  className="w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>

              {/* Budget range */}
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Client budget (min ₹)</label>
                <input type="number" value={filters.budgetMin} onChange={(e) => setFilter('budgetMin', e.target.value)}
                  placeholder="e.g. 500000"
                  className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Client budget (max ₹)</label>
                <input type="number" value={filters.budgetMax} onChange={(e) => setFilter('budgetMax', e.target.value)}
                  placeholder="e.g. 5000000"
                  className="w-full rounded-xl px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>

              {/* Possession date range */}
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Possession date (from)</label>
                <DateInput value={filters.possessionDateFrom} onChange={(v) => setFilter('possessionDateFrom', v)}
                  className="w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Possession date (to)</label>
                <DateInput value={filters.possessionDateTo} onChange={(v) => setFilter('possessionDateTo', v)}
                  className="w-full rounded-xl px-3 py-1.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300" />
              </div>

              {/* Intent rating (exact match) */}
              <div>
                <label className="block text-xs font-semibold text-stone-500 mb-1.5">Intent rating</label>
                <StarFilter value={filters.intent} onChange={(v) => setFilter('intent', v)} />
              </div>

            </div>

            {anyFilterActive && (
              <div className="mt-3 flex items-center justify-between">
                <p className="text-xs text-stone-400">Filters active</p>
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

        {/* Count + Table */}
        <div className="bg-white rounded-2xl overflow-hidden shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
          <div className="px-4 py-2.5 flex items-center justify-between" style={{ borderBottom: '1px solid #EDE8E3' }}>
            <p className="text-xs text-stone-500 font-medium">
              {loading ? 'Loading…' : `${leads.length} of ${total} leads`}
            </p>
          </div>

          {loading ? (
            <div className="py-16 text-center text-stone-400 text-sm animate-pulse">Loading leads…</div>
          ) : leads.length === 0 ? (
            <EmptyState Icon={Users} title="No leads found" description="Try adjusting your filters or create a new lead"
              action={{ label: '+ New Lead', onClick: openNewLeadModal }} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr style={{ background: '#FAF6F2', borderBottom: '1px solid #EDE8E3' }}>
                      {(userRole === 'DESIGNER'
                        ? [['Lead ID', 'leadId'], ['Name', 'name'], ['Stage', 'stage'], ['Status', 'status'], ['Value', 'value'], ['Source', 'source'], ['MQL→DQL'], ['DQL→PP'], ['PP→OB'], ['Designer Assignment Age'], ['Created', 'created'], ['Updated', 'updated']]
                        : [['Lead ID', 'leadId'], ['Name', 'name'], ['Stage', 'stage'], ['Status', 'status'], ['Value', 'value'], ['Designer', 'designer'], ['Source', 'source'], ['Intent', 'intent'], ['Rating'], ['Created', 'created'], ['Updated', 'updated']]
                      ).map(([h, key]) => (
                        <th key={h}
                          aria-sort={key && sort?.by === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                          className="text-left py-2.5 px-4 text-xs font-bold text-stone-500 uppercase tracking-widest whitespace-nowrap">
                          {key ? (
                            <button type="button" title={`Sort by ${h}`} data-testid={`sort-${key}`}
                              onClick={() => { setSort((c) => c?.by === key ? { by: key, dir: c.dir === 'asc' ? 'desc' : 'asc' } : { by: key, dir: ['value', 'intent', 'created', 'updated'].includes(key) ? 'desc' : 'asc' }); setPage(1); }}
                              className="uppercase tracking-widest font-bold hover:text-stone-800 inline-flex items-center gap-1">
                              {h}<span className="text-[9px]">{sort?.by === key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                            </button>
                          ) : h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {leads.map((lead) => {
                      const status = lead.status;
                      const isUnread = lead.isUnread && lead.assignedDesigner;
                      return (
                        <tr
                          key={lead.id}
                          onClick={() => navigate(`/leads/${lead.id}`)}
                          className="cursor-pointer transition-colors"
                          style={{
                            borderBottom: '1px solid #F5F0EB',
                            borderLeft: isUnread ? '3px solid #d95f32' : '3px solid transparent',
                            background: isUnread ? '#FDFAF7' : undefined,
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = '#FAF6F2')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = isUnread ? '#FDFAF7' : '')}
                        >
                          <td className="py-3 px-4">
                            <span className="text-brand-600 font-mono text-xs font-bold">{lead.leadId}</span>
                            {lead.isSLABreached && <AlertTriangle size={10} strokeWidth={2.5} className="ml-1 text-red-400 inline" />}
                            {isUnread && <span className="ml-1.5 text-[9px] font-bold bg-brand-100 text-brand-600 px-1.5 py-0.5 rounded-full">NEW</span>}
                            {lead.isDuplicate && <span className="ml-1.5 text-[9px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full" title="Flagged as a duplicate enquiry">Duplicate</span>}
                          </td>
                          <td className="py-3 px-4 whitespace-nowrap">
                            {/* Task #90 — NPS shown right next to the name instead of its own column */}
                            <span className="flex items-center gap-1.5">
                              <span className={isUnread ? 'font-extrabold text-stone-900' : 'font-semibold text-stone-900'}>{lead.name}</span>
                              <NpsBadge score={lead.avgNps} />
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${STAGE_COLORS[lead.stage] ?? 'bg-stone-100 text-stone-600'}`}>
                              {stageLabel(lead.stage)}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            <StatusBadge
                              status={status}
                              title={status === 'ON_HOLD' && lead.onHoldRevivalDate ? `Reopens ${new Date(lead.onHoldRevivalDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}` : undefined}
                            />
                            {status === 'ON_HOLD' && lead.onHoldRevivalDate && (
                              <span className="ml-1.5 text-[10px] text-stone-400 whitespace-nowrap">
                                ↺ {new Date(lead.onHoldRevivalDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })}
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-stone-700 text-xs font-medium whitespace-nowrap">{fmtVal(lead.estimatedValue)}</td>
                          {userRole !== 'DESIGNER' && (
                            <td className="py-3 px-4">{avatar(lead.assignedDesigner?.name) ?? <span className="text-stone-300 text-xs">—</span>}</td>
                          )}
                          <td className="py-3 px-4 text-stone-500 text-xs whitespace-nowrap">{lead.source ? sourceLabel(lead.source) : '—'}</td>
                          {userRole === 'DESIGNER' ? (
                            <>
                              <td title={tatTitle(lead.daysLeadToDQL, TAT_STANDARD_DAYS.leadToDql)} className={`py-3 px-4 text-xs text-center tabular-nums font-semibold ${tatColor(lead.daysLeadToDQL, TAT_STANDARD_DAYS.leadToDql)}`}>{lead.daysLeadToDQL != null ? `${lead.daysLeadToDQL}d` : '—'}</td>
                              <td title={tatTitle(lead.daysDQLToPP, TAT_STANDARD_DAYS.dqlToPp)} className={`py-3 px-4 text-xs text-center tabular-nums font-semibold ${tatColor(lead.daysDQLToPP, TAT_STANDARD_DAYS.dqlToPp)}`}>{lead.daysDQLToPP != null ? `${lead.daysDQLToPP}d` : '—'}</td>
                              <td title={tatTitle(lead.daysPPToOnboarding, TAT_STANDARD_DAYS.ppToOnboarding)} className={`py-3 px-4 text-xs text-center tabular-nums font-semibold ${tatColor(lead.daysPPToOnboarding, TAT_STANDARD_DAYS.ppToOnboarding)}`}>{lead.daysPPToOnboarding != null ? `${lead.daysPPToOnboarding}d` : '—'}</td>
                              <td title={lead.designerAssignmentAgeDays == null ? 'A reliable assignment date is not recorded for this lead.' : 'Days from assignment to this Designer, ending at DIP if reached.'} className="py-3 px-4 text-stone-700 text-xs text-center tabular-nums font-semibold">{lead.designerAssignmentAgeDays != null ? `${lead.designerAssignmentAgeDays}d` : '—'}</td>
                            </>
                          ) : (
                            <>
                              <td className={`py-3 px-4 text-xs ${intentColor(lead.intentRating)}`}>{intentLabel(lead.intentRating)}</td>
                              <td className="py-3 px-4"><Stars rating={lead.intentRating} /></td>
                            </>
                          )}
                          <td className="py-3 px-4 text-stone-400 text-xs whitespace-nowrap">{new Date(lead.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</td>
                          <td className="py-3 px-4 text-stone-400 text-xs whitespace-nowrap">{relTime(lead.updatedAt)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {pages > 1 && (
                <div className="px-4 py-3 flex items-center justify-between" style={{ borderTop: '1px solid #EDE8E3' }}>
                  <p className="text-xs text-stone-400">Page {page} of {pages}</p>
                  <div className="flex gap-2">
                    <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                      className="text-xs px-3 py-1.5 rounded-xl disabled:opacity-40 hover:bg-stone-50 transition-colors"
                      style={{ border: '1px solid #EDE8E3' }}>
                      ← Prev
                    </button>
                    <button onClick={() => setPage((p) => Math.min(pages, p + 1))} disabled={page === pages}
                      className="text-xs px-3 py-1.5 rounded-xl disabled:opacity-40 hover:bg-stone-50 transition-colors"
                      style={{ border: '1px solid #EDE8E3' }}>
                      Next →
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
