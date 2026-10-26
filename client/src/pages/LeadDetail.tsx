import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  Phone, CalendarPlus, Tag, MessageCircle, AlertTriangle, Gift,
  ChevronDown, Upload, ExternalLink, Pencil, Info, Check, X, RefreshCw,
} from 'lucide-react';
import { api, uploadFile } from '../lib/api';
import { describeActivity } from '../lib/activityLabels';
import { validateEmail, validatePhoneStrict } from '../lib/validation';
import { useLenientLaunch } from '../lib/flags';
import { formatISTDate, formatPossession, istDateOnly, istDatetimeLocalValue, istInputToISO } from '../lib/dateFormat';
import { DateInput } from '../components/ui/DateTimeInputs';
import ActivityFeedTab from '../components/tabs/ActivityFeedTab';
import WhatsAppTab from '../components/tabs/WhatsAppTab';
import DiscountTab from '../components/tabs/DiscountTab';
import QuoteTab from '../components/tabs/QuoteTab';
import FilesTab from '../components/tabs/FilesTab';
import TeamTab from '../components/tabs/TeamTab';
import DIPChecklistPanel from '../components/DIPChecklistPanel';
import PhoneInput from '../components/PhoneInput';
import LeadLocationSelector from '../components/LeadLocationSelector';
import PDOBChecklistPanel from '../components/PDOBChecklistPanel';
import ChatTab from '../components/tabs/ChatTab';
import OBOBMChecklistPanel from '../components/OBOBMChecklistPanel';
import StageCaptureModal from '../components/StageCaptureModal';
import EmailPreviewModal from '../components/EmailPreviewModal';
import { getStoredUser } from '../lib/auth';
import { stageLabel, stageShortLabel, sourceValue, useCrmSettings, sourceLabel } from '../lib/crmSettings';
import { usePermissions } from '../lib/permissions';
import { crmSettings } from '../lib/crmSettings';

// 'activity' = combined Calls + Meetings + Tasks feed (new)
// 'audit'    = system audit log + ChatTab (renamed from 'activity')
type Tab = 'overview' | 'activity' | 'audit' | 'whatsapp' | 'quotes' | 'discount' | 'files' | 'team';

interface Lead {
  id: string; leadId: string; name: string; phone: string; phone2?: string;
  email?: string; email2?: string; pan?: string; gst?: string;
  stage: string; status: 'ACTIVE' | 'ON_HOLD' | 'INACTIVE'; source?: string; adName?: string; utmCampaign?: string; utmAdSet?: string; utmSource?: string;
  projectType?: string; scope?: string; location?: string; possessionTimeline?: string;
  builder?: string; expectedMoveIn?: string | null; expectedObDate?: string | null;
  offer1?: string; offer2?: string; offer3?: string;
  notes?: string;
  estimatedValue?: string | number | null; intentRating?: number | null; intentRatingSource?: string | null;
  nextMeetingDate?: string | null; floorPlanUrl?: string | null;
  onHoldRevivalDate?: string | null; isDuplicate?: boolean;
  onHoldReason?: string | null; inactiveReason?: string | null;
  onHoldNotes?: string | null; onHoldExternalNotes?: string | null;
  inactiveNotes?: string | null; inactiveExternalNotes?: string | null; preHoldStage?: string | null;
  isSLABreached: boolean; createdAt: string; updatedAt: string; leadOriginDate: string;
  daysInCurrentStage?: number; slaStatus?: 'ok' | 'warning' | 'breach';
  assignedDesigner?: { id: string; name: string } | null;
  assignedBL?: { id: string; name: string } | null;
  assignedDesignerId?: string | null; assignedBLId?: string | null;
  currentOffer?: { id: string; name: string } | null;
  project?: { id: string; projectCode?: string | null } | null;
  attentionFlags?: Array<{ id: string; category: string; description: string; createdAt: string }>;
  _count: { calls: number; meetings: number; followUpTasks: number };
  _breakdown?: {
    calls:    { answered: number; rnr: number; callback: number; meetingScheduled: number; total: number };
    meetings: { scheduled: number; completed: number; noShow: number; rescheduled: number; total: number };
    tasks:    { pending: number; overdue: number; completed: number; total: number };
    whatsapp: { outbound: number; inboundUnread: number; total: number };
  } | null;
  skippedDQL?: boolean; skippedProposalReady?: boolean; skippedProposalDiscussion?: boolean;
  ppMeetings?: Array<{ id: string; ppNumber?: number | null; scheduledAt: string; status: string; momAgenda?: string | null }>;
  // CRE module Stage 1 fields
  assignedCREId?: string | null;
  mqlPushbackReason?: string | null;
  mqlPushbackAt?: string | null;
  mqlPushbackCount?: number;
  leadAgeAtMQL?: number | null;
}

interface ActivityEntry {
  id: string; action: string; meta?: any; createdAt: string;
  user: { id: string; name: string };
}

interface Quote {
  id: string; quoteNumber?: string; totalAmount?: number; status?: string; createdAt: string;
}

interface LeadFile {
  id: string;
  fileType: string;
  fileName: string;
  signedUrl?: string;
  createdAt: string;
}

interface FollowUpTask {
  id: string; dueDate: string; dueTime?: string | null;
  isCompleted: boolean; isOverdue: boolean;
  status: 'PENDING' | 'COMPLETED' | 'RESCHEDULED' | 'NOT_DONE';
}

interface StageVisit {
  stage: string; enteredAt: string; exitedAt?: string; tatDays?: number;
  benchmark?: { warningDays: number; breachDays: number } | null;
  commercialContext?: {
    budget: number | null;
    intent: number | null;
    projectValue: number | null;
  };
}

interface AppUser { id: string; name: string; role: string; }

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
  INACTIVE: 'bg-stone-100 text-stone-500',
  ON_HOLD: 'bg-stone-100 text-stone-600',
};

// On-hold, inactive and reactivation reasons come from Admin → CRM Settings.


// Task #88: ON_HOLD/INACTIVE are status values now, not stages — removed
// from the assignable stage list. Status is changed via the dedicated
// On Hold / Mark Inactive actions instead.
// Task #114: Effective Lead and Handed Over are legacy/off-funnel-only —
// they must never appear as a *choosable* option in the stage-change
// dropdown, but a lead already sitting in one of them still needs to show
// its real current stage there (see ALL_STAGES usage at the select below).
const LEGACY_STAGES = ['EFFECTIVE_LEAD', 'HANDED_OVER'];
const ALL_STAGES = [
  'EFFECTIVE_LEAD', 'MQL', 'DQL', 'PROPOSAL_READY',
  'PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING',
  'DESIGN_IN_PROGRESS', 'HANDED_OVER',
];
const SELECTABLE_STAGES = ALL_STAGES.filter((s) => !LEGACY_STAGES.includes(s));

const STATUS_LABELS: Record<string, string> = { ACTIVE: 'Active', ON_HOLD: 'On Hold', INACTIVE: 'Inactive' };
const STATUS_COLORS: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-700',
  ON_HOLD: 'bg-amber-100 text-amber-800',
  INACTIVE: 'bg-red-100 text-red-700',
};

const ACTION_ICONS: Record<string, string> = {
  STAGE_CHANGED: '↗', INTENT_RATING_UPDATED: '★', NOTE_ADDED: '·',
  CALL_LOGGED: '·', MEETING_SCHEDULED: '·', MEETING_UPDATED: '·',
  WHATSAPP_SENT: '·', QUOTE_CREATED: '·', DISCOUNT_REQUESTED: '·',
  LEAD_CREATED: '·', ASSIGNMENT_CHANGED: '·', BL_ASSIGNED: '·',
};

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
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function SidebarCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl p-4 shadow-warm-sm" style={{ border: '1px solid #EDE8E3' }}>
      <h3 className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-3">{title}</h3>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="flex justify-between items-start gap-2 py-1 last:border-0" style={{ borderBottom: '1px solid #F5F0EB' }}>
      <span className="text-xs text-stone-400 shrink-0">{label}</span>
      <span className="text-xs text-stone-700 text-right">{value ?? '—'}</span>
    </div>
  );
}

function AvatarChip({ name }: { name?: string | null }) {
  if (!name) return <span className="text-xs text-gray-300">Unassigned</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="w-6 h-6 rounded-full bg-brand-100 text-brand-700 text-xs font-bold flex items-center justify-center shrink-0">
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="text-xs text-gray-700">{name}</span>
    </span>
  );
}

function StarRating({ rating, onSelect }: { rating?: number | null; onSelect?: (n: number) => void }) {
  const [hover, setHover] = useState(0);
  return (
    <span className="flex gap-0.5">
      {Array.from({ length: 5 }, (_, i) => {
        const n = i + 1;
        const filled = n <= (hover || (rating ?? 0));
        return (
          <span
            key={i}
            className={`text-lg transition-colors ${onSelect ? 'cursor-pointer' : ''} ${filled ? 'text-amber-400' : 'text-gray-200'}`}
            onMouseEnter={() => onSelect && setHover(n)}
            onMouseLeave={() => onSelect && setHover(0)}
            onClick={() => onSelect?.(n)}
          >★</span>
        );
      })}
    </span>
  );
}

/** Thin field row used inside the two key-facts blocks */
function FactRow({ label, value, className }: { label: string; value?: React.ReactNode; className?: string }) {
  return (
    <div className={`flex gap-2 py-1.5 border-b border-gray-50 last:border-0 ${className ?? ''}`}>
      <span className="text-xs text-gray-400 w-32 shrink-0">{label}</span>
      <span className="text-xs text-gray-700 flex-1">{value ?? <span className="text-gray-300">—</span>}</span>
    </div>
  );
}

const EMPTY_EDIT = {
  // Client details
  name: '', phone: '', phone2: '', email: '', email2: '', pan: '', gst: '',
  // Project details
  projectType: '', scope: '', location: '', builder: '', source: '',
  estimatedValue: '', expectedMoveIn: '', expectedObDate: '',
  offer1: '', offer2: '', offer3: '',
  offerProposed: '',
  sourceOther: '',
  notes: '',
  // Legacy
  possessionTimeline: '', nextMeetingDate: '',
};

const POSSESSION_RECEIVED = 'Possession Received';

/** true if `v` looks like a YYYY-MM-DD date (what the custom date input produces). */
function isIsoDateString(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v);
}


/** Gate requirements to show in the stage roadmap ℹ popover (mirrors stageRequirements.ts) */
/** Funnel stages shown in the horizontal roadmap. EFFECTIVE_LEAD/HANDED_OVER are
 * legacy/off-funnel stages and are intentionally excluded here — new leads
 * start at MQL and DESIGN_IN_PROGRESS is now the funnel's terminal stage. */
const FUNNEL_STAGES = [
  'MQL', 'DQL', 'PROPOSAL_READY', 'PROPOSAL_PRESENTED',
  'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS',
];

// Abbreviated stage codes used ONLY in the stage roadmap nav pill row.
// Full label 'PD (Pitch Discussion)' comes from stageLabel() — do not
// change the abbreviations here; they are intentionally short for the pill UI.
const FUNNEL_ABBREV: Record<string, string> = {
  EFFECTIVE_LEAD: 'EL', MQL: 'MQL', DQL: 'DQL',
  PROPOSAL_READY: 'PR', PROPOSAL_PRESENTED: 'PP',
  PROPOSAL_DISCUSSION: 'PD', /* abbreviated for roadmap nav pill — full label is 'PD (Pitch Discussion)' */
  ONBOARDING: 'OB',
  ONBOARDING_MEETING: 'OBM', DESIGN_IN_PROGRESS: 'DIP', HANDED_OVER: 'HO',
};

function fmtDate(iso?: string) {
  if (!iso) return '—';
  return formatISTDate(iso, { year: 'numeric' });
}

function fmtDateTime(iso?: string) {
  if (!iso) return '—';
  return formatISTDate(iso, { year: 'numeric' });
}

