import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Users2, CalendarDays, Activity, AlertTriangle, CheckCircle2, Circle, Star, Tag, Trash2, Upload, Target, Megaphone, Route, FileText, SlidersHorizontal, Zap, LayoutDashboard, ShieldCheck, ListChecks, BarChart3, Shuffle, CalendarClock, Bell, Calculator, Type, type LucideIcon } from 'lucide-react';
import { api, uploadFile } from '../lib/api';
import EmptyState from '../components/ui/EmptyState';
import { DateInput } from '../components/ui/DateTimeInputs';
import IncentiveRulesAdmin from '../components/admin/IncentiveRulesAdmin';
import DashboardContentAdmin from '../components/admin/DashboardContentAdmin';
import StageRulesAdmin from '../components/admin/StageRulesAdmin';
import DocumentTypesAdmin from '../components/admin/DocumentTypesAdmin';
import CrmSettingsAdmin from '../components/admin/CrmSettingsAdmin';
import AutomationsAdmin from '../components/admin/AutomationsAdmin';
import DashboardsAdmin from '../components/admin/DashboardsAdmin';
import PermissionsAdmin from '../components/admin/PermissionsAdmin';
import ChecklistsAdmin from '../components/admin/ChecklistsAdmin';
import ReportsNpsAdmin from '../components/admin/ReportsNpsAdmin';
import LeadRoutingAdmin from '../components/admin/LeadRoutingAdmin';
import MeetingsAdmin from '../components/admin/MeetingsAdmin';
import AlertsAdmin from '../components/admin/AlertsAdmin';
import FormulasAdmin from '../components/admin/FormulasAdmin';
import WordingAdmin from '../components/admin/WordingAdmin';
import { cycleDescription } from '../lib/crmSettings';
import { wording } from '../lib/wording';

interface User {
  id: string; name: string; email: string; role: string;
  designation?: string | null;
  isActive: boolean; blId?: string; designManagerId?: string;
  bl?: { id: string; name: string } | null;
  designManager?: { id: string; name: string } | null;
  _count: { designerLeads: number; blLeads: number };
}

// Display-only title layered on role — no permission changes (task #79).
const DESIGNATION_LABELS: Record<string, string> = {
  DESIGN_TEAM_LEAD: 'Design Team Lead',
};
interface Health {
  db: string; totalLeads: number; totalUsers: number; activeBreaches: number;
  redisConfigured: boolean; smtpConfigured: boolean; twilioConfigured: boolean;
  metaConfigured: boolean; baseUrl: string;
  reportSchedules: { type: string; lastSentAt?: string }[];
}
interface Schedule { id: string; type: string; recipients: string[]; lastSentAt?: string }
interface DeactivatePreview {
  activeLeads: number;
  leads: { id: string; leadId: string; name: string; stage: string }[];
}

const ROLE_COLORS: Record<string, string> = {
  DESIGNER: 'bg-blue-100 text-blue-700',
  CRE: 'bg-purple-100 text-purple-700',
  BL: 'bg-amber-100 text-amber-700',
  DESIGN_MANAGER: 'bg-indigo-100 text-indigo-700',
  BRANCH_HEAD: 'bg-green-100 text-green-700',
};

type AdminTab = 'users' | 'schedules' | 'health' | 'nps' | 'offers' | 'import' | 'targets' | 'credits' | 'content' | 'stageRules' | 'docTypes' | 'crmSettings' | 'automations' | 'dashboards' | 'permissions' | 'checklists' | 'reportsNps' | 'leadRouting' | 'meetings' | 'alerts' | 'formulas' | 'wording';

interface ImportPreviewRow {
  row: number; status: 'WILL_IMPORT' | 'DUPLICATE' | 'INVALID';
  name: string | null; phone: string | null; email?: string | null;
  source?: string | null; stage?: string; leadStatus?: string; leadId?: string;
  reason?: string;
  assignmentOutcome?: 'PRESERVED' | 'AUTO_ALLOCATED' | 'ALLOCATION_PENDING' | 'MANUAL_REVIEW';
}
interface ImportResult {
  dryRun: boolean; status: string; total: number; imported: number; skipped: number;
  errors: string[]; preview: ImportPreviewRow[];
  assignmentCounts?: { preserved: number; allocated: number; manualReview: number };
}

interface OfferOption { id: string; label: string; isActive: boolean; sortOrder: number }

interface TargetRow {
  designerId: string; name: string; email: string;
  target: {
    id: string; bookingTargetValue: number; poTargetValue: number; conversionTargetPct: number | null;
    averageBookingValueTarget: number | null; dipTargetCount: number | null; locked: boolean; updatedAt: string;
  } | null;
}
interface TargetsResponse {
  cycle: { cycleStart: string; cycleEnd: string; label: string };
  designers: TargetRow[];
}

interface NpsRow {
  leadDbId: string; leadId: string; leadName: string;
  designerId: string | null; designerName: string;
  scores: Record<string, number>;
  avgNps: number | null;
}

