import { useState, useEffect, useRef, useCallback } from 'react';
import { Check, Mail, AlertCircle, Send } from 'lucide-react';
import { api } from '../lib/api';
import toast from 'react-hot-toast';
import EmailPreviewModal from './EmailPreviewModal';
import { CustomChecklistItems, itemLabel, useChecklistStatus } from './ChecklistExtras';
import { DateInput } from './ui/DateTimeInputs';

interface OBOBMChecklist {
  id: string;
  leadId: string;
  siteDocumentationAt: string | null;
  initialSiteDiscussionAt: string | null;
  layoutFinalisationAt: string | null;
  designDiscussionAt: string | null;
  preSignOffAt: string | null;
  maskingAt: string | null;
  signOffAt: string | null;
  tentativeInteriorHandoverAt: string | null;
  npsTriggered: boolean;
  npsTriggeredAt: string | null;
  obmMailSent: boolean;
  obmMailSentAt: string | null;
  clientConfirmed: boolean;
  completedAt: string | null;
  [key: string]: any; // dexMaterialDone, dexMaterialConfirmed, etc.
}

interface Props {
  leadId: string;
  stage: string;
  clientEmail: string | null;
  onComplete?: () => void;
  isLocked?: boolean;
  /** Fix 1: incremented by LeadDetail whenever loadLead completes, forcing a re-fetch */
  refreshKey?: number;
}

const VISIBLE_STAGES = new Set(['ONBOARDING', 'ONBOARDING_MEETING', 'DESIGN_IN_PROGRESS', 'HANDED_OVER']);

const TIMELINE_FIELDS: { key: string; label: string }[] = [
  { key: 'siteDocumentationAt', label: 'Site documentation' },
  { key: 'initialSiteDiscussionAt', label: 'Initial site discussion' },
  { key: 'layoutFinalisationAt', label: 'Layout finalisation' },
  { key: 'designDiscussionAt', label: 'Design discussion' },
  { key: 'preSignOffAt', label: 'Pre sign-off' },
  { key: 'maskingAt', label: 'Masking' },
  { key: 'signOffAt', label: 'Sign off' },
  { key: 'tentativeInteriorHandoverAt', label: 'Tentative interior handover date' },
];

function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}

// Small inline indicator so a field mid-save (or just saved) is visually
// distinguishable from a genuinely disabled/locked one — the ambiguity here
// was the root cause of testers mistaking in-flight saves for a stuck form.
function FieldStatus({ saving, saved }: { saving: boolean; saved: boolean }) {
  if (saving) return <span className="text-[10px] font-normal text-gray-400 animate-pulse">saving…</span>;
  if (saved) return <span className="text-[10px] font-normal text-green-600">saved</span>;
  return null;
}