export default function LeadDetail() {
  const { can } = usePermissions();
  const crm = useCrmSettings();
  const lenient = useLenientLaunch();
  const { leadId } = useParams<{ leadId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<Tab>((searchParams.get('tab') as Tab) ?? 'overview');
  const [lead, setLead] = useState<Lead | null>(null);
  const [loadingLead, setLoadingLead] = useState(true);
  const [unreadChatCount, setUnreadChatCount] = useState(0);
  // Fix 1: incremented each time loadLead completes so OBOBMChecklistPanel re-fetches
  const [checklistRefreshKey, setChecklistRefreshKey] = useState(0);

  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quoteAttachments, setQuoteAttachments] = useState<LeadFile[]>([]);
  const [users, setUsers] = useState<AppUser[]>([]);
  const [blTeamDesigners, setBlTeamDesigners] = useState<{ id: string; name: string }[]>([]);

  const [stageModal, setStageModal] = useState(false);
  const [newStage, setNewStage] = useState('');
  const [changingStage, setChangingStage] = useState(false);
  // Task #114 — every stage move captures intent rating + project value
  // before it's committed. This is a second confirmation step shown after
  // the target stage is picked in the modal above.
  const [stageCapture, setStageCapture] = useState<{ targetStage: string } | null>(null);
  const [stageCaptureError, setStageCaptureError] = useState<string | null>(null);
  const [stageOverridable, setStageOverridable] = useState(false);

  // Task #88 — status change flow (On Hold / Inactive), separate from stage
  const [statusModal, setStatusModal] = useState<'ON_HOLD' | 'INACTIVE' | null>(null);
  const [inactivationReason, setInactivationReason] = useState('');
  const [inactiveReasonChoice, setInactiveReasonChoice] = useState('');
  const [inactiveNotes, setInactiveNotes] = useState('');
  const [inactiveExternalNotes, setInactiveExternalNotes] = useState('');
  const [, setInactiveNotifyClient] = useState(true);
  const [onHoldEmail, setOnHoldEmail] = useState('');
  const [onHoldReason, setOnHoldReason] = useState('');
  const [onHoldNotes, setOnHoldNotes] = useState('');
  const [onHoldExternalNotes, setOnHoldExternalNotes] = useState('');
  const [onHoldReopenDate, setOnHoldReopenDate] = useState('');
  const [, setOnHoldNotifyClient] = useState(true);
  const [changingStatus, setChangingStatus] = useState(false);

  // Task #40/#88 — reactivation flow for ON_HOLD / INACTIVE leads
  const [reactivateModal, setReactivateModal] = useState(false);
  const [reactivateReason, setReactivateReason] = useState('');
  const [reactivateReasonOther, setReactivateReasonOther] = useState('');
  const [reactivateNotes, setReactivateNotes] = useState('');
  const [reactivateNotifyClient, setReactivateNotifyClient] = useState(crmSettings().notifyClientByDefault);
  const [reactivating, setReactivating] = useState(false);

  // Batch 12c — On Hold / Inactive / Reactivate client mails are now drafts
  // that must be explicitly reviewed and sent, not auto-sent alongside the
  // status change itself.
  const [pendingMail, setPendingMail] = useState<{ draftKey: string; to: string; subject: string; html: string } | null>(null);
  const [sendingMail, setSendingMail] = useState(false);
  const [mailSentNotice, setMailSentNotice] = useState<string | null>(null);

  // Admin-configurable "mandatory client notification" flags (Settings page) —
  // when on, the notify-client checkbox for that flow is locked checked and
  // the action is blocked if the lead is missing an email/phone.
  const [notifyMandatory, setNotifyMandatory] = useState<Record<string, boolean>>({});
  useEffect(() => {
    api.get<{ config: Record<string, boolean> }>('/admin/notify-config')
      .then((res) => setNotifyMandatory(res.config ?? {}))
      .catch(() => {});
  }, []);

  const [intentModal, setIntentModal] = useState(false);
  const [pendingRating, setPendingRating] = useState(0);
  const [intentReason, setIntentReason] = useState('');
  const [savingIntent, setSavingIntent] = useState(false);

  // Lead-level attention flag (mirrors ProjectAttentionFlag; BL + BH usable)
  const [flagModal, setFlagModal] = useState(false);
  const [flagCategory, setFlagCategory] = useState('');
  const [flagDescription, setFlagDescription] = useState('');
  const [savingFlag, setSavingFlag] = useState(false);
  const [resolvingFlagId, setResolvingFlagId] = useState<string | null>(null);

  const [editDetailsModal, setEditDetailsModal] = useState(false);
  const [editDetails, setEditDetails] = useState<typeof EMPTY_EDIT>(EMPTY_EDIT);
  const [originalEditDetails, setOriginalEditDetails] = useState<typeof EMPTY_EDIT>(EMPTY_EDIT);
  const [editDetailsErrors, setEditDetailsErrors] = useState<Record<string, string>>({});
  const [possessionMode, setPossessionMode] = useState<'custom' | 'received' | 'legacy'>('custom');
  const [savingDetails, setSavingDetails] = useState(false);

  const REQUIRED_EDIT_FIELDS = ['name', 'phone', 'projectType', 'scope', 'location', 'expectedMoveIn', 'possessionTimeline'] as const;

  const validateEditField = (key: string, value: string) => {
    let error: string | null = null;
    if ((REQUIRED_EDIT_FIELDS as readonly string[]).includes(key) && !value.trim()) {
      error = 'This field is required';
    } else if (key === 'email' || key === 'email2') {
      error = validateEmail(value);
    } else if (key === 'phone' || key === 'phone2') {
      error = validatePhoneStrict(value);
    }
    setEditDetailsErrors((prev) => {
      const next = { ...prev };
      if (error) next[key] = error; else delete next[key];
      return next;
    });
    return error;
  };

  const [reassignField, setReassignField] = useState<'designer' | 'bl' | null>(null);
  const [reassignValue, setReassignValue] = useState('');
  const [savingReassign, setSavingReassign] = useState(false);

  // CRE module Stage 2: allocate-BL flow (CRE side)
  const [creBLList, setCreBLList] = useState<{ id: string; name: string }[]>([]);
  const [selectedBLId, setSelectedBLId] = useState('');
  const [allocatingBL, setAllocatingBL] = useState(false);

  // CRE module Stage 2: MQL pushback flow (BL side)
  const [showPushbackForm, setShowPushbackForm] = useState(false);
  const [pushbackReason, setPushbackReason] = useState('');
  const [pushingBack, setPushingBack] = useState(false);

  const [uploadingFloorPlan, setUploadingFloorPlan] = useState(false);
  const floorPlanInputRef = useRef<HTMLInputElement>(null);
  const [stagePushPrompt, setStagePushPrompt] = useState<{ targetStage: string; label: string } | null>(null);

  const [stageHistory, setStageHistory] = useState<StageVisit[]>([]);
  const [leadFollowUpTasks, setLeadFollowUpTasks] = useState<FollowUpTask[]>([]);
  const [gateInfoStage, setGateInfoStage] = useState<string | null>(null); // popover target
  const [gateDetails, setGateDetails] = useState<Record<string, { label: string; satisfied: boolean }[]>>({});
  const [gateDetailsLoading, setGateDetailsLoading] = useState(false);
  // Portal-rendered popover position, computed from the clicked (i) button's
  // on-screen rect so the popover escapes the Stage Roadmap's horizontally-
  // scrolling strip (overflow-x-auto there clips vertical overflow too, which
  // was cutting the gate list off). `openUpward` flips the popover below the
  // button when there isn't enough room above it in the viewport.
  const [gateInfoPos, setGateInfoPos] = useState<{ top: number; left: number; openUpward: boolean } | null>(null);

  const [avgNps, setAvgNps] = useState<number | null>(null);
  const [npsPerStage, setNpsPerStage] = useState<Record<string, { stage: string; score: number | null; sentAt: string; respondedAt: string | null }>>({});
  const [offerOptions, setOfferOptions] = useState<{ id: string; label: string }[]>([]);

  // Task #149 — an Inactive lead is fully locked from edits until reactivated.
  // Mirrors the server-side lock in leads.ts (PATCH /:id, /:id/assign-direct,
  // /:id/intent-rating, /:id/floor-plan, /:id/notes).
  const isLocked = lead?.status === 'INACTIVE';

  const loadLead = useCallback(() => {
    if (!leadId) return;
    setLoadingLead(true);
    api.get<{ lead: Lead; avgNps: number | null; npsPerStage: Record<string, any> }>(`/leads/${leadId}`)
      .then((d) => {
        setLead(d.lead);
        setAvgNps(d.avgNps ?? null);
        setNpsPerStage(d.npsPerStage ?? {});
        setChecklistRefreshKey((k) => k + 1);
        window.dispatchEvent(new CustomEvent('lead-opened'));
      })
      .catch(() => toast.error('Could not load lead'))
      .finally(() => setLoadingLead(false));
  }, [leadId]);

  const loadActivities = useCallback(() => {
    if (!leadId) return;
    api.get<{ activities: ActivityEntry[] }>(`/leads/${leadId}/activity`)
      .then((d) => setActivities(d.activities ?? []))
      .catch(() => {});
  }, [leadId]);

  const loadSidebarData = useCallback(() => {
    if (!leadId) return;
    api.get<{ quotes: Quote[] }>(`/quotes/lead/${leadId}`)
      .then((d) => setQuotes([...(d.quotes ?? [])].sort((a, b) => {
        const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        return timeDiff || b.id.localeCompare(a.id);
      })))
      .catch(() => {});
    api.get<{ files: LeadFile[] }>(`/leads/${leadId}/files`)
      .then((d) => setQuoteAttachments(
        (d.files ?? [])
          .filter((file) => ['QUOTATION', 'GENERATED_QUOTE', 'OB_QUOTE', 'PP_QUOTATION', 'PR_QUOTATION'].includes(file.fileType))
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      ))
      .catch(() => {});
    api.get<{ users: AppUser[] }>('/admin/users')
      .then((d) => setUsers(d.users ?? []))
      .catch(() => {});
    api.get<{ offers: { id: string; label: string }[] }>('/config/offers')
      .then((d) => setOfferOptions(d.offers ?? []))
      .catch(() => {});
  }, [leadId]);

  const handleFilesChanged = useCallback(async () => {
    loadSidebarData();
    setChecklistRefreshKey((key) => key + 1);
  }, [loadSidebarData]);

  const loadStageHistory = useCallback(() => {
    if (!leadId) return;
    api.get<{ history: StageVisit[] }>(`/leads/${leadId}/stage-history`)
      .then((d) => setStageHistory(d.history ?? []))
      .catch(() => {});
  }, [leadId]);

  const loadFollowUpTasks = useCallback(() => {
    if (!leadId) return;
    api.get<{ tasks: FollowUpTask[] }>(`/leads/${leadId}/tasks`)
      .then((d) => setLeadFollowUpTasks(d.tasks ?? []))
      .catch(() => {});
  }, [leadId]);

  useEffect(() => { loadLead(); }, [loadLead]);
  useEffect(() => { loadActivities(); }, [loadActivities]);
  useEffect(() => { loadSidebarData(); }, [loadSidebarData]);
  // Re-fetch when the lead moves stage (any path), so the timeline never lags behind the header.
  useEffect(() => { loadStageHistory(); }, [loadStageHistory, lead?.stage]);
  useEffect(() => { loadFollowUpTasks(); }, [loadFollowUpTasks]);

  // BL users receive their designer list from the lead-scoped endpoint rather
  // than the admin user directory, which they are not permitted to access.
  useEffect(() => {
    if (getStoredUser()?.role !== 'BL') return;
    api.get<{ designers: { id: string; name: string }[] }>('/leads/meta/designers')
      .then((d) => setBlTeamDesigners(d.designers ?? []))
      .catch(() => setBlTeamDesigners([]));
  }, []);

  // CRE module Stage 2: load BL list when a CRE views an MQL lead awaiting BL allocation
  useEffect(() => {
    const cu = getStoredUser();
    if (cu?.role !== 'CRE') return;
    if (!lead || lead.stage !== 'MQL' || lead.assignedBLId) return;
    api.get<{ bls: { id: string; name: string }[] }>('/leads/meta/bls')
      .then((d) => setCreBLList(d.bls ?? []))
      .catch(() => {});
  }, [lead?.stage, lead?.assignedBLId]);

  /** Called by MeetingsTab after a meeting is marked COMPLETED */
  const handleMeetingCompleted = useCallback(async (meetingType: string) => {
    if (!lead) return;
    if (getStoredUser()?.role === 'CRE') return; // CRE qualification stops at MQL
    const PROMPTS: Record<string, { from: string; label: string; targetStage: string }[]> = {
      DQL: [{ from: 'MQL', targetStage: 'DQL', label: 'DQL' }],
      PP: [
        { from: 'PROPOSAL_READY', targetStage: 'PROPOSAL_PRESENTED', label: 'Proposal Presented' },
        { from: 'DQL', targetStage: 'PROPOSAL_PRESENTED', label: 'Proposal Presented' }, // direct DQL→PP
      ],
      ONBOARDING: [{ from: 'PROPOSAL_DISCUSSION', targetStage: 'ONBOARDING', label: 'Onboarding' }],
    };
    const candidates = (PROMPTS[meetingType] ?? []).filter((p) => p.from === lead.stage);
    if (!candidates.length) return;
    const p = candidates[0];
    try {
      // Pre-check gate requirements — only show the prompt if the server will accept the move
      const result = await api.get<{ ok: boolean }>(`/leads/${lead.id}/can-advance?toStage=${p.targetStage}`);
      if (!result.ok) return; // gate not satisfied — don't prompt
    } catch {
      return; // endpoint unavailable — don't prompt
    }
    setStagePushPrompt({ targetStage: p.targetStage, label: stageLabel(p.targetStage) });
  }, [lead]);

  useEffect(() => {
    const t = searchParams.get('tab') as Tab | null;
    if (t) setActiveTab(t);
  }, [searchParams]);

  const handleTabChange = (tab: Tab) => {
    setActiveTab(tab);
    setSearchParams({ tab });
  };

  const loadUnreadChatCount = useCallback(async () => {
    if (!leadId) return;
    try {
      const data = await api.get<{ unreadCount: number }>(`/leads/${leadId}/chat/unread-count`);
      setUnreadChatCount(data.unreadCount ?? 0);
    } catch {
      // The Audit Log remains usable if its optional unread badge cannot load.
    }
  }, [leadId]);

  useEffect(() => {
    loadUnreadChatCount();
    const intervalId = window.setInterval(loadUnreadChatCount, 30000);
    return () => window.clearInterval(intervalId);
  }, [loadUnreadChatCount]);

  const hasOverdueTasks = leadFollowUpTasks.some((t) => t.isOverdue && t.status === 'PENDING');
  const openStageModal = () => {
    if (hasOverdueTasks) { toast.error('Resolve overdue tasks before advancing this lead'); handleTabChange('activity'); return; }
    setNewStage(lead?.stage ?? ''); setStageModal(true);
  };
  /** Opens the stage modal pre-selected to a specific target stage */
  const openStageModalTo = (targetStage: string) => {
    if (hasOverdueTasks) { toast.error('Resolve overdue tasks before advancing this lead'); handleTabChange('activity'); return; }
    setNewStage(targetStage); setStageModal(true);
  };

  const openStatusModal = (status: 'ON_HOLD' | 'INACTIVE') => {
    setInactivationReason(''); setInactiveReasonChoice(''); setInactiveNotes(''); setInactiveExternalNotes(''); setInactiveNotifyClient(false);
    setOnHoldEmail(lead?.email ?? ''); setOnHoldReason(''); setOnHoldNotes(''); setOnHoldExternalNotes(''); setOnHoldReopenDate(''); setOnHoldNotifyClient(true);
    setStatusModal(status);
  };

  // This app is India-only, so datetime-local inputs are treated as IST wall
  // time (not the browser's local timezone) — see istDatetimeLocalValue.
  const toLocalDatetimeInput = (iso: string) => istDatetimeLocalValue(iso);

  const openEditDetails = () => {
    if (!lead) return;
    const snapshot = {
      name: lead.name ?? '',
      phone: lead.phone ?? '',
      phone2: lead.phone2 ?? '',
      email: lead.email ?? '',
      email2: lead.email2 ?? '',
      pan: lead.pan ?? '',
      gst: lead.gst ?? '',
      projectType: lead.projectType ?? '',
      scope: lead.scope ?? '',
      location: lead.location ?? '',
      builder: lead.builder ?? '',
      // Sources are stored as codes (META_ADS); older edits saved the name
      // ("Meta Ads") — both map to the listed option. Anything else is "Other".
      source: lead.source ? (sourceValue(lead.source) || 'OTHER') : '',
      sourceOther: lead.source && !sourceValue(lead.source) ? lead.source : '',
      estimatedValue: lead.estimatedValue != null ? String(lead.estimatedValue) : '',
      expectedMoveIn: lead.expectedMoveIn ? istDateOnly(lead.expectedMoveIn) : '',
      expectedObDate: lead.expectedObDate ? istDateOnly(lead.expectedObDate) : '',
      offer1: lead.offer1 ?? '',
      offer2: lead.offer2 ?? '',
      offer3: lead.offer3 ?? '',
      // Holds a real Offer.id when the lead has a linked currentOffer; falls back
      // to a "__legacy__:<text>" sentinel for pre-existing free-text offer1 values
      // that don't correspond to any offer record (kept so it still displays,
      // but treated as "unchanged" unless the user actively picks something else).
      offerProposed: lead.currentOffer?.id ?? (lead.offer1 ? `__legacy__:${lead.offer1}` : ''),
      notes: lead.notes ?? '',
      possessionTimeline: lead.possessionTimeline ?? '',
      nextMeetingDate: lead.nextMeetingDate ? toLocalDatetimeInput(lead.nextMeetingDate) : '',
    };
    setEditDetails(snapshot);
    setOriginalEditDetails(snapshot);
    const savedPossession = lead.possessionTimeline ?? '';
    setPossessionMode(savedPossession === POSSESSION_RECEIVED ? 'received' :
      (savedPossession && !isIsoDateString(savedPossession) ? 'legacy' : 'custom'));
    setEditDetailsErrors({});
    setEditDetailsModal(true);
  };

  const handleSaveDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    // Only fields the user actually changed are validated and sent — legacy leads
    // with pre-existing blank/invalid data can still be saved untouched.
    const changedKeys = (Object.keys(editDetails) as (keyof typeof EMPTY_EDIT)[]).filter(
      (key) => editDetails[key] !== originalEditDetails[key],
    );
    const validatableKeys = ['name', 'phone', 'phone2', 'email', 'email2', 'projectType', 'scope', 'location', 'expectedMoveIn', 'possessionTimeline'] as const;
    const errors: Record<string, string> = {};
    for (const key of changedKeys) {
      if ((validatableKeys as readonly string[]).includes(key)) {
        const err = validateEditField(key, editDetails[key]);
        if (err) errors[key] = err;
      }
    }
    if ((changedKeys.includes('source') || changedKeys.includes('sourceOther')) && editDetails.source === 'OTHER' && !editDetails.sourceOther.trim()) {
      errors.sourceOther = 'Enter a lead source';
    }
    if (Object.keys(errors).length > 0) {
      setEditDetailsErrors(errors);
      toast.error(Object.values(errors)[0]);
      return;
    }
    if (changedKeys.length === 0) {
      setEditDetailsModal(false);
      return;
    }
    setSavingDetails(true);
    try {
      const fullPayload: Record<string, any> = {
        name: editDetails.name.trim() || null,
        phone: editDetails.phone.trim() || null,
        phone2: editDetails.phone2.trim() || null,
        email: editDetails.email.trim() || null,
        email2: editDetails.email2.trim() || null,
        pan: editDetails.pan.trim() || null,
        gst: editDetails.gst.trim() || null,
        projectType: editDetails.projectType.trim() || null,
        scope: editDetails.scope.trim() || null,
        location: editDetails.location.trim() || null,
        builder: editDetails.builder.trim() || null,
        source: editDetails.source === 'OTHER'
          ? editDetails.sourceOther.trim() || null
          : editDetails.source.trim() || null,
        estimatedValue: editDetails.estimatedValue.trim() || null,
        expectedMoveIn: editDetails.expectedMoveIn ? istInputToISO(editDetails.expectedMoveIn) : null,
        expectedObDate: editDetails.expectedObDate ? istInputToISO(editDetails.expectedObDate) : null,
        notes: editDetails.notes.trim() || null,
        possessionTimeline: editDetails.possessionTimeline.trim() || null,
        nextMeetingDate: editDetails.nextMeetingDate
          ? istInputToISO(editDetails.nextMeetingDate)
          : null,
      };
      // "Offer proposed" is handled separately below (via the dedicated offer
      // endpoint) so it must not fall through the generic key->field mapping —
      // fullPayload has no "offerProposed" property, and offer1/2/3 are no
      // longer independently editable.
      const genericKeys = changedKeys.filter((k) => k !== 'offerProposed');
      // Only send fields the user actually changed, so unrelated saves never trip
      // required-field checks on legacy data left blank before this field was required.
      const payload: Record<string, any> = {};
      for (const key of genericKeys) payload[key] = fullPayload[key];
      if (Object.keys(payload).length > 0) {
        await api.patch(`/leads/${leadId}`, payload);
      }
      if (changedKeys.includes('offerProposed')) {
        const val = editDetails.offerProposed;
        if (val && !val.startsWith('__legacy__:')) {
          // Real offer selected — go through the dedicated endpoint so
          // currentOfferId, the LeadOffer audit trail, and the OFFER_APPLIED
          // activity log all stay in sync (not just the legacy offer1 text).
          await api.post(`/leads/${leadId}/offer`, { offerId: val });
        } else {
          // Cleared back to "No offer".
          await api.patch(`/leads/${leadId}`, { currentOfferId: null, offer1: null });
        }
      }
      toast.success('Lead details updated');
      setEditDetailsModal(false);
      loadLead(); loadActivities();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not update details');
    } finally {
      setSavingDetails(false);
    }
  };

  // Task #114 — picking a target stage no longer commits it directly; it
  // opens the intent-rating + project-value capture step, which is what
  // actually persists the move.
  const handleStageChange = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newStage || newStage === lead?.stage) { setStageModal(false); return; }
    // Which stages may be skipped is decided by the server (Admin → Stage Rules);
    // a refused jump comes back with an explanation in the next step.
    setStageModal(false);
    setStageCaptureError(null);
    setStageCapture({ targetStage: newStage });
  };

  const handleStageCaptureConfirm = async (rating: number, value: number | null, reason: string, _sendNpsSurvey: boolean, overrideReason?: string) => {
    if (!stageCapture || !lead) return;
    setChangingStage(true);
    setStageCaptureError(null);
    setStageOverridable(false);
    try {
      // Only touch the intent rating if it's actually changing — resubmitting
      // an unchanged value that happens to differ from the system-computed
      // rating would otherwise spuriously demand a reason every single time.
      if (rating > 0 && rating !== (lead.intentRating ?? 0)) {
        try {
          await api.patch(`/leads/${leadId}/intent-rating`, { rating, reason: reason || undefined });
        } catch (e: any) {
          setStageCaptureError(e.message ?? 'Could not update intent rating — a reason may be required if this overrides the system-computed rating.');
          setChangingStage(false);
          return;
        }
      }
      const result = await api.patch<{
        pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null;
        blAutoAssignment?: 'assigned' | 'no_eligible_bl';
        gateWarnings?: string[];
      }>(
        `/leads/${leadId}`,
        {
          stage: stageCapture.targetStage,
          ...(value !== null && { estimatedValue: value }),
          ...(overrideReason && { overrideReason }),
        },
      );
      toast.success(`Stage → ${stageLabel(stageCapture.targetStage)}${result.blAutoAssignment === 'assigned' ? ' — BL assigned automatically' : ''}`);
      if (result.gateWarnings?.length) {
        toast(`Moved with missing items: ${result.gateWarnings.join('; ')}`, { duration: 9000, icon: '⚠️' });
      }
      if (result.blAutoAssignment === 'no_eligible_bl') {
        toast.error('No active Business Lead is available. The lead remains unassigned; contact an admin.');
      }
      setStageCapture(null);
      loadLead(); loadActivities();
      // Batch 12c Round 3b — the sign-off NPS survey mail is drafted, not
      // auto-sent; surface the same review-and-send modal used for
      // on-hold/inactive/reactivation mail.
      if (result.pendingMail) {
        setPendingMail({ draftKey: result.pendingMail.draftKey, to: result.pendingMail.to, subject: result.pendingMail.subject, html: result.pendingMail.html });
      }
    } catch (e: any) {
      setStageCaptureError(e.message ?? 'Could not change stage');
      // Blocked by missing items: offer the emergency override when this role has it.
      setStageOverridable(!!e?.data?.overridable && can('STAGE_OVERRIDE'));
    } finally {
      setChangingStage(false);
    }
  };

  // Task #88 — On Hold / Inactive are status changes, decoupled from stage.
  const handleSetStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!statusModal) return;
    if (statusModal === 'INACTIVE') {
      const resolvedInactiveReason = inactiveReasonChoice === 'Others'
        ? inactivationReason.trim() : inactiveReasonChoice;
      if (!resolvedInactiveReason) { toast.error('Please select or describe a reason for inactivation'); return; }
      if (!lead?.email?.trim() || !lead?.phone?.trim()) {
        toast.error('A client email and phone number are required to send the inactivation email + SMS — add both on the profile before continuing.');
        return;
      }
      setChangingStatus(true);
      try {
        const result = await api.patch<{ pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null }>(
          `/leads/${leadId}/status`,
          {
            status: 'INACTIVE',
            reason: resolvedInactiveReason,
            notes: inactiveNotes.trim() || undefined,
            externalNotes: inactiveExternalNotes.trim() || undefined,
            notifyClient: true,
          },
        );
        toast.success('Lead marked Inactive');
        setStatusModal(null);
        loadLead(); loadActivities();
        if (result.pendingMail) {
          setPendingMail({ draftKey: result.pendingMail.draftKey, to: result.pendingMail.to, subject: result.pendingMail.subject, html: result.pendingMail.html });
        }
      } catch (e: any) {
        toast.error(e.message ?? 'Could not mark lead inactive');
      } finally {
        setChangingStatus(false);
      }
      return;
    }
    // ON_HOLD
    const trimmedHoldEmail = onHoldEmail.trim();
    if (!trimmedHoldEmail) { toast.error("Client email is required before placing a lead on hold"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedHoldEmail)) { toast.error('Please enter a valid email address'); return; }
    if (!onHoldReason.trim()) { toast.error('Please select a reason for placing on hold'); return; }
    if (!onHoldReopenDate) { toast.error('Please select a reopen date'); return; }
    if (onHoldReopenDate <= istDateOnly(new Date())) { toast.error('Reopen date must be in the future'); return; }
    if (!lead?.phone?.trim()) {
      toast.error('A phone number is required to send the on-hold SMS — add one on the profile before continuing.');
      return;
    }
    setChangingStatus(true);
    try {
      // Persist email if it was supplied or changed in the modal
      if (trimmedHoldEmail !== lead?.email?.trim()) {
        await api.patch(`/leads/${leadId}`, { email: trimmedHoldEmail });
      }
      const result = await api.patch<{ pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null }>(
        `/leads/${leadId}/status`,
        {
          status: 'ON_HOLD',
          reason: onHoldReason.trim(),
          notes: onHoldNotes.trim() || undefined,
            externalNotes: onHoldExternalNotes.trim() || undefined,
          onHoldRevivalDate: onHoldReopenDate,
          notifyClient: true,
        },
      );
      toast.success('Lead placed On Hold');
      setStatusModal(null);
      loadLead(); loadActivities();
      if (result.pendingMail) {
        setPendingMail({ draftKey: result.pendingMail.draftKey, to: result.pendingMail.to, subject: result.pendingMail.subject, html: result.pendingMail.html });
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Could not place lead on hold');
    } finally {
      setChangingStatus(false);
    }
  };

  const openReactivateModal = () => {
    setReactivateReason('');
    setReactivateReasonOther('');
    setReactivateNotes('');
    setReactivateModal(true);
  };

  const handleReactivate = async (e: React.FormEvent) => {
    e.preventDefault();
    const resolvedReason = reactivateReason === 'Other' ? reactivateReasonOther.trim() : reactivateReason;
    if (!resolvedReason) { toast.error('Please select or enter a reason'); return; }
    if (!lead?.email?.trim()) { toast.error('This lead has no email on file. Add a client email before reactivating.'); return; }
    if (notifyMandatory.notify_mandatory_reactivate && !lead?.phone?.trim()) {
      toast.error('Client notifications are mandatory for reactivation — add a phone number on this lead before continuing.');
      return;
    }
    setReactivating(true);
    try {
      const result = await api.post<{ pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } | null }>(
        `/leads/${leadId}/reactivate`,
        {
          reason: resolvedReason,
          notes: reactivateNotes.trim() || undefined,
          notifyClient: notifyMandatory.notify_mandatory_reactivate ? true : reactivateNotifyClient,
        },
      );
      toast.success('Lead reactivated');
      setReactivateModal(false);
      loadLead(); loadActivities();
      if (result.pendingMail) {
        setPendingMail({ draftKey: result.pendingMail.draftKey, to: result.pendingMail.to, subject: result.pendingMail.subject, html: result.pendingMail.html });
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Could not reactivate lead');
    } finally {
      setReactivating(false);
    }
  };

  const handleSendPendingMail = async (subject: string, html: string) => {
    if (!pendingMail) return;
    setSendingMail(true);
    try {
      await api.post('/email/send-draft', { draftKey: pendingMail.draftKey, to: pendingMail.to, subject, html });
      setMailSentNotice(`Mail sent to ${pendingMail.to}`);
      setPendingMail(null);
      setTimeout(() => setMailSentNotice(null), 4000);
    } catch (e: any) {
      toast.error(e.message ?? 'Could not send mail');
    } finally {
      setSendingMail(false);
    }
  };

  const openIntentModal = (initial: number) => {
    setPendingRating(initial || 0);
    setIntentReason('');
    setIntentModal(true);
  };

  const handleIntentSave = async () => {
    if (!pendingRating) { toast.error('Select a rating'); return; }
    setSavingIntent(true);
    try {
      await api.patch(`/leads/${leadId}/intent-rating`, { rating: pendingRating, reason: intentReason });
      toast.success('Intent rating updated');
      setIntentModal(false);
      loadLead(); loadActivities();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not update rating');
    } finally {
      setSavingIntent(false);
    }
  };

  const openFlagModal = () => {
    setFlagCategory('');
    setFlagDescription('');
    setFlagModal(true);
  };

  const handleFlagSave = async () => {
    if (!flagCategory.trim() || !flagDescription.trim()) { toast.error('Category and description are required'); return; }
    setSavingFlag(true);
    try {
      await api.post(`/leads/${leadId}/attention-flag`, { category: flagCategory.trim(), description: flagDescription.trim() });
      toast.success('Lead flagged for attention');
      setFlagModal(false);
      loadLead(); loadActivities();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not flag lead');
    } finally {
      setSavingFlag(false);
    }
  };

  const handleResolveFlag = async (flagId: string) => {
    setResolvingFlagId(flagId);
    try {
      await api.patch(`/leads/${leadId}/attention-flag/${flagId}/resolve`, {});
      toast.success('Flag resolved');
      loadLead(); loadActivities();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not resolve flag');
    } finally {
      setResolvingFlagId(null);
    }
  };

  const handleFloorPlanUpload = async (file: File) => {
    setUploadingFloorPlan(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      await uploadFile(`/leads/${leadId}/floor-plan`, formData);
      toast.success('Floor plan uploaded');
      loadLead();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not upload floor plan');
    } finally {
      setUploadingFloorPlan(false);
    }
  };

  const handleReassign = async () => {
    if (!reassignField || !reassignValue) return;
    setSavingReassign(true);
    try {
      const isBLDesignerAllocation = reassignField === 'designer' && getStoredUser()?.role === 'BL';
      if (isBLDesignerAllocation) {
        await api.patch(`/leads/${leadId}/assign-direct`, { designerId: reassignValue });
        toast.success('Designer allocated');
      } else {
        await api.patch(`/leads/${leadId}`, {
          ...(reassignField === 'designer' ? { assignedDesignerId: reassignValue } : { assignedBLId: reassignValue }),
        });
        toast.success('Reassigned');
      }
      setReassignField(null);
      loadLead();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not reassign');
    } finally {
      setSavingReassign(false);
    }
  };

  const handleAllocateBL = async () => {
    if (!selectedBLId || !leadId) return;
    setAllocatingBL(true);
    try {
      await api.post(`/leads/${leadId}/allocate-bl`, { blId: selectedBLId });
      toast.success('BL allocated — they have been notified');
      setSelectedBLId('');
      setCreBLList([]);
      loadLead();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not allocate BL');
    } finally {
      setAllocatingBL(false);
    }
  };

  const handlePushbackMQL = async () => {
    if (!pushbackReason.trim() || !leadId) return;
    setPushingBack(true);
    try {
      await api.post(`/leads/${leadId}/pushback-mql`, { reason: pushbackReason });
      toast.success('Lead returned to CRE for re-qualification');
      setShowPushbackForm(false);
      setPushbackReason('');
      loadLead();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not push back lead');
    } finally {
      setPushingBack(false);
    }
  };

  // Activity = combined Calls + Meetings + Tasks feed. Audit Log = system audit + chat.
  const activityCount = lead ? lead._count.calls + lead._count.meetings : null;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'activity', label: activityCount !== null ? `Activity (${activityCount})` : 'Activity' },
    { id: 'audit', label: unreadChatCount > 0 ? `Audit Log (${unreadChatCount})` : 'Audit Log' },
    { id: 'whatsapp', label: 'WhatsApp' },
    { id: 'quotes', label: 'Quotes' },
    { id: 'discount', label: 'Discount' },
    { id: 'files', label: 'Files' },
    { id: 'team' as Tab, label: 'Team' },
  ];

  const latestQuote = quotes[0];
  const latestQuoteAttachment = quoteAttachments[0];
  const currentUser = getStoredUser();
  // CRE qualification runs from Effective Lead to MQL. Keep later stages out of
  // the CRE overview roadmap and timeline while preserving other roles' full funnel.
  // Stages switched off in Admin → CRM Settings drop out of the roadmap,
  // unless this lead is in one or has passed through it.
  const visibleFunnelStages = currentUser?.role === 'CRE'
    ? ['EFFECTIVE_LEAD', 'MQL']
    : FUNNEL_STAGES.filter((s) => !crmSettings().hiddenStages.includes(s) || s === lead?.stage || stageHistory.some((v) => v.stage === s));
  const visibleStageHistory = stageHistory.filter((visit) => visibleFunnelStages.includes(visit.stage));
  const canChangeStage = !isLocked && (currentUser?.role !== 'CRE' || lead?.stage === 'EFFECTIVE_LEAD');
  const stageChangeTitle = isLocked
    ? 'Lead is Inactive — reactivate to change stage'
    : currentUser?.role === 'CRE' && !canChangeStage
      ? 'CRE qualification ends at MQL'
      : 'Click to change stage';
  const designerUsers = currentUser?.role === 'BL'
    ? blTeamDesigners
    : users.filter((u) => u.role === 'DESIGNER');
  const blUsers = users.filter((u) => u.role === 'BL');

  return (
    <div className="min-h-screen">
      {/* ── Auto Stage-Advance Prompt (after meeting completed) ─────────────── */}
      {stagePushPrompt && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-6 text-center">
            <div className="text-3xl mb-3">🎉</div>
            <h3 className="font-semibold text-gray-900 text-lg mb-2">Meeting Completed!</h3>
            <p className="text-sm text-gray-500 mb-5">
              Would you like to advance this lead to <strong>{stagePushPrompt.label}</strong>?
              The server will verify all gate requirements before accepting the move.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setStagePushPrompt(null)}
                className="flex-1 border border-gray-200 text-gray-600 py-2 rounded-xl text-sm hover:bg-gray-50 transition-colors"
              >
                Not yet
              </button>
              <button
                onClick={() => { const t = stagePushPrompt!.targetStage; setStagePushPrompt(null); openStageModalTo(t); }}
                className="flex-1 bg-brand-500 text-white py-2 rounded-xl text-sm font-medium hover:bg-brand-600 transition-colors"
              >
                Advance Stage →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Stage-change modal ────────────────────────────────────────────────── */}
      {stageModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6">
            <h3 className="font-bold text-stone-900 mb-4 tracking-tight">Change Stage</h3>
            <form onSubmit={handleStageChange} className="space-y-4">
              <select value={newStage} onChange={(e) => setNewStage(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
                {/* Effective Lead / Handed Over are legacy — not selectable going
                    forward, but still shown (disabled) if the lead is already
                    sitting there so the dropdown reflects its real stage. */}
                {LEGACY_STAGES.includes(lead?.stage ?? '') && (
                  <option key={lead!.stage} value={lead!.stage} disabled>
                    {stageLabel(lead!.stage)} (legacy — current)
                  </option>
                )}
                {(currentUser?.role === 'CRE' ? ['MQL'] : SELECTABLE_STAGES.filter((s) => !crm.hiddenStages.includes(s) || s === lead?.stage)).map((s) => (
                  <option key={s} value={s}>{stageLabel(s)}</option>
                ))}
              </select>
              <div className="flex gap-3">
                <button type="button" onClick={() => setStageModal(false)}
                  className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
                <button type="submit" disabled={changingStage || !newStage || newStage === lead?.stage}
                  className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {changingStage ? 'Saving…' : 'Update Stage'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Stage-change capture step (task #114) — intent rating + project
           value must be confirmed before the move is committed. ───────────── */}
      {stageCapture && lead && (
        <StageCaptureModal
          leadName={lead.name}
          targetStageLabel={stageLabel(stageCapture.targetStage)}
          initialRating={lead.intentRating}
          initialValue={lead.estimatedValue}
          saving={changingStage}
          error={stageCaptureError}
          canOverride={stageOverridable}
          onCancel={() => { setStageCapture(null); setStageCaptureError(null); setStageOverridable(false); }}
          onConfirm={handleStageCaptureConfirm}
        />
      )}

      {/* ── On Hold / Inactive status modal (task #88) — separate from stage ──── */}
      {statusModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">
              {statusModal === 'ON_HOLD' ? 'Place On Hold' : 'Mark Inactive'}
            </h3>
            <p className="text-xs text-stone-400 mb-4">
              The lead stays at <strong>{stageLabel(lead?.stage ?? '')}</strong> — only its status changes.
            </p>
            <form onSubmit={handleSetStatus} className="space-y-3">
              {statusModal === 'INACTIVE' && (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                      Reason <span className="text-brand-500">*</span>
                    </label>
                    <select value={inactiveReasonChoice} onChange={(e) => setInactiveReasonChoice(e.target.value)}
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
                      <option value="">Select a reason…</option>
                      {crm.inactiveReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  {inactiveReasonChoice === 'Others' && (
                    <input type="text" value={inactivationReason} onChange={(e) => setInactivationReason(e.target.value)}
                      required placeholder="Describe the reason"
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
                  )}

                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">Internal Notes</label>
                    <textarea rows={2} value={inactiveNotes} onChange={(e) => setInactiveNotes(e.target.value)}
                      placeholder="For internal reference only — not shared with the client"
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">External Notes</label>
                    <textarea rows={2} value={inactiveExternalNotes} onChange={(e) => setInactiveExternalNotes(e.target.value)}
                      placeholder="Optional note to share with the client"
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
                    <p className="text-xs text-stone-400 mt-1">Included in the client-facing notification.</p>
                  </div>
                  {(!lead?.email?.trim() || !lead?.phone?.trim()) && (
                    <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">
                      A client email and phone are required to send the inactivation email + SMS — add both on the profile before continuing.
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input type="checkbox"
                      checked={true}
                      disabled
                      className="rounded border-stone-300 text-brand-500 focus:ring-brand-400 disabled:opacity-70" />
                    Send feedback-request email + SMS to client
                    <span className="text-[10px] text-stone-400">(mandatory)</span>
                  </label>
                  <p className="text-xs text-stone-500 mt-1">The internal team is always notified.</p>
                </>
              )}
              {statusModal === 'ON_HOLD' && (
                <>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                      Client Email <span className="text-brand-500">*</span>
                    </label>
                    <input
                      type="email"
                      required
                      value={onHoldEmail}
                      onChange={(e) => setOnHoldEmail(e.target.value)}
                      placeholder="client@example.com"
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                    />
                    <p className="text-xs text-stone-400 mt-1">Used to send the on-hold notification — saved to the lead if new.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                      Reason <span className="text-brand-500">*</span>
                    </label>
                    <select value={onHoldReason} onChange={(e) => setOnHoldReason(e.target.value)}
                      required
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
                      <option value="">Select a reason…</option>
                      {crm.onHoldReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">Internal Notes</label>
                    <textarea rows={2} value={onHoldNotes} onChange={(e) => setOnHoldNotes(e.target.value)}
                      placeholder="For internal reference only — not shared with the client"
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">External Notes</label>
                    <textarea rows={2} value={onHoldExternalNotes} onChange={(e) => setOnHoldExternalNotes(e.target.value)}
                      placeholder="Optional note to share with the client"
                      className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
                    <p className="text-xs text-stone-400 mt-1">Included in the client-facing notification.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                      Reopen date <span className="text-brand-500">*</span>
                    </label>
                    <DateInput value={onHoldReopenDate} onChange={setOnHoldReopenDate}
                      required min={istDateOnly(new Date(Date.now() + 86400000))}
                      className="w-full rounded-xl px-3 py-2.5 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all" />
                    <p className="text-xs text-stone-400 mt-1">Internal team notified now. Lead auto-reactivates when this date arrives.</p>
                  </div>
                  {!lead?.phone?.trim() && (
                    <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">
                      A phone number is required to send the on-hold SMS — add one on the profile before continuing.
                    </p>
                  )}
                  <label className="flex items-center gap-2 text-sm text-stone-700">
                    <input type="checkbox"
                      checked={true}
                      disabled
                      className="rounded border-stone-300 text-brand-500 focus:ring-brand-400 disabled:opacity-70" />
                    Send on-hold email + SMS to client
                    <span className="text-[10px] text-stone-400">(mandatory)</span>
                  </label>
                </>
              )}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setStatusModal(null)}
                  className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
                <button type="submit" disabled={changingStatus}
                  className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {changingStatus ? 'Saving…' : (statusModal === 'ON_HOLD' ? 'Place On Hold' : 'Mark Inactive')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Edit Lead Details modal ───────────────────────────────────────────── */}
      {editDetailsModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-start justify-center z-50 p-4 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-lg p-6 my-4">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Edit Lead Details</h3>
            <p className="text-xs text-stone-400 mb-5">
              The following <strong>Project Details</strong> are required before moving EL → MQL:
              Client Budget, Project Type, Lead Source, Location, Builder, Scope of Work, Expected Interior Handover Date.
              Client Details fields are recommended but not gated.
              Leads with 1★ intent cannot advance regardless.
            </p>
            <form onSubmit={handleSaveDetails} className="space-y-5">
              {/* ── Client Details ─────────────────────────────────────────── */}
              <div>
                <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-3">Client Details</p>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { key: 'name', label: 'Full Name', placeholder: 'Amit Sharma', colSpan: 2, required: true },
                    { key: 'phone', label: 'Phone', placeholder: '+91 98765 43210', required: true },
                    { key: 'phone2', label: 'Alternate Phone', placeholder: '' },
                    { key: 'email', label: 'Email', placeholder: 'amit@example.com', type: 'email' },
                    { key: 'email2', label: 'Alternate Email', placeholder: '', type: 'email' },
                    { key: 'pan', label: 'PAN', placeholder: 'ABCDE1234F' },
                    { key: 'gst', label: 'GST', placeholder: '29ABCDE1234F1ZX' },
                  ] as { key: keyof typeof EMPTY_EDIT; label: string; placeholder?: string; type?: string; colSpan?: number; required?: boolean }[]).map((f) => (
                    <div key={f.key} className={f.colSpan === 2 ? 'col-span-2' : ''}>
                      <label className="block text-xs font-semibold text-stone-600 mb-1">
                        {f.label}{f.required && <span className="text-brand-500 ml-0.5">*</span>}
                      </label>
                      {f.key === 'phone' || f.key === 'phone2' ? (
                        <PhoneInput
                          id={f.key}
                          value={editDetails[f.key]}
                          onChange={(v) => setEditDetails({ ...editDetails, [f.key]: v })}
                          onBlur={() => validateEditField(f.key, editDetails[f.key])}
                          required={f.required}
                          hasError={!!editDetailsErrors[f.key]}
                        />
                      ) : (
                        <input
                          type={f.type ?? 'text'}
                          value={editDetails[f.key]}
                          onChange={(e) => setEditDetails({ ...editDetails, [f.key]: e.target.value })}
                          onBlur={(e) => validateEditField(f.key, e.target.value)}
                          placeholder={f.placeholder}
                          className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 transition-all"
                          style={{
                            border: editDetailsErrors[f.key] ? '1px solid #EF4444' : '1px solid #EDE8E3',
                            background: '#FDFAF7',
                          }}
                        />
                      )}
                      {editDetailsErrors[f.key] && (
                        <p className="text-[11px] text-red-500 mt-1">{editDetailsErrors[f.key]}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Project Details ─────────────────────────────────────────── */}
              <div>
                <p className="text-[10px] font-bold text-stone-400 uppercase tracking-widest mb-3">Project Details</p>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { key: 'projectType', label: 'Project Type', placeholder: '2BHK / Villa / Office', required: true },
                    { key: 'scope', label: 'Scope of Work', placeholder: 'FHD / Modulars / Kitchen', required: true },
                    { key: 'location', label: 'Location', placeholder: 'Whitefield, Bangalore', required: true },
                    { key: 'builder', label: 'Builder', placeholder: 'Sobha / Godrej / Independent builder' },
                  ] as { key: keyof typeof EMPTY_EDIT; label: string; placeholder?: string; type?: string; colSpan?: number; multiline?: boolean; required?: boolean }[]).map((f) => (
                    <div key={f.key} className={f.colSpan === 2 ? 'col-span-2' : ''}>
                      <label className="block text-xs font-semibold text-stone-600 mb-1">
                        {f.label}{f.required && <span className="text-brand-500 ml-0.5">*</span>}
                      </label>
                      {f.key === 'location' ? (
                        <LeadLocationSelector
                          value={editDetails.location}
                          onChange={(location) => setEditDetails({ ...editDetails, location })}
                          onBlur={() => validateEditField('location', editDetails.location)}
                          required
                          areaOptional={lenient}
                          hasError={!!editDetailsErrors.location}
                        />
                      ) : (
                        <input
                          type={f.type ?? 'text'}
                          value={editDetails[f.key]}
                          onChange={(e) => setEditDetails({ ...editDetails, [f.key]: e.target.value })}
                          onBlur={(e) => validateEditField(f.key, e.target.value)}
                          placeholder={f.placeholder}
                          className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 transition-all"
                          style={{
                            border: editDetailsErrors[f.key] ? '1px solid #EF4444' : '1px solid #EDE8E3',
                            background: '#FDFAF7',
                          }}
                        />
                      )}
                      {editDetailsErrors[f.key] && (
                        <p className="text-[11px] text-red-500 mt-1">{editDetailsErrors[f.key]}</p>
                      )}
                    </div>
                  ))}
                  {/* Source — select with common values */}
                  <div>
                    <label className="block text-xs font-semibold text-stone-600 mb-1">Lead Source <span className="text-brand-500">*</span></label>
                    <select
                      value={editDetails.source}
                      onChange={(e) => setEditDetails({ ...editDetails, source: e.target.value })}
                      className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                    >
                      <option value="">Select source…</option>
                      {crm.leadSources.filter((s) => s.active || s.value === editDetails.source).map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                    {editDetails.source === 'OTHER' && (
                      <>
                        <input
                          type="text"
                          value={editDetails.sourceOther}
                          onChange={(e) => setEditDetails({ ...editDetails, sourceOther: e.target.value })}
                          onBlur={(e) => {
                            setEditDetailsErrors((prev) => {
                              const next = { ...prev };
                              if (!e.target.value.trim()) next.sourceOther = 'Enter a lead source';
                              else delete next.sourceOther;
                              return next;
                            });
                          }}
                          placeholder="Enter lead source"
                          className="w-full rounded-xl px-3 py-2 text-sm mt-2 focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                          style={{
                            border: editDetailsErrors.sourceOther ? '1px solid #EF4444' : '1px solid #EDE8E3',
                            background: '#FDFAF7',
                          }}
                        />
                        {editDetailsErrors.sourceOther && (
                          <p className="text-[11px] text-red-500 mt-1">{editDetailsErrors.sourceOther}</p>
                        )}
                      </>
                    )}
                  </div>
                  {/* Possession — custom date or received (legacy text remains readable). */}
                  <div>
                    <label className="block text-xs font-semibold text-stone-600 mb-1">Possession</label>
                    <select
                      value={possessionMode === 'received' ? POSSESSION_RECEIVED : possessionMode === 'legacy' ? '__legacy__' : '__custom__'}
                      onChange={(e) => {
                        if (e.target.value === POSSESSION_RECEIVED) {
                          setPossessionMode('received');
                          setEditDetails({ ...editDetails, possessionTimeline: POSSESSION_RECEIVED });
                        } else if (e.target.value === '__custom__') {
                          setPossessionMode('custom');
                          setEditDetails({ ...editDetails, possessionTimeline: isIsoDateString(editDetails.possessionTimeline) ? editDetails.possessionTimeline : '' });
                        }
                      }}
                      className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                      style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                    >
                      <option value="__custom__">Custom date</option>
                      <option value={POSSESSION_RECEIVED}>{POSSESSION_RECEIVED}</option>
                      {possessionMode === 'legacy' && <option value="__legacy__">{editDetails.possessionTimeline} (legacy)</option>}
                    </select>
                    {possessionMode === 'custom' && (
                      <>
                        <DateInput
                          value={isIsoDateString(editDetails.possessionTimeline) ? editDetails.possessionTimeline : ''}
                          min={istDateOnly(new Date())}
                          onChange={(v) => setEditDetails({ ...editDetails, possessionTimeline: v })}
                          className="w-full rounded-xl px-3 py-2 text-sm border-[#EDE8E3] bg-[#FDFAF7] focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all mt-2"
                        />
                        {editDetails.possessionTimeline && !isIsoDateString(editDetails.possessionTimeline) && (
                          <p className="text-[11px] text-stone-400 mt-1">
                            Previously saved as "{editDetails.possessionTimeline}" — pick a date above to replace it.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                  {([
                    { key: 'estimatedValue', label: 'Client Budget (₹)', placeholder: '1500000', type: 'number' },
                    { key: 'expectedMoveIn', label: 'Expected Interior Handover Date', type: 'date' },
                    { key: 'expectedObDate', label: 'Expected OB Date', type: 'date' },
                    { key: 'offerProposed', label: 'Offer proposed', type: 'offer' },
                    { key: 'notes', label: 'Notes', placeholder: 'Any additional context…', colSpan: 2, multiline: true },
                  ] as { key: keyof typeof EMPTY_EDIT; label: string; placeholder?: string; type?: string; colSpan?: number; multiline?: boolean }[]).map((f) => (
                    <div key={f.key} className={f.colSpan === 2 ? 'col-span-2' : ''}>
                      <label className="block text-xs font-semibold text-stone-600 mb-1">{f.label}</label>
                      {f.multiline ? (
                        <textarea
                          rows={3}
                          value={editDetails[f.key]}
                          onChange={(e) => setEditDetails({ ...editDetails, [f.key]: e.target.value })}
                          placeholder={f.placeholder}
                          className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all resize-none"
                          style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                        />
                      ) : f.type === 'offer' ? (
                        <select
                          value={editDetails[f.key]}
                          onChange={(e) => setEditDetails({ ...editDetails, [f.key]: e.target.value })}
                          className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                          style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                        >
                          <option value="">No offer</option>
                          {editDetails[f.key].startsWith('__legacy__:') && (
                            <option value={editDetails[f.key]}>
                              {editDetails[f.key].slice('__legacy__:'.length)} (no longer active)
                            </option>
                          )}
                          {offerOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                        </select>
                      ) : f.type === 'date' ? (
                        <DateInput
                          value={editDetails[f.key] as string}
                          onChange={(v) => setEditDetails({ ...editDetails, [f.key]: v })}
                        />
                      ) : (
                        <input
                          type={f.type ?? 'text'}
                          value={editDetails[f.key]}
                          onChange={(e) => setEditDetails({ ...editDetails, [f.key]: e.target.value })}
                          placeholder={f.placeholder}
                          className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                          style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setEditDetailsModal(false)}
                  className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
                <button type="submit" disabled={savingDetails}
                  className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {savingDetails ? 'Saving…' : 'Save Details'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Reactivation modal (task #40) ─────────────────────────────────────── */}
      {reactivateModal && lead && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Reactivate Lead</h3>
            <p className="text-xs text-stone-400 mb-4">
              Status returns to Active — the lead stays at <strong>{stageLabel(lead.stage)}</strong>, its stage never moved.
            </p>
            <form onSubmit={handleReactivate} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1.5">
                  Reason <span className="text-brand-500">*</span>
                </label>
                <select value={reactivateReason} onChange={(e) => setReactivateReason(e.target.value)}
                  required
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
                  <option value="">Select a reason…</option>
                  {crm.reactivationReasons.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              {reactivateReason === 'Other' && (
                <input type="text" value={reactivateReasonOther} onChange={(e) => setReactivateReasonOther(e.target.value)}
                  required placeholder="Describe the reason"
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              )}
              <div>
                <label className="block text-sm font-semibold text-stone-700 mb-1.5">Notes (optional)</label>
                <textarea rows={2} value={reactivateNotes} onChange={(e) => setReactivateNotes(e.target.value)}
                  placeholder="Any additional context"
                  className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                  style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              </div>
              {notifyMandatory.notify_mandatory_reactivate && !lead?.phone?.trim() && (
                <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">
                  Client notifications are mandatory for reactivation, but this lead has no phone on file. Add one on the profile before continuing.
                </p>
              )}
              <label className="flex items-center gap-2 text-sm text-stone-700">
                <input type="checkbox"
                  checked={notifyMandatory.notify_mandatory_reactivate ? true : reactivateNotifyClient}
                  disabled={!!notifyMandatory.notify_mandatory_reactivate}
                  onChange={(e) => setReactivateNotifyClient(e.target.checked)}
                  className="rounded border-stone-300 text-brand-500 focus:ring-brand-400 disabled:opacity-70" />
                Send reactivation email to client
                {notifyMandatory.notify_mandatory_reactivate && <span className="text-[10px] text-stone-400">(mandatory)</span>}
              </label>
              <p className="text-xs text-stone-500">The internal team is always notified automatically.</p>
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setReactivateModal(false)}
                  className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                  style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
                <button type="submit" disabled={reactivating}
                  className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors">
                  {reactivating ? 'Reactivating…' : 'Reactivate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Intent override modal ─────────────────────────────────────────────── */}
      {intentModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Override Intent Rating</h3>
            <p className="text-xs text-stone-400 mb-4">System auto-rates based on meeting type. Reason required when overriding manually.</p>
            <div className="flex justify-center mb-4">
              <StarRating rating={pendingRating} onSelect={setPendingRating} />
            </div>
            {pendingRating === 1 && (
              <div className="mb-3 flex items-start gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-3 py-2 text-xs">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>{lenient ? '1★ means "no action planned". You can still advance this lead; the move will be logged for review.' : '1★ means "no action planned". This lead will be blocked from advancing stages until the rating is updated.'}</span>
              </div>
            )}
            <div className="mb-4">
              <label className="block text-sm font-semibold text-stone-700 mb-1.5">Reason</label>
              <textarea rows={2} value={intentReason} onChange={(e) => setIntentReason(e.target.value)}
                placeholder="e.g. Client confirmed purchase intent during site visit"
                className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
              <p className="text-xs text-stone-400 mt-1">Required if overriding system rating.</p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setIntentModal(false)}
                className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
              <button onClick={handleIntentSave} disabled={savingIntent || !pendingRating}
                className="flex-1 bg-brand-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-brand-600 disabled:opacity-50 transition-colors">
                {savingIntent ? 'Saving…' : 'Save Rating'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lead attention-flag modal ─────────────────────────────────────────── */}
      {flagModal && (
        <div className="fixed inset-0 bg-stone-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-3xl shadow-warm-lg w-full max-w-sm p-6">
            <h3 className="font-bold text-stone-900 mb-1 tracking-tight">Flag Lead for Attention</h3>
            <p className="text-xs text-stone-400 mb-4">Visible to the team until resolved.</p>
            <div className="mb-3">
              <label className="block text-sm font-semibold text-stone-700 mb-1.5">Category</label>
              <select value={flagCategory} onChange={(e) => setFlagCategory(e.target.value)}
                className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }}>
                <option value="">Select category…</option>
                {crm.flagCategories.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-sm font-semibold text-stone-700 mb-1.5">Description</label>
              <textarea rows={3} value={flagDescription} onChange={(e) => setFlagDescription(e.target.value)}
                placeholder="What needs attention?"
                className="w-full rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-300 transition-all"
                style={{ border: '1px solid #EDE8E3', background: '#FDFAF7' }} />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setFlagModal(false)}
                className="flex-1 text-stone-600 py-2.5 rounded-xl text-sm hover:bg-stone-50 transition-colors"
                style={{ border: '1px solid #EDE8E3' }}>Cancel</button>
              <button onClick={handleFlagSave} disabled={savingFlag || !flagCategory || !flagDescription.trim()}
                className="flex-1 bg-red-500 text-white py-2.5 rounded-xl text-sm font-semibold hover:bg-red-600 disabled:opacity-50 transition-colors">
                {savingFlag ? 'Flagging…' : 'Flag Lead'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Hidden floor plan file input ─────────────────────────────────────── */}
      <input
        type="file"
        ref={floorPlanInputRef}
        accept=".pdf,.jpg,.jpeg,.png,.dwg,.dxf"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFloorPlanUpload(file);
          e.target.value = '';
        }}
      />

      {/* ── Sticky header ─────────────────────────────────────────────────────── */}
      <div className="sticky top-0 z-10 bg-white px-6 py-3" style={{ borderBottom: '1px solid #EDE8E3' }}>
        {loadingLead ? (
          <div className="h-12 flex items-center">
            <div className="h-4 w-48 rounded-lg animate-pulse" style={{ background: '#EDE8E3' }} />
          </div>
        ) : lead ? (
          <div className="flex items-start justify-between gap-4">
            {/* Left: name + subtitle + stage/intent row */}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-extrabold text-stone-900 tracking-tight truncate min-w-0" title={lead.name}>{lead.name}</h1>
                {lead.isSLABreached && (
                  <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-600 px-2 py-0.5 rounded-full font-semibold">
                    <AlertTriangle size={10} strokeWidth={2.5} /> SLA
                  </span>
                )}
                {lead.currentOffer && (
                  <span className="inline-flex items-center gap-1 text-xs bg-brand-50 text-brand-700 px-2 py-0.5 rounded-full font-semibold">
                    <Gift size={10} strokeWidth={2} /> {lead.currentOffer.name}
                  </span>
                )}
                {/* Fixes 4 & 5: show badge whenever a survey has been sent, even if
                    the client hasn't responded yet (score null → show "—").
                    Labelled "Client NPS" to distinguish from Intent Rating stars. */}
                {Object.keys(npsPerStage).length > 0 && (
                  <span
                    className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-bold ${
                      avgNps == null
                        ? 'bg-gray-100 text-gray-500'
                        : avgNps >= 9 ? 'bg-green-100 text-green-700'
                        : avgNps >= 7 ? 'bg-amber-100 text-amber-700'
                        : 'bg-red-100 text-red-700'
                    }`}
                    title={
                      avgNps == null
                        ? `Client NPS — survey sent, awaiting response (${Object.keys(npsPerStage).length} survey${Object.keys(npsPerStage).length !== 1 ? 's' : ''})`
                        : `Client NPS: ${avgNps}/10 (average of ${Object.keys(npsPerStage).length} response${Object.keys(npsPerStage).length !== 1 ? 's' : ''})`
                    }
                  >
                    ★ Client NPS {avgNps ?? '—'}
                  </span>
                )}
              </div>
              <p className="text-xs text-stone-400 mt-0.5 font-medium">
                {lead.leadId}
                {lead.isDuplicate && <span className="ml-1.5 text-[10px] font-bold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full" title="This lead was flagged as a duplicate of another enquiry">Duplicate</span>}
                {lead.projectType ? ` · ${lead.projectType}` : ''}
                {lead.scope ? ` · ${lead.scope}` : ''}
                {lead.location ? ` · ${lead.location}` : ''}
              </p>
              {/* Stage + intent row */}
              <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                <button
                  onClick={canChangeStage ? openStageModal : undefined}
                  disabled={!canChangeStage}
                  className={`text-xs px-2.5 py-0.5 rounded-full font-semibold transition-opacity ${STAGE_COLORS[lead.stage] ?? 'bg-stone-100 text-stone-600'} ${!canChangeStage ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:opacity-80'}`}
                  title={stageChangeTitle}
                >
                  <span className="flex items-center gap-1">{stageLabel(lead.stage)} {canChangeStage && <ChevronDown size={10} strokeWidth={2.5} />}</span>
                </button>
                {/* Task #88: status badge, decoupled from stage */}
                {lead.status !== 'ACTIVE' && (
                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-semibold ${STATUS_COLORS[lead.status] ?? 'bg-stone-100 text-stone-600'}`}>
                    {STATUS_LABELS[lead.status] ?? lead.status}
                  </span>
                )}
                {/* Intent stars + auto badge */}
                <button
                  onClick={isLocked ? undefined : () => openIntentModal(lead.intentRating ?? 0)}
                  disabled={isLocked}
                  title={isLocked ? 'Lead is Inactive — reactivate to override intent rating' : 'Click to override intent rating'}
                  className={`flex items-center gap-1.5 transition-opacity ${isLocked ? 'opacity-60 cursor-not-allowed' : 'hover:opacity-70'}`}
                >
                  {Array.from({ length: 5 }, (_, i) => (
                    <span key={i} className={`text-base ${i < (lead.intentRating ?? 0) ? 'text-amber-400' : 'text-stone-200'}`}>★</span>
                  ))}
                  {lead.intentRatingSource === 'auto' && (
                    <span className="text-[9px] font-bold bg-sky-100 text-sky-600 px-1.5 py-0.5 rounded-full tracking-wide">AUTO</span>
                  )}
                  {lead.intentRatingSource === 'manual' && (
                    <span className="text-[9px] font-bold bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full tracking-wide">MANUAL</span>
                  )}
                </button>
                {/* 1-star warning */}
                {lead.intentRating === 1 && (
                  <span className="inline-flex items-center gap-1 text-xs bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded-full font-medium">
                    <AlertTriangle size={10} strokeWidth={2.5} />
                    {lenient ? '1★ — low intent (advance will be logged)' : '1★ — cannot advance stage'}
                  </span>
                )}
              </div>
            </div>

            {/* Right: action buttons */}
            <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
              <button
                onClick={openFlagModal}
                className="flex items-center gap-1.5 text-red-600 px-3 py-1.5 rounded-xl text-xs hover:bg-red-50 transition-colors font-medium"
                style={{ border: '1px solid #fca5a5' }}
              ><AlertTriangle size={13} strokeWidth={2} /> Flag</button>
              <button
                onClick={() => handleTabChange('activity')}
                className="flex items-center gap-1.5 text-stone-600 px-3 py-1.5 rounded-xl text-xs hover:bg-stone-50 transition-colors font-medium"
                style={{ border: '1px solid #EDE8E3' }}
              ><Phone size={13} strokeWidth={2} /> Log Call</button>
              <button
                onClick={() => handleTabChange('activity')}
                className="flex items-center gap-1.5 text-stone-600 px-3 py-1.5 rounded-xl text-xs hover:bg-stone-50 transition-colors font-medium"
                style={{ border: '1px solid #EDE8E3' }}
              ><CalendarPlus size={13} strokeWidth={2} /> Meeting</button>
              <button
                onClick={() => handleTabChange('discount')}
                className="flex items-center gap-1.5 text-stone-600 px-3 py-1.5 rounded-xl text-xs hover:bg-stone-50 transition-colors font-medium"
                style={{ border: '1px solid #EDE8E3' }}
              ><Tag size={13} strokeWidth={2} /> Discount</button>
              <button
                onClick={() => handleTabChange('whatsapp')}
                className="flex items-center gap-1.5 bg-green-500 text-white px-3 py-1.5 rounded-xl text-xs font-semibold hover:bg-green-600 transition-colors"
              ><MessageCircle size={13} strokeWidth={2} /> WhatsApp</button>
              {lead.status === 'ACTIVE' && (
                <>
                  <button
                    onClick={() => openStatusModal('ON_HOLD')}
                    className="flex items-center gap-1.5 text-stone-600 px-3 py-1.5 rounded-xl text-xs hover:bg-stone-50 transition-colors font-medium"
                    style={{ border: '1px solid #EDE8E3' }}
                  >On Hold</button>
                  <button
                    onClick={() => openStatusModal('INACTIVE')}
                    className="flex items-center gap-1.5 text-stone-600 px-3 py-1.5 rounded-xl text-xs hover:bg-stone-50 transition-colors font-medium"
                    style={{ border: '1px solid #EDE8E3' }}
                  >Mark Inactive</button>
                </>
              )}
              {lead.status === 'ON_HOLD' && (
                <button
                  onClick={() => openStatusModal('INACTIVE')}
                  className="flex items-center gap-1.5 text-stone-600 px-3 py-1.5 rounded-xl text-xs hover:bg-stone-50 transition-colors font-medium"
                  style={{ border: '1px solid #EDE8E3' }}
                >Mark Inactive</button>
              )}
              {(lead.status === 'ON_HOLD' || lead.status === 'INACTIVE') && (
                <button
                  onClick={openReactivateModal}
                  className="flex items-center gap-1.5 bg-brand-500 text-white px-3 py-1.5 rounded-xl text-xs font-semibold hover:bg-brand-600 transition-colors"
                ><RefreshCw size={13} strokeWidth={2} /> Reactivate</button>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-stone-500">Lead not found</p>
        )}
        {/* Task #88 — On Hold / Inactive reason + reopen date banner, keyed off status */}
        {lead && lead.status === 'ON_HOLD' && (
          <div className="mt-2 flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-1.5 flex-wrap">
            <span className="font-semibold">On Hold</span>
            {lead.onHoldReason && <span>· Reason: {lead.onHoldReason}</span>}
            {lead.onHoldRevivalDate && <span>· Reopens: {fmtDate(lead.onHoldRevivalDate)}</span>}
          </div>
        )}
        {lead && lead.status === 'INACTIVE' && lead.inactiveReason && (
          <div className="mt-2 flex items-center gap-2 text-xs bg-stone-100 border border-stone-200 text-stone-600 rounded-lg px-3 py-1.5 flex-wrap">
            <span className="font-semibold">Inactive</span>
            <span>· Reason: {lead.inactiveReason}</span>
            {lead.inactiveNotes && <span>· Notes: {lead.inactiveNotes}</span>}
          </div>
        )}
      </div>

      {/* PD→OB checklist for PROPOSAL_DISCUSSION (and later, as a record).
          PROPOSAL_PRESENTED is included so it's reachable/completable while a
          lead is still in PP, ahead of a PP→OB skip — the checklist itself
          stays mandatory for that skip, it's just started earlier. */}
      {lead && ['PROPOSAL_PRESENTED', 'PROPOSAL_DISCUSSION', 'ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'].includes(lead.stage) && (
        <div className="px-6 pt-4">
          <PDOBChecklistPanel
            leadId={leadId!}
            stage={lead.stage}
            clientEmail={lead.email ?? null}
            onComplete={loadLead}
            isLocked={isLocked}
            refreshKey={checklistRefreshKey}
          />
        </div>
      )}

      {/* OB→OBM checklist for ONBOARDING (and later, as a record) */}
      {lead && ['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER'].includes(lead.stage) && (
        <div className="px-6 pt-4">
          <OBOBMChecklistPanel key={leadId} leadId={leadId!} stage={lead.stage} clientEmail={lead.email ?? null} onComplete={loadLead} isLocked={isLocked} refreshKey={checklistRefreshKey} />
        </div>
      )}

      {/* DIP Checklist for ONBOARDING_MEETING / DESIGN_IN_PROGRESS / HANDED_OVER (legacy) */}
      {lead && (lead.stage === 'ONBOARDING_MEETING' || lead.stage === 'DESIGN_IN_PROGRESS' || lead.stage === 'HANDED_OVER') && (
        <div className="px-6 pt-4">
          <DIPChecklistPanel leadId={leadId!} stage={lead.stage} isLocked={isLocked} />
        </div>
      )}

      {/* ── Overdue task gate banner ──────────────────────────────────────────── */}
      {hasOverdueTasks && (
        <div className="mx-6 mb-2 bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={16} className="text-red-600 mt-0.5 shrink-0" />
          <div className="text-sm text-red-700 flex-1">
            <p className="font-semibold">Overdue task — resolve before advancing this lead</p>
            <p className="mt-0.5">
              {leadFollowUpTasks.filter((t) => t.isOverdue && t.status === 'PENDING').length} overdue task(s) need to be rescheduled or marked not done.{' '}
              <button onClick={() => handleTabChange('activity')} className="underline font-medium">Go to Activity tab →</button>
            </p>
          </div>
        </div>
      )}

      {/* ── Main content: tabs (left 2/3) + sidebar (right 1/3) ─────────────── */}
      <div className="px-6 py-4 flex gap-6 items-start">
        {/* Main col */}
        <div className="flex-1 min-w-0 space-y-0">
          {/* Tab nav */}
          <div className="bg-white rounded-t-2xl" style={{ border: '1px solid #EDE8E3', borderBottom: 'none' }}>
            <nav className="flex gap-0 overflow-x-auto scrollbar-hide">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id)}
                  className={`px-4 py-3 text-xs font-semibold border-b-2 whitespace-nowrap transition-colors ${
                    activeTab === tab.id
                      ? 'border-brand-500 text-brand-600'
                      : 'border-transparent text-stone-500 hover:text-stone-700'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          {/* Tab content */}
          <div className="bg-white rounded-b-2xl p-5" style={{ border: '1px solid #EDE8E3' }}>
            {activeTab === 'overview' && lead && (
              <div className="space-y-6">
                {/* ── Attention flags ───────────────────────────────────────── */}
                {lead.attentionFlags && lead.attentionFlags.length > 0 && (
                  <div className="space-y-2">
                    {lead.attentionFlags.map((f) => (
                      <div key={f.id} className="flex items-start justify-between gap-3 bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
                        <div className="flex items-start gap-2 min-w-0">
                          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-600" strokeWidth={2.5} />
                          <div className="min-w-0">
                            <span className="text-xs font-bold text-red-700">{f.category}</span>
                            <p className="text-xs text-red-600 mt-0.5">{f.description}</p>
                          </div>
                        </div>
                        <button
                          onClick={() => handleResolveFlag(f.id)}
                          disabled={resolvingFlagId === f.id}
                          className="text-xs font-semibold text-red-700 hover:text-red-900 shrink-0 disabled:opacity-50"
                        >
                          {resolvingFlagId === f.id ? 'Resolving…' : 'Resolve'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {/* ── Stage Roadmap ─────────────────────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-800">Stage Roadmap</h3>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-gray-400">Lead Origin Date: {fmtDateTime(lead.leadOriginDate)}</span>
                      <span className="text-[10px] text-gray-400">Allocated {fmtDateTime(lead.createdAt)}</span>
                    </div>
                  </div>
                  <div className="relative overflow-x-auto pb-2">
                    <div className="flex items-start gap-0 min-w-max">
                      {visibleFunnelStages.map((stage, idx) => {
                        // Find all visits to this stage
                        const visits = stageHistory.filter((v) => v.stage === stage);
                        const isCurrent = lead.stage === stage;
                        const wasVisited = visits.length > 0;
                        const visit = visits[visits.length - 1]; // most recent visit
                        const isGateInfoOpen = gateInfoStage === stage;
                        const nextStage = FUNNEL_STAGES[idx + 1];
                        const hasGate = !!nextStage; // every stage but the last has an outgoing transition to check

                        // Task #32: colour completed-stage TAT against the admin-configured
                        // benchmark — purple if finished early, green/amber/red if it ran
                        // within/near/over the benchmark. Only applies to stages the lead
                        // has already exited (visit.exitedAt set); the current, still-open
                        // stage keeps its existing brand styling + SLA dot above.
                        let tatColorClasses: string | null = null;
                        if (wasVisited && !isCurrent && visit?.exitedAt && visit.tatDays !== undefined && visit.benchmark) {
                          const { warningDays, breachDays } = visit.benchmark;
                          if (visit.tatDays < warningDays * 0.7) tatColorClasses = 'bg-purple-50 border-purple-300 text-purple-700'; // finished well ahead of benchmark
                          else if (visit.tatDays < warningDays) tatColorClasses = 'bg-green-50 border-green-300 text-green-700'; // on track
                          else if (visit.tatDays <= breachDays) tatColorClasses = 'bg-amber-50 border-amber-300 text-amber-700'; // near/at benchmark
                          else tatColorClasses = 'bg-red-50 border-red-300 text-red-700'; // over benchmark
                        }

                        return (
                          <div key={stage} className="flex items-center">
                            {idx > 0 && (
                              <div className={`h-0.5 w-8 ${wasVisited || isCurrent ? 'bg-brand-300' : 'bg-gray-100'}`} />
                            )}
                            <div className="relative flex flex-col items-center">
                              {/* Node */}
                              <button
                                onClick={canChangeStage ? openStageModal : undefined}
                                disabled={!canChangeStage}
                                title={
                                  canChangeStage && isCurrent && lead.slaStatus && lead.slaStatus !== 'ok'
                                    ? `${lead.slaStatus === 'breach' ? 'SLA breached' : 'SLA approaching'} — ${lead.daysInCurrentStage}d in stage`
                                    : stageChangeTitle
                                }
                                className={`relative w-14 h-14 rounded-full flex flex-col items-center justify-center text-center transition-all border-2 ${
                                  !canChangeStage
                                    ? 'opacity-60 cursor-not-allowed'
                                    : ''
                                } ${
                                  isCurrent
                                    ? 'bg-brand-500 border-brand-600 text-white shadow-md'
                                    : tatColorClasses
                                    ? tatColorClasses
                                    : wasVisited
                                    ? 'bg-brand-50 border-brand-200 text-brand-700'
                                    : 'bg-gray-50 border-gray-100 text-gray-300'
                                }`}
                              >
                                {isCurrent && lead.slaStatus && lead.slaStatus !== 'ok' && (
                                  <span
                                    className={`absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white ${
                                      lead.slaStatus === 'breach' ? 'bg-red-500' : 'bg-orange-400'
                                    }`}
                                    aria-label={lead.slaStatus === 'breach' ? 'SLA breached' : 'SLA approaching'}
                                  />
                                )}
                                <span className="text-[10px] font-bold leading-none">{stageShortLabel(stage, FUNNEL_ABBREV[stage])}</span>
                                {wasVisited && visit?.tatDays !== undefined && (
                                  <span className="text-[8px] leading-tight mt-0.5 opacity-80">{visit.tatDays}d</span>
                                )}
                              </button>

                              {/* Entry date — w-20 + whitespace-nowrap so a
                                  4-digit-year date ("21 Aug 2026") never
                                  wraps/clips inside the narrow w-16 box. */}
                              {(wasVisited || isCurrent) && visit?.enteredAt && (
                                <span className="text-[9px] text-gray-400 mt-1 text-center w-20 leading-tight whitespace-nowrap">
                                  {fmtDate(visit.enteredAt)}
                                </span>
                              )}

                              {/* Skipped badge — shown when a stage was legally bypassed */}
                              {!wasVisited && !isCurrent && !!(
                                (stage === 'DQL' && lead.skippedDQL) ||
                                (stage === 'PROPOSAL_READY' && lead.skippedProposalReady) ||
                                (stage === 'PROPOSAL_DISCUSSION' && lead.skippedProposalDiscussion)
                              ) && (
                                <span className="text-[8px] font-semibold text-stone-400 mt-0.5 px-1.5 py-0.5 rounded-full bg-stone-100 border border-stone-200 whitespace-nowrap">
                                  Skipped
                                </span>
                              )}

                              {/* PP meeting badges — shown under the PP node, one badge per meeting */}
                              {stage === 'PROPOSAL_PRESENTED' && lead.ppMeetings && lead.ppMeetings.length > 0 && (
                                <div className="flex flex-col items-center gap-0.5 mt-1">
                                  {lead.ppMeetings.map((m) => (
                                    <div key={m.id} className="flex flex-col items-center">
                                      <span className={`text-[8px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap ${
                                        m.status === 'COMPLETED' ? 'bg-green-50 text-green-700 border border-green-200' :
                                        m.status === 'NO_SHOW' ? 'bg-red-50 text-red-600 border border-red-200' :
                                        'bg-brand-50 text-brand-700 border border-brand-200'
                                      }`}>
                                        {m.ppNumber ? `PP${m.ppNumber}` : 'PP'} · {fmtDate(m.scheduledAt)}
                                      </span>
                                      {m.momAgenda && (
                                        <p className="text-[8px] text-stone-400 max-w-[72px] truncate mt-0.5 text-center" title={m.momAgenda}>
                                          {m.momAgenda}
                                        </p>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}

                              {/* Gate info button + popover — labels & satisfied state come straight from the
                                  server's /can-advance check (the same authoritative logic used to actually
                                  block the move), never a separately-maintained client-side copy. */}
                              {hasGate && (
                                <div className="relative mt-0.5">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (isGateInfoOpen) {
                                        setGateInfoStage(null);
                                        setGateInfoPos(null);
                                      } else {
                                        // Position the popover from the button's live viewport rect (not the
                                        // scrolling roadmap strip's coordinate space) so it can be portalled
                                        // out to <body> and is never clipped by the strip's overflow-x-auto.
                                        // Flip below the button if there isn't ~180px of room above it.
                                        const rect = e.currentTarget.getBoundingClientRect();
                                        const openUpward = rect.top > 200;
                                        setGateInfoPos({
                                          left: rect.left + rect.width / 2,
                                          top: openUpward ? rect.top - 6 : rect.bottom + 6,
                                          openUpward,
                                        });
                                        setGateInfoStage(stage);
                                        if (lead && nextStage) {
                                          setGateDetailsLoading(true);
                                          api.get<{ details: { label: string; satisfied: boolean }[] }>(
                                            `/leads/${lead.id}/can-advance?fromStage=${stage}&toStage=${nextStage}`,
                                          )
                                            .then((res) => setGateDetails((prev) => ({ ...prev, [stage]: res.details ?? [] })))
                                            .catch(() => setGateDetails((prev) => { const { [stage]: _drop, ...rest } = prev; return rest; }))
                                            .finally(() => setGateDetailsLoading(false));
                                        }
                                      }
                                    }}
                                    className="text-gray-300 hover:text-brand-400 transition-colors"
                                    title="Gate requirements"
                                  >
                                    <Info size={10} strokeWidth={2} />
                                  </button>
                                  {isGateInfoOpen && gateInfoPos && createPortal(
                                    <div
                                      className="fixed bg-white rounded-xl shadow-lg border border-gray-100 p-2.5 z-[100] w-56 max-h-72 overflow-y-auto text-left"
                                      style={{
                                        left: gateInfoPos.left,
                                        top: gateInfoPos.top,
                                        transform: `translate(-50%, ${gateInfoPos.openUpward ? '-100%' : '0'})`,
                                      }}
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mb-1.5">
                                        Gate to {stageShortLabel(nextStage ?? stage, FUNNEL_ABBREV[nextStage ?? stage])}
                                      </p>
                                      {gateDetailsLoading && !gateDetails[stage] ? (
                                        <p className="text-[9px] text-gray-400">Checking…</p>
                                      ) : gateDetails[stage] && gateDetails[stage].length === 0 ? (
                                        <p className="text-[9px] text-gray-400">No requirements to advance</p>
                                      ) : (
                                        (gateDetails[stage] ?? []).map((d, gi) => (
                                          <div key={gi} className="flex items-start gap-1 mb-0.5">
                                            <span className={`mt-px shrink-0 ${d.satisfied ? 'text-green-500' : 'text-red-500'}`}>
                                              {d.satisfied ? <Check size={8} strokeWidth={3} /> : <X size={8} strokeWidth={3} />}
                                            </span>
                                            <span className={`text-[9px] leading-tight ${d.satisfied ? 'text-gray-600' : 'text-red-600 font-medium'}`}>{d.label}</span>
                                          </div>
                                        ))
                                      )}
                                    </div>,
                                    document.body,
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {/* Close popover on outside click */}
                  {gateInfoStage && (
                    <div className="fixed inset-0 z-10" onClick={() => { setGateInfoStage(null); setGateInfoPos(null); }} />
                  )}
                </div>

                {/* ── Stage Timeline Table ─────────────────────────────────── */}
                {stageHistory.length > 0 && (
                  <div className="mb-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-gray-800">Stage Timeline</h3>
                      {lead.estimatedValue && (
                        <span className="text-xs text-stone-400">
                          Budget: <span className="font-semibold text-stone-600">{fmtVal(lead.estimatedValue)}</span>
                        </span>
                      )}
                    </div>
                    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid #EDE8E3' }}>
                      <div className="overflow-x-auto">
                      <table className="w-full min-w-[780px] text-xs">
                        <thead>
                          <tr style={{ background: '#FAF6F2', borderBottom: '1px solid #EDE8E3' }}>
                            <th className="text-left py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Stage</th>
                            <th className="text-left py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Entered</th>
                            <th className="text-center py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Days</th>
                          <th className="text-center py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Budget</th>
                          <th className="text-center py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Intent</th>
                          <th className="text-center py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Project Value/Costing</th>
                            <th className="text-center py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Target</th>
                            <th className="text-center py-2 px-3 font-semibold text-stone-500 uppercase tracking-wide text-[10px]">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ...visibleStageHistory.map((visit) => ({ stage: visit.stage, visit })),
                            ...visibleFunnelStages
                              .filter((stage) => !visibleStageHistory.some((visit) => visit.stage === stage))
                              .map((stage) => ({ stage, visit: undefined })),
                          ].map(({ stage, visit }, idx, rows) => {
                            const isCurrent = visit === stageHistory[stageHistory.length - 1] && lead.stage === stage;
                            const isFuture = !visit;
                            const wb = visit?.benchmark ?? null;
                            const commercialContext = visit?.commercialContext;

                            let statusCell: React.ReactNode = <span className="text-stone-200">—</span>;
                            if (visit && visit.tatDays !== undefined) {
                              const tat = visit.tatDays;
                              if (isCurrent) {
                                statusCell = <span className="text-blue-400 text-[10px] font-medium italic">Now</span>;
                              } else if (!wb) {
                                statusCell = <span className="text-stone-300 text-[10px]">—</span>;
                              } else if (tat < wb.warningDays * 0.7) {
                                statusCell = <span className="text-purple-600 font-bold text-[10px]">▲ Ahead</span>;
                              } else if (tat < wb.warningDays) {
                                statusCell = <span className="text-green-600 font-bold text-[10px]">● On track</span>;
                              } else if (tat <= wb.breachDays) {
                                statusCell = <span className="text-amber-600 font-bold text-[10px]">● Near limit</span>;
                              } else {
                                statusCell = <span className="text-red-600 font-bold text-[10px]">● Exceeded</span>;
                              }
                            }

                            return (
                              <tr
                                key={`${stage}-${visit?.enteredAt ?? 'future'}`}
                                style={{
                                  borderBottom: idx < rows.length - 1 ? '1px solid #F5F0EB' : undefined,
                                  background: isCurrent ? '#FDFAF7' : isFuture ? '#FCFCFC' : undefined,
                                  opacity: isFuture ? 0.4 : 1,
                                }}
                              >
                                <td className="py-2 px-3">
                                  <span className={`font-semibold ${isCurrent ? 'text-brand-600' : isFuture ? 'text-stone-400' : 'text-stone-700'}`}>
                                    {stageLabel(stage)}
                                  </span>
                                  {isCurrent && (
                                    <span className="ml-1 text-[8px] font-bold text-brand-400 uppercase tracking-wide">current</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-stone-500">{visit ? fmtDate(visit.enteredAt) : '—'}</td>
                                <td className="py-2 px-3 text-center tabular-nums">
                                  {visit?.tatDays != null ? (
                                    <span className={isCurrent ? 'text-stone-500' : 'text-stone-800 font-semibold'}>{visit.tatDays}d</span>
                                  ) : (
                                    <span className="text-stone-300">—</span>
                                  )}
                                </td>
                                <td className="py-2 px-3 text-center text-stone-600 font-semibold whitespace-nowrap">{fmtVal(commercialContext?.budget)}</td>
                                <td className="py-2 px-3 text-center text-amber-500 font-semibold whitespace-nowrap">
                                  {commercialContext?.intent != null ? `${commercialContext.intent}★` : <span className="text-stone-300">—</span>}
                                </td>
                                <td className="py-2 px-3 text-center text-stone-600 font-semibold whitespace-nowrap">{fmtVal(commercialContext?.projectValue)}</td>
                                <td className="py-2 px-3 text-center text-stone-400 tabular-nums">
                                  {wb ? `${wb.warningDays}d` : '—'}
                                </td>
                                <td className="py-2 px-3 text-center">{statusCell}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Follow-up Tasks ───────────────────────────────────────── */}
                {leadFollowUpTasks.filter((t) => !t.isCompleted).length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-semibold text-gray-800">Follow-up Tasks</h3>
                      <button onClick={() => handleTabChange('activity')} className="text-xs text-brand-500 hover:underline">View all →</button>
                    </div>
                    <div className="space-y-1.5">
                      {leadFollowUpTasks.filter((t) => !t.isCompleted).map((t) => {
                        const color = t.isOverdue
                          ? 'bg-red-50 border-red-200 text-red-700'
                          : 'bg-green-50 border-green-200 text-green-700';
                        const label = t.isOverdue ? 'Overdue' : 'Upcoming';
                        const dueStr = fmtDate(t.dueDate) + (t.dueTime ? ` ${t.dueTime}` : '');
                        return (
                          <div key={t.id} className={`flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs ${color}`}>
                            <span className="font-medium">{label}</span>
                            <span className="opacity-80">{dueStr}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── Client Details ────────────────────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-800">Client Details</h3>
                    {!isLocked && (
                      <button
                        onClick={openEditDetails}
                        className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 font-medium"
                      >
                        <Pencil size={11} strokeWidth={2} /> Edit
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-8">
                    <FactRow label="Full Name" value={lead.name} />
                    <FactRow label="Phone" value={lead.phone} />
                    <FactRow label="Alternate Phone" value={lead.phone2} />
                    <FactRow label="Email" value={lead.email
                      ? <a href={`mailto:${lead.email}`} className="text-brand-500 hover:underline">{lead.email}</a>
                      : undefined} />
                    <FactRow label="Alternate Email" value={lead.email2
                      ? <a href={`mailto:${lead.email2}`} className="text-brand-500 hover:underline">{lead.email2}</a>
                      : undefined} />
                    <FactRow label="PAN" value={lead.pan} />
                    <FactRow label="GST" value={lead.gst} />
                  </div>
                </div>

                {/* ── Project Details ───────────────────────────────────────── */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-gray-800">Project Details</h3>
                    {!isLocked && (
                      <button
                        onClick={openEditDetails}
                        className="flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 font-medium"
                      >
                        <Pencil size={11} strokeWidth={2} /> Edit
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-8">
                    <FactRow label="Project Type" value={lead.projectType} />
                    <FactRow label="Scope of Work" value={lead.scope} />
                    <FactRow label="Location" value={lead.location} />
                    <FactRow label="Builder" value={lead.builder} />
                    <FactRow label="Client Budget" value={fmtVal(lead.estimatedValue)} />
                    <FactRow label="Expected Interior Handover Date" value={lead.expectedMoveIn
                      ? formatISTDate(lead.expectedMoveIn, { year: 'numeric' })
                      : undefined} />
                    <FactRow label="Expected OB Date" value={lead.expectedObDate
                      ? formatISTDate(lead.expectedObDate, { year: 'numeric' })
                      : undefined} />
                    <FactRow label="Possession" value={formatPossession(lead.possessionTimeline)} />
                    <FactRow label="Source" value={lead.source ? sourceLabel(lead.source) : undefined} />
                  </div>

                  {/* Offers */}
                  {(lead.currentOffer?.name || lead.offer1) && (
                    <div className="mt-2 space-y-0.5">
                      <FactRow label="Offer proposed" value={lead.currentOffer?.name ?? lead.offer1} />
                    </div>
                  )}

                  {/* Floor plan */}
                  <div className="mt-3 flex items-center gap-3 py-1.5 border-b border-gray-50">
                    <span className="text-xs text-gray-400 w-32 shrink-0">Floor Plan</span>
                    <div className="flex items-center gap-2">
                      {lead.floorPlanUrl ? (
                        <a
                          href={lead.floorPlanUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 font-medium"
                        >
                          <ExternalLink size={11} strokeWidth={2} /> View file
                        </a>
                      ) : (
                        <>
                          <span className="text-xs text-gray-300">No file uploaded</span>
                          {!isLocked && (
                            <button
                              onClick={() => floorPlanInputRef.current?.click()}
                              disabled={uploadingFloorPlan}
                              className="inline-flex items-center gap-1 text-xs text-stone-500 hover:text-stone-700 px-2 py-0.5 rounded-lg transition-colors disabled:opacity-50"
                              style={{ border: '1px solid #EDE8E3' }}
                            >
                              <Upload size={10} strokeWidth={2} />
                              {uploadingFloorPlan ? 'Uploading…' : 'Upload'}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {/* Notes */}
                  {lead.notes && (
                    <div className="mt-2 py-2 border-b border-gray-50">
                      <span className="text-xs text-gray-400 block mb-1">Notes</span>
                      <p className="text-xs text-gray-700 whitespace-pre-wrap">{lead.notes}</p>
                    </div>
                  )}

                  {/* Latest Quote */}
                  {latestQuote && (
                    <div className="mt-3 flex items-center gap-2 py-1.5 border-b border-gray-50">
                      <span className="text-xs text-gray-400 w-32 shrink-0">Latest Quote</span>
                      <button
                        onClick={() => handleTabChange('quotes')}
                        className="inline-flex items-center gap-1 text-xs text-brand-500 hover:text-brand-600 font-medium"
                      >
                        <ExternalLink size={11} strokeWidth={2} />
                        {latestQuote.quoteNumber ?? `#${latestQuote.id.slice(-6)}`}
                        {latestQuote.totalAmount !== null && latestQuote.totalAmount !== undefined
                          ? ` — ${fmtVal(latestQuote.totalAmount)}`
                          : ''}
                        <span className="ml-1 text-gray-400 font-normal">({latestQuote.status ?? 'Draft'})</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'activity' && lead && (
              <div id="lead-activity-panel">
                <ActivityFeedTab
                  leadId={leadId!}
                  clientEmail={lead.email ?? null}
                  isLocked={isLocked}
                  breakdown={lead._breakdown ?? null}
                  onCallLogged={() => {
                    loadLead();
                    loadFollowUpTasks();
                  }}
                  onMeetingCreated={loadLead}
                  onMeetingCompleted={handleMeetingCompleted}
                  onTasksChanged={() => {
                    loadLead();
                    loadFollowUpTasks();
                  }}
                />
              </div>
            )}

            {activeTab === 'audit' && (() => {
              // A timeline must be chronologically true across every activity
              // type. Grouping by category made an older call appear above a
              // newer meeting or checklist update.
              const timeline = [...activities].sort((x, y) => {
                const timeDiff = new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime();
                return timeDiff || y.id.localeCompare(x.id);
              });
              return (
                <div className="space-y-5">
                  <ChatTab leadId={leadId!} onMessagesRead={() => setUnreadChatCount(0)} />
                  <h3 className="text-sm font-semibold text-gray-700">Full Activity Log</h3>
                  {activities.length === 0 ? (
                    <p className="text-xs text-gray-400 py-8 text-center">No activity yet</p>
                  ) : (
                    <div className="space-y-0">
                      {timeline.map((a) => {
                          const isBackward = a.action === 'STAGE_CHANGED' && a.meta?.isBackward;
                          const direction = a.action === 'INTENT_RATING_UPDATED' ? a.meta?.direction : null;
                          const rowColor = isBackward
                            ? 'bg-red-50 border-red-100'
                            : direction === 'increase'
                            ? 'bg-green-50 border-green-100'
                            : direction === 'decrease'
                            ? 'bg-red-50 border-red-100'
                            : '';
                        return (
                          <div key={a.id} className={`flex items-start gap-3 py-2.5 border-b last:border-0 rounded-lg px-1 ${rowColor || 'border-gray-50'}`}>
                            <span className="text-base mt-0.5 shrink-0">
                              {isBackward ? '↩' : direction === 'increase' ? '▲' : direction === 'decrease' ? '▼' : (ACTION_ICONS[a.action] ?? '•')}
                            </span>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-gray-700">
                                <span className="font-medium">{a.user?.name ?? 'System'}</span>
                                {' — '}
                                {describeActivity(a.action, a.meta)}
                              </p>
                            </div>
                            <span className="text-xs text-gray-300 shrink-0">{relTime(a.createdAt)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {activeTab === 'whatsapp' && <WhatsAppTab leadId={leadId!} isLocked={isLocked} breakdown={lead?._breakdown?.whatsapp ?? null} />}
            {activeTab === 'quotes' && lead && (
              <QuoteTab
                leadId={leadId!}
                leadRef={lead.leadId}
                pid={lead.project?.projectCode}
                name={lead.name}
                phone={lead.phone}
                email={lead.email}
                projectType={lead.projectType}
                scope={lead.scope}
                location={lead.location}
                estimatedValue={lead.estimatedValue}
                isLocked={isLocked}
              />
            )}
            {activeTab === 'discount' && <DiscountTab leadId={leadId!} isLocked={isLocked} />}
            {activeTab === 'files' && lead && (
              <FilesTab
                leadId={leadId!}
                currentStage={lead.stage}
                floorPlanUrl={lead.floorPlanUrl}
                isLocked={isLocked}
                onFilesChanged={handleFilesChanged}
              />
            )}
            {/* Fix 1: render TeamTab for all leads, with optional projectId.
                When no project exists yet (pre-DIP), TeamTab shows a pre-project
                request UI that lazy-creates the project on first submission. */}
            {activeTab === 'team' && lead && (
              <TeamTab
                projectId={lead.project?.id ?? null}
                leadId={leadId!}
                leadDisplayId={lead.leadId}
                isLocked={isLocked}
              />
            )}
          </div>
        </div>

        {/* ── Sidebar col ─────────────────────────────────────────────────────── */}
        <div className="w-72 shrink-0 space-y-3">
          {/* Assignment */}
          <SidebarCard title="Assignment">
            {lead ? (
              <div className="space-y-3">
                {/* Designer */}
                <div>
                  <p className="text-xs text-gray-400 mb-1">Designer</p>
                  {reassignField === 'designer' ? (
                    <div className="flex gap-1">
                      <select value={reassignValue} onChange={(e) => setReassignValue(e.target.value)}
                        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400">
                        <option value="">Select</option>
                        {designerUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      <button onClick={handleReassign} disabled={savingReassign || !reassignValue}
                        className="bg-brand-500 text-white px-2 py-1 rounded text-xs disabled:opacity-50">✓</button>
                      <button onClick={() => setReassignField(null)} className="text-gray-400 px-1 text-xs">✕</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <AvatarChip name={lead.assignedDesigner?.name} />
                      {!(getStoredUser()?.role === 'BL' && !can('LEAD_ASSIGN_DIRECT')) && (
                        <button onClick={() => { setReassignField('designer'); setReassignValue(lead.assignedDesignerId ?? ''); }}
                          className="text-xs text-brand-500 hover:underline">Change</button>
                      )}
                    </div>
                  )}
                </div>
                {/* BL */}
                <div>
                  <p className="text-xs text-gray-400 mb-1">Business Lead</p>
                  {reassignField === 'bl' ? (
                    <div className="flex gap-1">
                      <select value={reassignValue} onChange={(e) => setReassignValue(e.target.value)}
                        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400">
                        <option value="">Select</option>
                        {blUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                      <button onClick={handleReassign} disabled={savingReassign || !reassignValue}
                        className="bg-brand-500 text-white px-2 py-1 rounded text-xs disabled:opacity-50">✓</button>
                      <button onClick={() => setReassignField(null)} className="text-gray-400 px-1 text-xs">✕</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <AvatarChip name={lead.assignedBL?.name} />
                      <button onClick={() => { setReassignField('bl'); setReassignValue(lead.assignedBLId ?? ''); }}
                        className="text-xs text-brand-500 hover:underline">Change</button>
                    </div>
                  )}
                </div>

                {/* CRE module Stage 2 — BL pushback form: shown to the assigned BL
                    at MQL so they can return the lead for re-qualification if needed */}
                {currentUser?.role === 'BL' && can('LEAD_PUSHBACK_MQL') && lead.stage === 'MQL' && lead.assignedBLId === currentUser?.id && (
                  <div className="mt-3 pt-2.5 border-t border-gray-100">
                    {!showPushbackForm ? (
                      <button
                        onClick={() => setShowPushbackForm(true)}
                        className="text-xs text-rose-500 hover:text-rose-700 font-medium flex items-center gap-1"
                      >
                        ↩ Return for re-qualification
                      </button>
                    ) : (
                      <div className="space-y-1.5">
                        <p className="text-xs text-gray-500 font-medium">Pushback reason (required)</p>
                        <textarea
                          value={pushbackReason}
                          onChange={(e) => setPushbackReason(e.target.value)}
                          rows={2}
                          placeholder="e.g. Client not ready, budget mismatch, needs more follow-up…"
                          className="w-full border border-gray-200 rounded px-2 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-rose-400"
                        />
                        <div className="flex gap-1.5">
                          <button
                            onClick={handlePushbackMQL}
                            disabled={!pushbackReason.trim() || pushingBack}
                            className="bg-rose-500 text-white px-2.5 py-1 rounded text-xs font-medium disabled:opacity-50"
                          >
                            {pushingBack ? '…' : 'Confirm Return'}
                          </button>
                          <button
                            onClick={() => { setShowPushbackForm(false); setPushbackReason(''); }}
                            className="text-gray-400 text-xs px-2 py-1 hover:text-gray-600"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* CRE module Stage 2 — pushback banner: shown whenever this lead
                    has been returned by a BL for re-qualification */}
                {lead.mqlPushbackReason && (
                  <div className="mt-2 flex items-start gap-1.5 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-2.5 py-2 text-xs">
                    <span className="shrink-0 text-sm">↩️</span>
                    <div>
                      <p className="font-semibold leading-tight">Re-qualification required</p>
                      <p className="text-amber-700 mt-0.5 italic">"{lead.mqlPushbackReason}"</p>
                      {lead.mqlPushbackAt && (
                        <p className="text-amber-500 mt-0.5 text-[10px]">{fmtDate(lead.mqlPushbackAt)}</p>
                      )}
                    </div>
                  </div>
                )}

                {/* CRE module Stage 2 — allocate-BL panel: visible to CRE when
                    lead is at MQL and no BL has been assigned yet */}
                {currentUser?.role === 'CRE' && can('LEAD_ALLOCATE_BL') && lead.stage === 'MQL' && !lead.assignedBLId && (
                  <div className="mt-3 pt-2.5 border-t border-gray-100">
                    <p className="text-xs text-gray-500 mb-1.5 font-medium">Allocate to Business Lead</p>
                    <div className="flex gap-1.5">
                      <select
                        value={selectedBLId}
                        onChange={(e) => setSelectedBLId(e.target.value)}
                        className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-brand-400"
                      >
                        <option value="">Select BL…</option>
                        {creBLList.map((bl) => (
                          <option key={bl.id} value={bl.id}>{bl.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleAllocateBL}
                        disabled={!selectedBLId || allocatingBL}
                        className="bg-brand-500 text-white px-2.5 py-1 rounded text-xs font-medium disabled:opacity-50 whitespace-nowrap"
                      >
                        {allocatingBL ? '…' : 'Allocate'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : <div className="h-12 bg-gray-50 rounded animate-pulse" />}
          </SidebarCard>

          {/* Intent Rating */}
          <SidebarCard title="Intent Rating">
            {lead ? (
              <>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5">
                    {Array.from({ length: 5 }, (_, i) => (
                      <span key={i} className={`text-sm ${i < (lead.intentRating ?? 0) ? 'text-amber-400' : 'text-gray-200'}`}>★</span>
                    ))}
                  </div>
                  {!isLocked && (
                    <button onClick={() => openIntentModal(lead.intentRating ?? 0)}
                      className="text-xs text-brand-500 hover:underline font-medium">Override</button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-1">
                  {lead.intentRatingSource === 'auto' && (
                    <span className="text-[9px] font-bold bg-sky-100 text-sky-600 px-1.5 py-0.5 rounded-full">AUTO — from meeting type</span>
                  )}
                  {lead.intentRatingSource === 'manual' && (
                    <span className="text-[9px] font-bold bg-purple-100 text-purple-600 px-1.5 py-0.5 rounded-full">MANUAL override</span>
                  )}
                  {!lead.intentRatingSource && (
                    <span className="text-[9px] text-gray-400">No rating yet</span>
                  )}
                </div>
                {lead.intentRating === 1 && (
                  <div className="mt-2 flex items-start gap-1.5 bg-red-50 border border-red-200 text-red-600 rounded-lg px-2.5 py-1.5 text-xs">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" strokeWidth={2.5} />
                    <span>{lenient ? 'Low intent. You can still advance; it will be logged for review.' : 'Stage advance blocked. Update intent to proceed.'}</span>
                  </div>
                )}
              </>
            ) : <div className="h-10 bg-gray-50 rounded animate-pulse" />}
          </SidebarCard>

          {/* Source & campaign */}
          <SidebarCard title="Source & Campaign">
            {lead ? (
              <>
                <InfoRow label="Source" value={lead.source ? sourceLabel(lead.source) : undefined} />
                <InfoRow label="Ad/Campaign" value={lead.adName} />
                <InfoRow label="UTM Campaign" value={lead.utmCampaign} />
                <InfoRow label="UTM AdSet" value={lead.utmAdSet} />
                <InfoRow label="UTM Source" value={lead.utmSource} />
                <InfoRow label="Created" value={formatISTDate(lead.createdAt, { year: 'numeric' })} />
                {lead.currentOffer && (
                  <div className="mt-2">
                    <span className="inline-flex items-center gap-1 text-xs bg-brand-100 text-brand-700 px-2 py-0.5 rounded-full font-medium">
                      <Gift size={10} strokeWidth={2} /> {lead.currentOffer.name}
                    </span>
                  </div>
                )}
              </>
            ) : <div className="h-24 bg-gray-50 rounded animate-pulse" />}
          </SidebarCard>

          {/* Quote */}
          <SidebarCard title="Latest Quote">
            {latestQuoteAttachment ? (
              <>
                <InfoRow label="File" value={latestQuoteAttachment.fileName} />
                <InfoRow label="Type" value={latestQuoteAttachment.fileType.replace(/_/g, ' ')} />
                <InfoRow label="Attached" value={formatISTDate(latestQuoteAttachment.createdAt)} />
                {latestQuoteAttachment.signedUrl ? (
                  <a
                    href={latestQuoteAttachment.signedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1 text-xs text-brand-500 hover:underline"
                  >
                    <ExternalLink size={12} /> View attached quote
                  </a>
                ) : (
                  <button onClick={() => handleTabChange('files')}
                    className="mt-2 text-xs text-brand-500 hover:underline">View attached quote →</button>
                )}
              </>
            ) : latestQuote ? (
              <>
                <InfoRow label="Quote #" value={latestQuote.quoteNumber ?? latestQuote.id.slice(-6)} />
                <InfoRow label="Value" value={fmtVal(latestQuote.totalAmount)} />
                <InfoRow label="Status" value={
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                    {latestQuote.status ?? 'Draft'}
                  </span>
                } />
                <InfoRow label="Date" value={formatISTDate(latestQuote.createdAt)} />
                <button onClick={() => handleTabChange('quotes')}
                  className="mt-2 text-xs text-brand-500 hover:underline">View full quote →</button>
              </>
            ) : (
              <p className="text-xs text-gray-400 py-2">No quote yet</p>
            )}
          </SidebarCard>

          {/* Follow-up */}
          <SidebarCard title="Follow-up">
            {lead ? (
              lead._count.followUpTasks > 0 ? (
                  <button
                    type="button"
                    onClick={() => {
                      handleTabChange('activity');
                      window.setTimeout(() => {
                        document.getElementById('lead-activity-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }, 0);
                    }}
                  className="text-xs text-brand-500 hover:underline">
                  {lead._count.followUpTasks} follow-up{lead._count.followUpTasks !== 1 ? 's' : ''} scheduled →
                </button>
              ) : (
                <p className="text-xs text-gray-400">No follow-up scheduled</p>
              )
            ) : <div className="h-6 bg-gray-50 rounded animate-pulse" />}
          </SidebarCard>
        </div>
      </div>

      {mailSentNotice && (
        <div className="fixed bottom-4 right-4 bg-green-600 text-white text-sm px-4 py-2.5 rounded-lg shadow-lg z-50">
          {mailSentNotice}
        </div>
      )}

      {pendingMail && (
        <EmailPreviewModal
          title="Review Client Email"
          defaultSubject={pendingMail.subject}
          defaultHtml={pendingMail.html}
          recipientLabel={pendingMail.to}
          sending={sendingMail}
          onSend={handleSendPendingMail}
          onClose={() => setPendingMail(null)}
        />
      )}
    </div>
  );
}