export default function Admin() {
  const [tab, setTab] = useState<AdminTab>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteForm, setInviteForm] = useState({ name: '', email: '', role: 'DESIGNER', blId: '', designManagerId: '', designation: '' });
  const [inviting, setInviting] = useState(false);
  const [scheduleForm, setScheduleForm] = useState({ type: 'WEEKLY', recipientIds: '' });

  const [deactivateTarget, setDeactivateTarget] = useState<User | null>(null);
  const [deactivatePreview, setDeactivatePreview] = useState<DeactivatePreview | null>(null);
  const [deactivateLoading, setDeactivateLoading] = useState(false);
  const [reassignDesignerId, setReassignDesignerId] = useState('');
  const [deactivating, setDeactivating] = useState(false);

  const [npsRows, setNpsRows] = useState<NpsRow[]>([]);
  const [npsLoading, setNpsLoading] = useState(false);
  const [npsDesignerFilter, setNpsDesignerFilter] = useState('');
  const [npsDateFrom, setNpsDateFrom] = useState('');
  const [npsDateTo, setNpsDateTo] = useState('');
  const [npsSortCol, setNpsSortCol] = useState<string>('avgNps');
  const [npsSortDir, setNpsSortDir] = useState<'asc' | 'desc'>('desc');

  const [offers, setOffers] = useState<OfferOption[]>([]);
  const [offersLoading, setOffersLoading] = useState(false);
  const [newOfferLabel, setNewOfferLabel] = useState('');
  const [savingOffer, setSavingOffer] = useState(false);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importStatus, setImportStatus] = useState<'ACTIVE' | 'INACTIVE' | 'ON_HOLD'>('ACTIVE');
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null);
  const [importRunning, setImportRunning] = useState(false);
  const [importCommitted, setImportCommitted] = useState<ImportResult | null>(null);

  const [targetsData, setTargetsData] = useState<TargetsResponse | null>(null);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetDrafts, setTargetDrafts] = useState<Record<string, {
    bookingTargetValue: string; poTargetValue: string; conversionTargetPct: string; averageBookingValueTarget: string; dipTargetCount: string;
  }>>({});
  const [savingTargetFor, setSavingTargetFor] = useState<string | null>(null);

  const bls = users.filter((u) => u.role === 'BL' && u.isActive);
  const activeDesigners = users.filter((u) => u.role === 'DESIGNER' && u.isActive);
  const designManagers = users.filter((u) => u.role === 'DESIGN_MANAGER' && u.isActive);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [u, h, s] = await Promise.all([
        api.get<{ users: User[] }>('/admin/users'),
        api.get<Health>('/admin/health'),
        api.get<{ schedules: Schedule[] }>('/admin/report-schedules'),
      ]);
      setUsers(u.users);
      setHealth(h);
      setSchedules(s.schedules);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const loadTargets = async () => {
    setTargetsLoading(true);
    try {
      const data = await api.get<TargetsResponse>('/designer-targets');
      setTargetsData(data);
      const drafts: Record<string, {
        bookingTargetValue: string; poTargetValue: string; conversionTargetPct: string; averageBookingValueTarget: string; dipTargetCount: string;
      }> = {};
      for (const row of data.designers) {
        drafts[row.designerId] = {
          bookingTargetValue: row.target ? String(row.target.bookingTargetValue) : '',
          poTargetValue: row.target ? String(row.target.poTargetValue) : '',
          conversionTargetPct: row.target?.conversionTargetPct != null ? String(row.target.conversionTargetPct) : '',
          averageBookingValueTarget: row.target?.averageBookingValueTarget != null ? String(row.target.averageBookingValueTarget) : '',
          dipTargetCount: row.target?.dipTargetCount != null ? String(row.target.dipTargetCount) : '',
        };
      }
      setTargetDrafts(drafts);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setTargetsLoading(false);
    }
  };

  const handleSaveTarget = async (designerId: string) => {
    const draft = targetDrafts[designerId];
    if (!draft || Object.values(draft).some((value) => value === '')) {
      toast.error('Enter all five performance targets');
      return;
    }
    setSavingTargetFor(designerId);
    try {
      await api.post('/designer-targets', {
        designerId,
        bookingTargetValue: Number(draft.bookingTargetValue),
        poTargetValue: Number(draft.poTargetValue),
        conversionTargetPct: Number(draft.conversionTargetPct),
        averageBookingValueTarget: Number(draft.averageBookingValueTarget),
        dipTargetCount: Number(draft.dipTargetCount),
      });
      toast.success('Target saved');
      await loadTargets();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingTargetFor(null);
    }
  };

  const loadOffers = async () => {
    setOffersLoading(true);
    try {
      const d = await api.get<{ offers: OfferOption[] }>('/admin/offer-options');
      setOffers(d.offers);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setOffersLoading(false);
    }
  };

  const addOffer = async () => {
    if (!newOfferLabel.trim()) return;
    setSavingOffer(true);
    try {
      await api.post('/admin/offer-options', { label: newOfferLabel.trim(), sortOrder: offers.length });
      setNewOfferLabel('');
      await loadOffers();
      toast.success('Offer added');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSavingOffer(false);
    }
  };

  const toggleOfferActive = async (offer: OfferOption) => {
    try {
      await api.patch(`/admin/offer-options/${offer.id}`, { isActive: !offer.isActive });
      await loadOffers();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const downloadImportTemplate = async () => {
    try {
      const res = await fetch('/api/leads/import/template', {
        headers: { Authorization: `Bearer ${localStorage.getItem('crm_token')}` },
      });
      if (!res.ok) throw new Error('Could not download template');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'lead-import-template.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const runImportPreview = async () => {
    if (!importFile) { toast.error('Choose a CSV or Excel file first'); return; }
    setImportRunning(true);
    setImportPreview(null);
    setImportCommitted(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      fd.append('status', importStatus);
      const result = await uploadFile<ImportResult>('/leads/import?dryRun=true', fd);
      setImportPreview(result);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setImportRunning(false);
    }
  };

  const commitImport = async () => {
    if (!importFile || !importPreview) return;
    const willImportCount = importPreview.preview.filter((r) => r.status === 'WILL_IMPORT').length;
    if (willImportCount === 0) { toast.error('Nothing to import'); return; }
    if (!window.confirm(`Import ${willImportCount} lead(s) as ${importStatus}? This cannot be undone from here.`)) return;
    setImportRunning(true);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      fd.append('status', importStatus);
      const result = await uploadFile<ImportResult>('/leads/import', fd);
      setImportCommitted(result);
      setImportPreview(null);
      toast.success(`Imported ${result.imported} lead(s), skipped ${result.skipped}`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setImportRunning(false);
    }
  };

  const openDeactivate = async (u: User) => {
    setDeactivateTarget(u);
    setReassignDesignerId('');
    setDeactivatePreview(null);
    setDeactivateLoading(true);
    try {
      const preview = await api.get<DeactivatePreview>(`/admin/users/${u.id}/deactivation-preview`);
      setDeactivatePreview(preview);
    } catch (e: any) {
      toast.error('Could not load preview: ' + e.message);
    } finally {
      setDeactivateLoading(false);
    }
  };

  const closeDeactivate = () => {
    setDeactivateTarget(null);
    setDeactivatePreview(null);
    setReassignDesignerId('');
  };

  const handleDeactivate = async () => {
    if (!deactivateTarget) return;
    const hasLeads = (deactivatePreview?.activeLeads ?? 0) > 0;
    if (hasLeads && !reassignDesignerId) {
      toast.error('Please select a designer to reassign leads to first');
      return;
    }
    setDeactivating(true);
    try {
      await api.patch(`/admin/users/${deactivateTarget.id}/deactivate`, {
        reassignDesignerId: reassignDesignerId || undefined,
      });
      toast.success(`${deactivateTarget.name} deactivated`);
      closeDeactivate();
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setDeactivating(false);
    }
  };

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inviteForm.name || !inviteForm.email) { toast.error('Name and email required'); return; }
    setInviting(true);
    try {
      // Task: fix broken login for admin-created users. `/admin/users/invite`
      // creates a User row with no password, so the person can never sign in.
      // `/admin/users/send-invite` creates a UserInvite + emails a link to
      // /accept-invite/:token where the person sets their own password —
      // that's the flow that actually results in a working login.
      const { inviteLink, note } = await api.post<{ inviteLink: string; note: string }>(
        '/admin/users/send-invite',
        {
          name: inviteForm.name, email: inviteForm.email, role: inviteForm.role,
          blId: inviteForm.blId || undefined, designManagerId: inviteForm.designManagerId || undefined, designation: inviteForm.designation || undefined,
        },
      );
      if (note && (note.includes('manual sharing') || note.includes('delivery unavailable'))) {
        toast.success(`Invite created for ${inviteForm.name}. Email isn't configured yet — share this link with them: ${inviteLink}`, { duration: 12000 });
      } else {
        toast.success(`Invite email sent to ${inviteForm.email}`);
      }
      setInviteForm({ name: '', email: '', role: 'DESIGNER', blId: '', designManagerId: '', designation: '' });
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setInviting(false);
    }
  };

  const handleAddSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    const recipients = scheduleForm.recipientIds.split(',').map((s) => s.trim()).filter(Boolean);
    if (!recipients.length) { toast.error('Enter at least one User ID'); return; }
    try {
      await api.post('/admin/report-schedules', { type: scheduleForm.type, recipients });
      toast.success('Report schedule created');
      setScheduleForm({ type: 'WEEKLY', recipientIds: '' });
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const deleteSchedule = async (id: string) => {
    try {
      await api.delete(`/admin/report-schedules/${id}`);
      toast.success('Schedule removed');
      await loadAll();
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const loadNps = async (opts?: { designerId?: string; from?: string; to?: string }) => {
    setNpsLoading(true);
    try {
      const params = new URLSearchParams();
      if (opts?.designerId) params.set('designerId', opts.designerId);
      if (opts?.from) params.set('from', opts.from);
      if (opts?.to) params.set('to', opts.to);
      const qs = params.toString() ? `?${params}` : '';
      const data = await api.get<{ rows: NpsRow[] }>(`/admin/nps-tracker${qs}`);
      setNpsRows(data.rows);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setNpsLoading(false);
    }
  };

  const handleNpsSortClick = (col: string) => {
    if (npsSortCol === col) {
      setNpsSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setNpsSortCol(col);
      setNpsSortDir('desc');
    }
  };

  const sortedNpsRows = [...npsRows].sort((a, b) => {
    let av: number | string | null, bv: number | string | null;
    if (npsSortCol === 'leadName') { av = a.leadName; bv = b.leadName; }
    else if (npsSortCol === 'designerName') { av = a.designerName; bv = b.designerName; }
    else if (npsSortCol === 'avgNps') { av = a.avgNps; bv = b.avgNps; }
    else {
      av = a.scores[npsSortCol] ?? null;
      bv = b.scores[npsSortCol] ?? null;
    }
    // nulls last
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string' && typeof bv === 'string') {
      return npsSortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return npsSortDir === 'asc' ? (av as number) - (bv as number) : (bv as number) - (av as number);
  });

  const NPS_STAGES = ['SALE', 'ONBOARDING', 'DESIGN_FREEZE', 'SIGN_OFF'];
  const NPS_LABELS: Record<string, string> = {
    SALE: 'Sales', ONBOARDING: 'OB', DESIGN_FREEZE: 'DF', SIGN_OFF: 'Sign Off',
  };

  const npsColor = (score: number | undefined) => {
    if (score == null) return 'text-stone-300';
    if (score >= 9) return 'text-green-600 font-bold';
    if (score >= 7) return 'text-amber-500 font-bold';
    return 'text-red-500 font-bold';
  };

  const tabs: { id: AdminTab; label: string; Icon: LucideIcon }[] = [
    { id: 'users', label: 'Users', Icon: Users2 },
    { id: 'schedules', label: 'Report Schedules', Icon: CalendarDays },
    { id: 'health', label: 'System Health', Icon: Activity },
    { id: 'nps', label: 'NPS Tracker', Icon: Star },
    { id: 'offers', label: 'Offers', Icon: Tag },
    { id: 'import', label: 'Import Leads', Icon: Upload },
    { id: 'targets', label: 'Sales Performance Targets', Icon: Target },
    { id: 'credits', label: 'Designer Credit Rules', Icon: Star },
    { id: 'content', label: 'Dashboard Content', Icon: Megaphone },
    { id: 'stageRules', label: 'Stage Rules', Icon: Route },
    { id: 'docTypes', label: 'Document Types', Icon: FileText },
    { id: 'crmSettings', label: 'CRM Settings', Icon: SlidersHorizontal },
    { id: 'automations', label: 'Automations', Icon: Zap },
    { id: 'dashboards', label: 'Dashboards', Icon: LayoutDashboard },
    { id: 'permissions', label: 'Permissions', Icon: ShieldCheck },
    { id: 'checklists', label: 'Checklists', Icon: ListChecks },
    { id: 'reportsNps', label: 'Reports & NPS', Icon: BarChart3 },
    { id: 'leadRouting', label: 'Lead Routing & Access', Icon: Shuffle },
    { id: 'meetings', label: 'Meetings', Icon: CalendarClock },
    { id: 'alerts', label: 'In-app Alerts', Icon: Bell },
    { id: 'formulas', label: 'Formulas', Icon: Calculator },
    { id: 'wording', label: 'Wording', Icon: Type },
  ];

  const hasLeads = (deactivatePreview?.activeLeads ?? 0) > 0;
  const canDeactivate = !hasLeads || !!reassignDesignerId;

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Deactivation modal ──────────────────────────────────────────── */}
      {deactivateTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={closeDeactivate} />
          <div className="relative bg-white rounded-2xl shadow-2xl p-6 max-w-md w-full">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
              <AlertTriangle size={22} strokeWidth={1.8} className="text-red-500" />
            </div>
            <h2 className="text-base font-semibold text-gray-900 text-center mb-1">
              Deactivate {deactivateTarget.name}?
            </h2>
            <p className="text-sm text-gray-500 text-center mb-4">
              Their account will be disabled immediately.
            </p>

            {deactivateLoading ? (
              <div className="text-center py-4 text-gray-400 animate-pulse text-sm">Loading active leads…</div>
            ) : deactivatePreview ? (
              <>
                {hasLeads ? (
                  <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
                    <p className="text-sm font-medium text-amber-800 mb-2">
                      <AlertTriangle size={13} strokeWidth={2} className="inline mr-1 -mt-0.5" />{deactivatePreview.activeLeads} active lead{deactivatePreview.activeLeads !== 1 ? 's' : ''} must be reassigned before deactivating.
                    </p>
                    <ul className="text-xs text-amber-700 space-y-1 mb-3">
                      {deactivatePreview.leads.slice(0, 5).map((l) => (
                        <li key={l.id} className="flex justify-between">
                          <span className="font-medium">{l.leadId}</span>
                          <span>{l.name}</span>
                          <span className="text-amber-500">{l.stage}</span>
                        </li>
                      ))}
                      {deactivatePreview.leads.length > 5 && (
                        <li className="text-amber-500">…and {deactivatePreview.leads.length - 5} more</li>
                      )}
                    </ul>
                    <label className="block text-xs font-medium text-amber-800 mb-1">Reassign leads to:</label>
                    <select
                      value={reassignDesignerId}
                      onChange={(e) => setReassignDesignerId(e.target.value)}
                      className="w-full border border-amber-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                    >
                      <option value="">— Select a designer —</option>
                      {activeDesigners
                        .filter((d) => d.id !== deactivateTarget.id)
                        .map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                    </select>
                  </div>
                ) : (
                  <div className="mb-4 rounded-xl border border-green-200 bg-green-50 p-3 text-center">
                    <p className="text-sm text-green-700"><CheckCircle2 size={13} strokeWidth={2} className="inline mr-1 -mt-0.5" />No active leads — safe to deactivate immediately.</p>
                  </div>
                )}
              </>
            ) : null}

            <div className="flex gap-3 mt-2">
              <button
                onClick={closeDeactivate}
                className="flex-1 border border-gray-200 text-gray-700 py-2 rounded-xl text-sm font-medium hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeactivate}
                disabled={deactivateLoading || deactivating || !canDeactivate}
                className="flex-1 py-2 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {deactivating ? 'Deactivating…' : hasLeads && !reassignDesignerId ? 'Select designer first' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <Link to="/dashboard" className="text-gray-400 hover:text-gray-600 text-sm">← Dashboard</Link>
          <div>
            <h1 className="text-lg font-semibold text-gray-900">Admin Panel</h1>
            <p className="text-xs text-gray-400">Branch Head access only</p>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <nav className="flex gap-1 overflow-x-auto">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => { setTab(t.id); if (t.id === 'nps') loadNps({ designerId: npsDesignerFilter || undefined, from: npsDateFrom || undefined, to: npsDateTo || undefined }); if (t.id === 'offers') loadOffers(); if (t.id === 'targets') loadTargets(); }}
                className={`px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  tab === t.id ? 'border-brand-500 text-brand-600' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <t.Icon size={14} strokeWidth={1.8} className="inline mr-1.5 -mt-0.5" />{t.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {loading && <div className="text-center py-20 text-gray-400 animate-pulse">Loading…</div>}

        {/* ── USERS TAB ──────────────────────────────────────────────────────── */}
        {!loading && tab === 'users' && (
          <>
            {/* Invite form */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">Invite New User</h2>
              <form onSubmit={handleInvite} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <input value={inviteForm.name} onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })}
                  placeholder="Full name *" required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                <input type="email" value={inviteForm.email} onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                  placeholder="Email *" required
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                <select value={inviteForm.role} onChange={(e) => setInviteForm({ ...inviteForm, role: e.target.value })}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400">
                  {['DESIGNER', 'DESIGN_MANAGER', 'CRE', 'BL', 'BRANCH_HEAD'].map((r) => <option key={r}>{r}</option>)}
                </select>
                <button type="submit" disabled={inviting}
                  className="bg-brand-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {inviting ? 'Inviting…' : 'Send Invite'}
                </button>
              </form>
              <div className="mt-3 flex flex-wrap gap-3">
                {(inviteForm.role === 'DESIGNER' || inviteForm.role === 'CRE') && bls.length > 0 && (
                  <select value={inviteForm.blId} onChange={(e) => setInviteForm({ ...inviteForm, blId: e.target.value })}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400">
                    <option value="">Assign to BL (optional)</option>
                    {bls.map((bl) => <option key={bl.id} value={bl.id}>{bl.name}</option>)}
                  </select>
                )}
                {inviteForm.role === 'DESIGNER' && designManagers.length > 0 && (
                  <select value={inviteForm.designManagerId} onChange={(e) => setInviteForm({ ...inviteForm, designManagerId: e.target.value })}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400">
                    <option value="">Assign to Design Manager (optional)</option>
                    {designManagers.map((dm) => <option key={dm.id} value={dm.id}>{dm.name}</option>)}
                  </select>
                )}
                {inviteForm.role === 'DESIGNER' && (
                  <select value={inviteForm.designation} onChange={(e) => setInviteForm({ ...inviteForm, designation: e.target.value })}
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                    title="Display title only — does not change permissions">
                    <option value="">Designation: Designer (default)</option>
                    <option value="DESIGN_TEAM_LEAD">Designation: {wording('title.DESIGN_TEAM_LEAD', 'Design Team Lead')}</option>
                  </select>
                )}
              </div>
            </div>

            {/* User list */}
            <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="font-semibold text-gray-900">Team Members ({users.filter((u) => u.isActive).length} active)</h2>
              </div>
              {users.length === 0 ? (
                <EmptyState Icon={Users2} title="No users yet" description="Invite team members using the form above" />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50">
                        {['Name', 'Email', 'Role', 'BL', 'Design Manager', 'Leads', 'Status', ''].map((h) => (
                          <th key={h} className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase tracking-wide">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {users.map((u) => (
                        <tr key={u.id} className={`hover:bg-gray-50 ${!u.isActive ? 'opacity-50' : ''}`}>
                          <td className="py-3 px-4 font-medium text-gray-900">{u.name}</td>
                          <td className="py-3 px-4 text-gray-500 text-xs">{u.email}</td>
                          <td className="py-3 px-4">
                            <span className={`text-xs px-2 py-1 rounded-full font-medium ${ROLE_COLORS[u.role] ?? 'bg-gray-100 text-gray-600'}`}>
                              {u.designation ? wording(`title.${u.designation}`, DESIGNATION_LABELS[u.designation] ?? u.designation) : u.role}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-gray-500 text-xs">{u.bl?.name ?? '—'}</td>
                          <td className="py-3 px-4 text-gray-500 text-xs">{u.designManager?.name ?? '—'}</td>
                          <td className="py-3 px-4 text-gray-700">
                            {u._count.designerLeads + u._count.blLeads}
                          </td>
                          <td className="py-3 px-4">
                            <span className={`text-xs px-2 py-1 rounded-full ${u.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                              {u.isActive ? 'Active' : 'Inactive'}
                            </span>
                          </td>
                          <td className="py-3 px-4">
                            {u.isActive && u.role !== 'BRANCH_HEAD' && (
                              <button onClick={() => openDeactivate(u)}
                                className="text-xs text-red-500 hover:text-red-700 hover:underline">
                                Deactivate
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── SCHEDULES TAB ─────────────────────────────────────────────────── */}
        {!loading && tab === 'schedules' && (
          <>
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">Add Report Schedule</h2>
              <form onSubmit={handleAddSchedule} className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Report Type</label>
                    <select value={scheduleForm.type} onChange={(e) => setScheduleForm({ ...scheduleForm, type: e.target.value })}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400">
                      <option value="WEEKLY">Weekly (every Monday 8am)</option>
                      <option value="MONTHLY">Monthly (1st of month 8am)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Recipient User IDs (comma-separated)</label>
                    <input value={scheduleForm.recipientIds}
                      onChange={(e) => setScheduleForm({ ...scheduleForm, recipientIds: e.target.value })}
                      placeholder="userId1, userId2, …"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" />
                  </div>
                </div>
                <button type="submit"
                  className="bg-brand-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-600 transition-colors">
                  Create Schedule
                </button>
              </form>
            </div>

            {schedules.length === 0 ? (
              <EmptyState Icon={CalendarDays} title="No report schedules" description="Create a schedule above to start receiving automatic reports" />
            ) : (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      {['Type', 'Recipients', 'Last Sent', ''].map((h) => (
                        <th key={h} className="text-left py-3 px-4 text-xs font-medium text-gray-500 uppercase">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {schedules.map((s) => (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="py-3 px-4">
                          <span className={`text-xs px-2 py-1 rounded-full font-medium ${s.type === 'WEEKLY' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'}`}>
                            {s.type}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-gray-500 text-xs">{s.recipients.length} recipient{s.recipients.length !== 1 ? 's' : ''}</td>
                        <td className="py-3 px-4 text-gray-500 text-xs">
                          {s.lastSentAt ? new Date(s.lastSentAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : 'Never sent'}
                        </td>
                        <td className="py-3 px-4">
                          <button onClick={() => deleteSchedule(s.id)} className="text-xs text-red-500 hover:underline">Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ── NPS TRACKER TAB ───────────────────────────────────────────────── */}
        {tab === 'nps' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              {/* Filters row */}
              <div className="flex items-end flex-wrap gap-3 mb-5">
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Designer</label>
                  <select
                    value={npsDesignerFilter}
                    onChange={(e) => setNpsDesignerFilter(e.target.value)}
                    className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  >
                    <option value="">All designers</option>
                    {activeDesigners.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Responded from</label>
                  <DateInput
                    value={npsDateFrom}
                    onChange={setNpsDateFrom}
                    className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Responded to</label>
                  <DateInput
                    value={npsDateTo}
                    onChange={setNpsDateTo}
                    className="border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                <button
                  onClick={() => loadNps({ designerId: npsDesignerFilter || undefined, from: npsDateFrom || undefined, to: npsDateTo || undefined })}
                  className="px-4 py-1.5 bg-brand-500 text-white text-sm rounded-lg hover:bg-brand-600 transition-colors"
                >
                  Apply
                </button>
                {(npsDesignerFilter || npsDateFrom || npsDateTo) && (
                  <button
                    onClick={() => { setNpsDesignerFilter(''); setNpsDateFrom(''); setNpsDateTo(''); loadNps(); }}
                    className="px-3 py-1.5 text-sm text-gray-500 hover:text-gray-700 underline"
                  >
                    Clear
                  </button>
                )}
              </div>

              {npsLoading ? (
                <div className="text-center py-10 text-gray-400 animate-pulse text-sm">Loading NPS data…</div>
              ) : npsRows.length === 0 ? (
                <div className="text-center py-10 text-gray-400 text-sm">
                  No NPS responses yet. Surveys are sent automatically when leads reach key milestones.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        {[
                          { key: 'leadName', label: 'Lead', align: 'left' },
                          { key: 'designerName', label: 'Designer', align: 'left' },
                          ...NPS_STAGES.map((s) => ({ key: s, label: NPS_LABELS[s], align: 'center' })),
                          { key: 'avgNps', label: 'Avg', align: 'center' },
                        ].map(({ key, label, align }) => (
                          <th
                            key={key}
                            onClick={() => handleNpsSortClick(key)}
                            className={`py-2.5 px-3 text-xs font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap cursor-pointer select-none hover:text-gray-800 transition-colors ${align === 'center' ? 'text-center' : 'text-left'}`}
                          >
                            {label}
                            {npsSortCol === key && (
                              <span className="ml-1 text-brand-500">{npsSortDir === 'asc' ? '↑' : '↓'}</span>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {sortedNpsRows.map((row) => (
                        <tr key={row.leadDbId} className="hover:bg-gray-50 transition-colors">
                          <td className="py-2.5 px-3">
                            <div className="font-mono text-xs text-brand-600 font-bold">{row.leadId}</div>
                            <div className="text-xs text-gray-700">{row.leadName}</div>
                          </td>
                          <td className="py-2.5 px-3 text-xs text-gray-600">{row.designerName}</td>
                          {NPS_STAGES.map((s) => (
                            <td key={s} className={`py-2.5 px-3 text-center text-sm ${npsColor(row.scores[s])}`}>
                              {row.scores[s] != null ? row.scores[s] : <span className="text-gray-300">—</span>}
                            </td>
                          ))}
                          <td className={`py-2.5 px-3 text-center text-sm font-bold ${npsColor(row.avgNps ?? undefined)}`}>
                            {row.avgNps != null ? row.avgNps : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-xs text-gray-400 mt-3 px-1">{sortedNpsRows.length} lead{sortedNpsRows.length !== 1 ? 's' : ''} with NPS responses. Click any column header to sort.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── HEALTH TAB ────────────────────────────────────────────────────── */}
        {!loading && tab === 'health' && health && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: 'Total Leads', value: health.totalLeads, color: 'text-brand-600' },
                { label: 'Active Users', value: health.totalUsers, color: 'text-blue-600' },
                { label: 'SLA Breaches', value: health.activeBreaches, color: health.activeBreaches > 0 ? 'text-red-600' : 'text-green-600' },
                { label: 'Database', value: health.db, color: 'text-green-600' },
              ].map((item) => (
                <div key={item.label} className="bg-white rounded-xl border border-gray-200 p-4">
                  <p className={`text-2xl font-bold ${item.color}`}>{item.value}</p>
                  <p className="text-xs text-gray-500 mt-1">{item.label}</p>
                </div>
              ))}
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-4">Integration Status</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {[
                  { label: 'Redis / BullMQ', ok: health.redisConfigured },
                  { label: 'SMTP Email', ok: health.smtpConfigured },
                  { label: 'Twilio WhatsApp', ok: health.twilioConfigured },
                  { label: 'Meta Lead Ads', ok: health.metaConfigured },
                ].map((item) => (
                  <div key={item.label} className={`flex items-center gap-3 p-3 rounded-xl ${item.ok ? 'bg-green-50' : 'bg-gray-50'}`}>
                    {item.ok
                      ? <CheckCircle2 size={18} strokeWidth={1.8} className="text-green-500 shrink-0" />
                      : <Circle size={18} strokeWidth={1.8} className="text-gray-300 shrink-0" />}
                    <div>
                      <p className="text-sm font-medium text-gray-900">{item.label}</p>
                      <p className={`text-xs ${item.ok ? 'text-green-600' : 'text-gray-400'}`}>{item.ok ? 'Configured' : 'Not configured'}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-2">Base URL</h2>
              <p className="text-sm font-mono bg-gray-50 rounded-lg px-3 py-2 text-gray-700">{health.baseUrl}</p>
              <p className="text-xs text-gray-400 mt-1">Set <code>BASE_URL</code> env var to use your custom domain (e.g. https://crm.interiorsbydex.com)</p>
            </div>
          </div>
        )}

        {/* ── OFFERS TAB ─────────────────────────────────────────────────────── */}
        {tab === 'offers' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-1">Offer Options</h2>
              <p className="text-xs text-gray-500 mb-4">
                Manage the offers designers/BLs can pick from in a lead's Offer proposed field.
                Deactivating an offer hides it from new selections but keeps it on leads that already used it.
              </p>
              <div className="flex gap-2 mb-4">
                <input
                  type="text"
                  value={newOfferLabel}
                  onChange={(e) => setNewOfferLabel(e.target.value)}
                  placeholder="e.g. 10% discount on modular"
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  onKeyDown={(e) => { if (e.key === 'Enter') addOffer(); }}
                />
                <button
                  onClick={addOffer}
                  disabled={savingOffer || !newOfferLabel.trim()}
                  className="bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  Add
                </button>
              </div>

              {offersLoading ? (
                <div className="text-center py-8 text-gray-400 animate-pulse text-sm">Loading…</div>
              ) : offers.length === 0 ? (
                <EmptyState title="No offers yet" description="Add your first offer above." />
              ) : (
                <div className="space-y-1.5">
                  {offers.map((o) => (
                    <div key={o.id} className={`flex items-center justify-between px-3 py-2 rounded-lg ${o.isActive ? 'bg-gray-50' : 'bg-gray-50 opacity-50'}`}>
                      <span className="text-sm text-gray-800">{o.label}</span>
                      <button
                        onClick={() => toggleOfferActive(o)}
                        className="text-xs font-medium text-gray-500 hover:text-gray-700 flex items-center gap-1"
                      >
                        {o.isActive ? <><Trash2 size={12} strokeWidth={1.8} /> Deactivate</> : 'Reactivate'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── IMPORT LEADS TAB ───────────────────────────────────────────────── */}
        {tab === 'import' && (
          <div className="space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-900 mb-1">Bulk-import leads from CSV / Excel</h2>
              <p className="text-xs text-gray-500 mb-4">
                Preview first — nothing is saved until you confirm the import. Duplicate phone numbers,
                emails, or PIDs already in the CRM are skipped automatically.{' '}
                <button onClick={downloadImportTemplate} className="text-brand-600 hover:underline font-medium">
                  Download a template
                </button>
              </p>
              <p className="text-xs text-gray-500 mb-4">
                Optional Designer Name, BL Name and CRE Name columns preserve historical ownership.
                Unknown or ambiguous names need manual review and are never replaced automatically.
                Only ownerless Active Effective Leads use automatic CRE allocation.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end mb-4">
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium text-gray-500 mb-1">File</label>
                  <input
                    type="file"
                    accept=".csv,.xlsx"
                    onChange={(e) => { setImportFile(e.target.files?.[0] ?? null); setImportPreview(null); setImportCommitted(null); }}
                    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-2 file:rounded-md file:border-0 file:bg-gray-100 file:text-gray-700 file:text-xs"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-500 mb-1">Lead status for this file</label>
                  <select
                    value={importStatus}
                    onChange={(e) => { setImportStatus(e.target.value as any); setImportPreview(null); setImportCommitted(null); }}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                  >
                    <option value="ACTIVE">Active</option>
                    <option value="INACTIVE">Inactive</option>
                    <option value="ON_HOLD">On Hold</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={runImportPreview}
                  disabled={!importFile || importRunning}
                  className="bg-gray-800 hover:bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                >
                  {importRunning && !importPreview ? 'Analyzing…' : 'Preview import'}
                </button>
                {importPreview && (
                  <button
                    onClick={commitImport}
                    disabled={importRunning || importPreview.preview.filter((r) => r.status === 'WILL_IMPORT').length === 0}
                    className="bg-brand-500 hover:bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium disabled:opacity-50"
                  >
                    {importRunning ? 'Importing…' : `Confirm import (${importPreview.preview.filter((r) => r.status === 'WILL_IMPORT').length})`}
                  </button>
                )}
              </div>
            </div>

            {importCommitted && (
              <div className="bg-green-50 border border-green-200 rounded-xl p-5">
                <p className="text-sm font-medium text-green-800 mb-1">
                  <CheckCircle2 size={14} strokeWidth={2} className="inline mr-1 -mt-0.5" />
                  Imported {importCommitted.imported} of {importCommitted.total} rows as {importCommitted.status}. Skipped {importCommitted.skipped}.
                </p>
                {importCommitted.assignmentCounts && (
                  <p className="text-xs text-green-800">
                    Ownership preserved: {importCommitted.assignmentCounts.preserved}. Auto-allocated: {importCommitted.assignmentCounts.allocated}.
                    {' '}Manual ownership review: {importCommitted.assignmentCounts.manualReview}.
                  </p>
                )}
                {importCommitted.preview.some((r) => r.status === 'WILL_IMPORT' && r.assignmentOutcome === 'MANUAL_REVIEW') && (
                  <div className="mt-3 text-xs text-amber-800">
                    <p className="font-medium">Imported with unresolved ownership — review these leads manually:</p>
                    <ul className="list-disc pl-5 mt-1 space-y-1">
                      {importCommitted.preview.filter((r) => r.status === 'WILL_IMPORT' && r.assignmentOutcome === 'MANUAL_REVIEW')
                        .map((r) => <li key={r.row}>{r.leadId} — {r.name}: {r.reason}</li>)}
                    </ul>
                  </div>
                )}
                {importCommitted.errors.length > 0 && (
                  <ul className="text-xs text-green-700 mt-2 list-disc pl-5 space-y-0.5">
                    {importCommitted.errors.slice(0, 20).map((e, i) => <li key={i}>{e}</li>)}
                  </ul>
                )}
              </div>
            )}

            {importPreview && (
              <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-100 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span className="text-gray-900 font-semibold">{importPreview.total} rows parsed</span>
                  <span className="text-green-600">{importPreview.preview.filter((r) => r.status === 'WILL_IMPORT').length} will import</span>
                  <span className="text-amber-600">{importPreview.preview.filter((r) => r.status === 'DUPLICATE').length} duplicates</span>
                  <span className="text-red-600">{importPreview.preview.filter((r) => r.status === 'INVALID').length} invalid</span>
                </div>
                <div className="max-h-96 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-gray-500 sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 font-medium">Row</th>
                        <th className="text-left px-3 py-2 font-medium">Status</th>
                        <th className="text-left px-3 py-2 font-medium">Name</th>
                        <th className="text-left px-3 py-2 font-medium">Phone</th>
                        <th className="text-left px-3 py-2 font-medium">Stage</th>
                        <th className="text-left px-3 py-2 font-medium">Lead ID</th>
                        <th className="text-left px-3 py-2 font-medium">Note</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {importPreview.preview.map((r) => (
                        <tr key={r.row} className={r.status !== 'WILL_IMPORT' ? 'bg-gray-50 text-gray-400' : ''}>
                          <td className="px-3 py-1.5">{r.row}</td>
                          <td className="px-3 py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              r.status === 'WILL_IMPORT' ? 'bg-green-100 text-green-700'
                              : r.status === 'DUPLICATE' ? 'bg-amber-100 text-amber-700'
                              : 'bg-red-100 text-red-700'
                            }`}>{r.status}</span>
                          </td>
                          <td className="px-3 py-1.5">{r.name || '—'}</td>
                          <td className="px-3 py-1.5">{r.phone || '—'}</td>
                          <td className="px-3 py-1.5">{r.stage || '—'}</td>
                          <td className="px-3 py-1.5">{r.leadId || '—'}</td>
                          <td className="px-3 py-1.5">{r.reason || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {importPreview.errors.length > 0 && (
                  <div className="px-5 py-3 border-t border-gray-100 text-xs text-amber-700 space-y-0.5">
                    {importPreview.errors.slice(0, 20).map((e, i) => <div key={i}>{e}</div>)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── SALES PERFORMANCE TARGETS TAB ───────────────────────────────────── */}
        {tab === 'credits' && <IncentiveRulesAdmin />}
        {!loading && tab === 'content' && <DashboardContentAdmin />}

        {tab === 'targets' && (
          <div className="bg-white rounded-xl border border-gray-200 p-5">
            <div className="flex items-center justify-between mb-1">
              <h2 className="font-semibold text-gray-900">Sales Performance Targets</h2>
              {targetsData && <span className="text-xs text-gray-400">{targetsData.cycle.label}</span>}
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Targets run on a {cycleDescription()} cycle (set in CRM Settings), not the calendar month. Once a cycle ends, its target is locked
              and can no longer be edited — set next cycle's targets here instead.
            </p>

            {targetsLoading ? (
              <div className="text-center py-8 text-gray-400 animate-pulse text-sm">Loading…</div>
            ) : !targetsData || targetsData.designers.length === 0 ? (
              <EmptyState title="No active designers" description="Add a designer under the Users tab first." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-gray-500 text-xs">
                    <tr>
                      <th className="text-left px-3 py-2 font-medium">Designer</th>
                      <th className="text-left px-3 py-2 font-medium">Booking Target (₹)</th>
                      <th className="text-left px-3 py-2 font-medium">Conversion Target (%)</th>
                      <th className="text-left px-3 py-2 font-medium">Avg Booking Value Target (₹)</th>
                      <th className="text-left px-3 py-2 font-medium">PO Target (₹)</th>
                      <th className="text-left px-3 py-2 font-medium">DIP Target</th>
                      <th className="text-left px-3 py-2 font-medium"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {targetsData.designers.map((row) => {
                      const draft = targetDrafts[row.designerId] ?? {
                        bookingTargetValue: '', poTargetValue: '', conversionTargetPct: '', averageBookingValueTarget: '', dipTargetCount: '',
                      };
                      return (
                        <tr key={row.designerId}>
                          <td className="px-3 py-2">
                            <div className="font-medium text-gray-800">{row.name}</div>
                            <div className="text-xs text-gray-400">{row.email}</div>
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              value={draft.bookingTargetValue}
                              onChange={(e) => setTargetDrafts((prev) => ({ ...prev, [row.designerId]: { ...draft, bookingTargetValue: e.target.value } }))}
                              className="w-32 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                              placeholder="e.g. 1500000"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input type="number" min={0} step={1} value={draft.dipTargetCount}
                              onChange={(e) => setTargetDrafts((prev) => ({ ...prev, [row.designerId]: { ...draft, dipTargetCount: e.target.value } }))}
                              className="w-24 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400" placeholder="e.g. 5" />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0.01}
                              max={100}
                              step="0.01"
                              value={draft.conversionTargetPct}
                              onChange={(e) => setTargetDrafts((prev) => ({ ...prev, [row.designerId]: { ...draft, conversionTargetPct: e.target.value } }))}
                              className="w-32 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                              placeholder="e.g. 25"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0.01}
                              value={draft.averageBookingValueTarget}
                              onChange={(e) => setTargetDrafts((prev) => ({ ...prev, [row.designerId]: { ...draft, averageBookingValueTarget: e.target.value } }))}
                              className="w-36 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                              placeholder="e.g. 500000"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              min={0}
                              value={draft.poTargetValue}
                              onChange={(e) => setTargetDrafts((prev) => ({ ...prev, [row.designerId]: { ...draft, poTargetValue: e.target.value } }))}
                              className="w-32 border border-gray-300 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-400"
                              placeholder="e.g. 800000"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <button
                              onClick={() => handleSaveTarget(row.designerId)}
                              disabled={savingTargetFor === row.designerId}
                              className="bg-brand-500 hover:bg-brand-600 text-white px-3 py-1.5 rounded-lg text-xs font-medium disabled:opacity-50"
                            >
                              {savingTargetFor === row.designerId ? 'Saving…' : row.target ? 'Update' : 'Set'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'stageRules' && <StageRulesAdmin />}
        {tab === 'docTypes' && <DocumentTypesAdmin />}
        {tab === 'crmSettings' && <CrmSettingsAdmin />}
        {tab === 'automations' && <AutomationsAdmin />}
        {tab === 'dashboards' && <DashboardsAdmin />}
        {tab === 'permissions' && <PermissionsAdmin />}
        {tab === 'checklists' && <ChecklistsAdmin />}
        {tab === 'reportsNps' && <ReportsNpsAdmin />}
        {tab === 'leadRouting' && <LeadRoutingAdmin />}
        {tab === 'meetings' && <MeetingsAdmin />}
        {tab === 'alerts' && <AlertsAdmin />}
        {tab === 'formulas' && <FormulasAdmin />}
        {tab === 'wording' && <WordingAdmin />}
      </div>
    </div>
  );
}