export default function OBOBMChecklistPanel({ leadId, stage, clientEmail, onComplete, isLocked, refreshKey }: Props) {
  const [checklist, setChecklist] = useState<OBOBMChecklist | null>(null);
  const statusPath = `/leads/${leadId}/ob-obm-checklist`;
  const { status, reload: reloadStatus } = useChecklistStatus(statusPath, [stage, refreshKey, checklist]);
  const [docItems, setDocItems] = useState<{ key: string; label: string }[]>([]);
  const [template, setTemplate] = useState<{ subject: string; html: string; attachmentNames?: string[] }>({ subject: '', html: '' });
  const [loading, setLoading] = useState(true);
  // Task #168 — per-field saving/saved state, not a single form-wide flag.
  // Previously one shared `saving` boolean disabled EVERY field in the panel
  // while any single field was mid-save, which is what made a form with ~14
  // fields feel broken/stuck when filled in quickly. Now only the field(s)
  // actually in flight are disabled; everything else stays interactive.
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [triggeringNps, setTriggeringNps] = useState(false);
  const [sending, setSending] = useState(false);
  const [showMailModal, setShowMailModal] = useState(false);
  // Fix A — explicit "send externally?" checkbox for the OB→OBM welcome email.
  const [obmNotifyClient, setObmNotifyClient] = useState(true);
  const [dates, setDates] = useState<Record<string, string>>({});
  // Batch 12c Round 3b — manually-triggered onboarding NPS survey is drafted,
  // not auto-sent; reuses the same review-and-send modal as the OBM mail.
  const [npsPendingMail, setNpsPendingMail] = useState<{ draftKey: string; to: string; subject: string; html: string } | null>(null);
  const [sendingNps, setSendingNps] = useState(false);

  // Edits are sent immediately (no artificial delay), and any further edits
  // made while a PATCH is already in flight are merged into the very next
  // request instead of each firing their own round-trip. This gives the same
  // "one request for a burst of clicks" benefit as a debounce, without ever
  // leaving an edit sitting unsent in a timer window — the first edit in a
  // burst starts its network request synchronously, so it survives even a
  // near-instant navigation away from the page.
  const pendingRef = useRef<Record<string, any>>({});
  const inFlightRef = useRef(false);
  // Previous value for each key currently queued/in-flight, so a failed save
  // can be rolled back instead of leaving the optimistic (wrong) value in
  // place — otherwise the "missing requirements" list could look satisfied
  // when the server actually rejected the change.
  const revertRef = useRef<Record<string, any>>({});
  const savedTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const mountedRef = useRef(true);

  const isEditable = stage === 'ONBOARDING' && !isLocked;

  const load = async () => {
    try {
      const data = await api.get<{
        checklist: OBOBMChecklist | null;
        docItems: { key: string; label: string }[];
        obmMailTemplate: { subject: string; html: string };
      }>(`/leads/${leadId}/ob-obm-checklist`);
      setChecklist(data.checklist);
      setDocItems(data.docItems);
      setTemplate(data.obmMailTemplate);
      if (data.checklist) {
        const d: Record<string, string> = {};
        for (const f of TIMELINE_FIELDS) d[f.key] = toDateInputValue(data.checklist[f.key]);
        setDates(d);
      }
    } catch (e: any) {
      console.warn('[OB-OBM] load error:', e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (VISIBLE_STAGES.has(stage)) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId, stage, refreshKey]);

  const markSaved = (keys: string[]) => {
    setSavedKeys((prev) => new Set([...prev, ...keys]));
    for (const key of keys) {
      if (savedTimersRef.current[key]) clearTimeout(savedTimersRef.current[key]);
      savedTimersRef.current[key] = setTimeout(() => {
        setSavedKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }, 1500);
    }
  };

  // Reverts the optimistic local value for `key` back to what it was before
  // this batch was queued — used when the server rejects a save, so a failed
  // checkbox doesn't sit there looking checked/satisfied.
  const revertField = (key: string) => {
    if (!(key in revertRef.current)) return;
    const prev = revertRef.current[key];
    if (TIMELINE_FIELDS.some((f) => f.key === key)) {
      setDates((d) => ({ ...d, [key]: prev ?? '' }));
    } else {
      setChecklist((c) => (c ? { ...c, [key]: prev } : c));
    }
  };

  // Drains `pendingRef` by sending it as a PATCH, then — if more edits were
  // queued while that request was in flight — immediately sends those too.
  // This loop is intentionally NOT gated on `mountedRef`: the network writes
  // must complete and persist even if the panel unmounts mid-request (e.g.
  // the user navigated away right after clicking); only the resulting state
  // updates are skipped post-unmount.
  const drainQueue = useCallback(async () => {
    if (inFlightRef.current) return;
    const payload = pendingRef.current;
    const keys = Object.keys(payload);
    if (!keys.length) return;
    pendingRef.current = {};
    inFlightRef.current = true;
    try {
      const data = await api.patch<{ checklist: OBOBMChecklist }>(`/leads/${leadId}/ob-obm-checklist`, payload);
      if (mountedRef.current) {
        // Only apply the response's value for a key if it hasn't been
        // re-edited since this request was sent — otherwise an in-flight
        // response for an earlier value could stomp a newer optimistic edit
        // that's already queued for the next request.
        setChecklist((c) => {
          if (!c) return data.checklist;
          const merged = { ...c };
          for (const k of keys) {
            if (!(k in pendingRef.current) && !TIMELINE_FIELDS.some((f) => f.key === k)) merged[k] = data.checklist[k];
          }
          return merged;
        });
        for (const f of TIMELINE_FIELDS) {
          if (f.key in payload && !(f.key in pendingRef.current)) {
            setDates((d) => ({ ...d, [f.key]: toDateInputValue(data.checklist[f.key]) }));
          }
        }
        markSaved(keys.filter((k) => !(k in pendingRef.current)));
        onComplete?.();
      }
    } catch (e: any) {
      if (mountedRef.current) {
        toast.error(e.message);
        // Same re-edit guard on failure: don't revert a field the user has
        // already changed again while this request was failing.
        for (const k of keys) if (!(k in pendingRef.current)) revertField(k);
      }
    } finally {
      for (const k of keys) if (!(k in pendingRef.current)) delete revertRef.current[k];
      if (mountedRef.current) {
        setSavingKeys((prev) => {
          const next = new Set(prev);
          for (const k of keys) if (!(k in pendingRef.current)) next.delete(k);
          return next;
        });
      }
      inFlightRef.current = false;
      // More edits may have queued up while this request was in flight —
      // send them right away rather than waiting for the next user action.
      if (Object.keys(pendingRef.current).length) drainQueue();
    }
  }, [leadId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Queues a field change locally, shows it as "saving", and kicks off the
  // send immediately (or merges into the in-flight request if one is
  // already running) — so ticking several checkboxes back-to-back still
  // collapses into as few requests as possible, with no unsaved edit ever
  // sitting idle in a timer.
  const queueUpdate = (key: string, value: any, previousValue: any) => {
    if (!(key in revertRef.current)) revertRef.current[key] = previousValue;
    pendingRef.current[key] = value;
    setSavingKeys((prev) => new Set(prev).add(key));
    setSavedKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    drainQueue();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const t of Object.values(savedTimersRef.current)) clearTimeout(t);
    };
  }, []);

  const saveDate = (key: string, value: string) => {
    const previous = dates[key] ?? '';
    setDates((d) => ({ ...d, [key]: value }));
    queueUpdate(key, value || null, previous);
  };

  const toggleDoc = (key: string, value: boolean) => {
    // Reflected in `checklist` immediately for a responsive checkbox; the
    // authoritative value comes back from the PATCH response, and is rolled
    // back automatically if the server rejects it.
    const previous = checklist ? checklist[key] : undefined;
    setChecklist((c) => (c ? { ...c, [key]: value } : c));
    queueUpdate(key, value, previous);
  };

  const triggerNps = async () => {
    setTriggeringNps(true);
    try {
      const result = await api.post<{ npsState?: string; pendingMail?: { draftKey: string; type: string; to: string; subject: string; html: string } }>(
        `/leads/${leadId}/nps-trigger`,
        { stage: 'ONBOARDING' },
      );
      await load();
      // Batch 12c Round 3b — the survey is now drafted, not auto-sent; open
      // the review-and-send modal instead of declaring it done immediately.
      if (result.pendingMail) {
        setNpsPendingMail({ draftKey: result.pendingMail.draftKey, to: result.pendingMail.to, subject: result.pendingMail.subject, html: result.pendingMail.html });
      } else {
        toast.success(result.npsState === 'RESPONDED' ? 'Customer feedback already received' : 'NPS email already sent for this lead');
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setTriggeringNps(false);
    }
  };

  const sendNpsMail = async (subject: string, html: string) => {
    if (!npsPendingMail) return;
    setSendingNps(true);
    try {
      await api.post('/email/send-draft', { draftKey: npsPendingMail.draftKey, to: npsPendingMail.to, subject, html });
      toast.success('NPS survey sent');
      setNpsPendingMail(null);
      await load();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSendingNps(false);
    }
  };

  // Batch 12c: two-step send against the real persisted-draft infra — step 1
  // creates/updates the draft (no send yet), step 2 actually delivers it.
  // Only step 2 triggers the checklist completion + stage-advance to
  // Onboarding Meeting, so nothing advances until the mail is truly sent.
  const sendObmMail = async (subject: string, html: string) => {
    setSending(true);
    try {
      const draftResult = await api.post<{ pendingMail: { draftKey: string; to: string; subject: string; html: string } }>(
        `/leads/${leadId}/ob-obm-checklist/send-obm-mail`,
        { subject, html },
      );
      await api.post('/email/send-draft', { draftKey: draftResult.pendingMail.draftKey, to: draftResult.pendingMail.to });
      toast.success('OBM mail sent — lead moved to Onboarding Meeting');
      setShowMailModal(false);
      await load();
      onComplete?.();
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setSending(false);
    }
  };

  if (!VISIBLE_STAGES.has(stage)) return null;

  if (loading) {
    return (
      <div className="bg-white border border-gray-200 rounded-xl p-5 animate-pulse">
        <div className="h-4 bg-gray-100 rounded w-40 mb-3" />
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => <div key={i} className="h-8 bg-gray-100 rounded" />)}
        </div>
      </div>
    );
  }

  if (!checklist) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
        OB→OBM checklist not yet created. It will appear once the lead enters Onboarding stage.
      </div>
    );
  }

  const isComplete = !!checklist.completedAt;
  // What's missing comes from the server (Admin → Checklists can make items
  // optional or add new ones), so this always matches what sending will accept.
  const optionalKeys = new Set(status?.items.filter((i) => !i.required).map((i) => i.key) ?? []);
  const missing = [...(status?.missing ?? []), ...(!clientEmail ? ["Client's email"] : [])];
  const blockingMissing = [...(status?.blocking ?? status?.missing ?? []), ...(!clientEmail ? ["Client's email"] : [])];
  const lenient = !!status?.lenient;
  const optionalTag = (key: string) => (optionalKeys.has(key) ? <span className="text-[10px] text-gray-400">(optional)</span> : null);

  return (
    <div className={`border rounded-xl p-5 ${isComplete ? 'bg-green-50 border-green-200' : 'bg-white border-gray-200'}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-gray-900 text-sm">OB → OBM Checklist</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {isComplete ? 'OBM mail sent — lead moved to Onboarding Meeting' : 'Complete before moving to Onboarding Meeting'}
          </p>
        </div>
        {isComplete && (
          <span className="inline-flex items-center gap-1 text-xs font-medium bg-green-100 text-green-700 px-2.5 py-1 rounded-full">
            <Check size={11} strokeWidth={2.5} /> Done
          </span>
        )}
      </div>

      {/* Timeline dates */}
      <div className="mb-4">
        <p className="text-xs font-medium text-gray-600 mb-2">Design phase timeline</p>
        <div className="grid grid-cols-2 gap-2">
          {TIMELINE_FIELDS.map((f) => (
            <div key={f.key}>
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 mb-0.5">
                {itemLabel(status, f.key, f.label)} {optionalTag(f.key)}
                <FieldStatus saving={savingKeys.has(f.key)} saved={savedKeys.has(f.key)} />
              </label>
              <DateInput
                disabled={!isEditable || savingKeys.has(f.key)}
                value={dates[f.key] ?? ''}
                onChange={(v) => saveDate(f.key, v)}
                className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand-400 disabled:bg-gray-50"
              />
            </div>
          ))}
        </div>
      </div>

      {/* Welcome document items */}
      <div className="mb-4">
        <p className="text-xs font-medium text-gray-600 mb-2">Welcome documents</p>
        <div className="space-y-1.5">
          {docItems.map((item) => {
            const done = !!checklist[`${item.key}Done`];
            const confirmed = !!checklist[`${item.key}Confirmed`];
            return (
              <div key={item.key} className={`flex items-center gap-3 px-3 py-2 rounded-lg ${done ? 'bg-green-50' : 'bg-gray-50'}`}>
                <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={!isEditable || savingKeys.has(`${item.key}Done`)}
                    onChange={(e) => toggleDoc(`${item.key}Done`, e.target.checked)}
                    className="w-4 h-4 accent-brand-500 shrink-0"
                  />
                  <span className={`text-xs ${done ? 'text-green-700' : 'text-gray-700'} truncate`}>{itemLabel(status, item.key, item.label)} {optionalTag(item.key)}</span>
                  <FieldStatus saving={savingKeys.has(`${item.key}Done`)} saved={savedKeys.has(`${item.key}Done`)} />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-gray-400 shrink-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={!isEditable || savingKeys.has(`${item.key}Confirmed`)}
                    onChange={(e) => toggleDoc(`${item.key}Confirmed`, e.target.checked)}
                    className="w-3.5 h-3.5 accent-gray-500"
                  />
                  Client confirmed
                  <FieldStatus saving={savingKeys.has(`${item.key}Confirmed`)} saved={savedKeys.has(`${item.key}Confirmed`)} />
                </label>
              </div>
            );
          })}
        </div>
      </div>

      {/* NPS trigger */}
      <div className="flex items-center justify-between mb-4 px-3 py-2 rounded-lg bg-gray-50">
        <span className="text-xs text-gray-700">
          {checklist.npsTriggered ? '✓ NPS email sent or customer feedback received' : 'NPS email not yet sent'}
        </span>
        {isEditable && !checklist.npsTriggered && (
          <button
            onClick={triggerNps}
            disabled={triggeringNps}
            className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 disabled:opacity-50"
          >
            <Send size={11} strokeWidth={2.5} /> {triggeringNps ? 'Preparing…' : 'Prepare NPS email'}
          </button>
        )}
      </div>

      {/* Client confirmation — required before the OBM mail can be sent */}
      <div className="flex items-center justify-between mb-4 px-3 py-2 rounded-lg bg-gray-50">
        <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer">
          <input
            type="checkbox"
            checked={!!checklist.clientConfirmed}
            disabled={!isEditable || savingKeys.has('clientConfirmed')}
            onChange={(e) => toggleDoc('clientConfirmed', e.target.checked)}
            className="w-3.5 h-3.5 accent-gray-500"
          />
          {itemLabel(status, 'clientConfirmed', 'Client confirmed')} {optionalTag('clientConfirmed')}
          <FieldStatus saving={savingKeys.has('clientConfirmed')} saved={savedKeys.has('clientConfirmed')} />
        </label>
      </div>

      {/* Fix A — "send externally?" checkbox for the OB→OBM welcome email */}
      {isEditable && (
        <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
          <input
            type="checkbox"
            disabled={savingKeys.size > 0}
            checked={obmNotifyClient}
            onChange={(e) => setObmNotifyClient(e.target.checked)}
            className="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
          />
          Send OB→OBM welcome email to client
        </label>
      )}

      {isEditable && (
        <button
          onClick={() => setShowMailModal(true)}
          disabled={savingKeys.size > 0 || blockingMissing.length > 0 || !obmNotifyClient}
          title={
            !obmNotifyClient
              ? 'Enable "Send OB→OBM welcome email to client" above to share the OBM mail'
              : blockingMissing.length > 0
              ? `Missing: ${blockingMissing.join(', ')}`
              : savingKeys.size > 0
              ? 'Waiting for pending changes to save…'
              : undefined
          }
          className="w-full flex items-center justify-center gap-1.5 bg-brand-500 text-white py-2 rounded-lg text-sm font-medium hover:bg-brand-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Mail size={13} strokeWidth={2.5} /> Share OBM mail
        </button>
      )}

      <CustomChecklistItems basePath={statusPath} status={status} disabled={!isEditable} onSaved={reloadStatus} />

      {isEditable && missing.length > 0 && (
        <div className="mt-3 flex items-start gap-1.5 text-xs text-amber-600">
          <AlertCircle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
          <span>{lenient ? 'Not yet filled (you can still send; this will be recorded)' : 'Before sending'}: {missing.join(', ')}</span>
        </div>
      )}

      {showMailModal && (
        <EmailPreviewModal
          title="Share OBM mail"
          defaultSubject={template.subject}
          defaultHtml={template.html}
          attachmentNames={template.attachmentNames ?? []}
          recipientLabel={clientEmail ?? '(no email on file)'}
          sending={sending}
          onSend={sendObmMail}
          onClose={() => setShowMailModal(false)}
        />
      )}

      {npsPendingMail && (
        <EmailPreviewModal
          title="Review NPS Survey Email"
          defaultSubject={npsPendingMail.subject}
          defaultHtml={npsPendingMail.html}
          recipientLabel={npsPendingMail.to}
          sending={sendingNps}
          onSend={sendNpsMail}
          onClose={() => setNpsPendingMail(null)}
        />
      )}
    </div>
  );
}
